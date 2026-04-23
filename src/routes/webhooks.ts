import { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { bridgeLegs, hangupCall, decodeClientState } from '../lib/telnyx.js';
import Telnyx from 'telnyx';
import crypto from 'crypto';
import { redis } from '../lib/redis.js';

const telnyx = new (Telnyx as any)({ apiKey: process.env.TELNYX_API_KEY });
const POST_RELEASE_COOLDOWN_MS = 2000;

async function setAgentCooldown(agentId: string, ms = POST_RELEASE_COOLDOWN_MS) {
  await redis.set(`dialer:agent:${agentId}:locked`, '1', 'PX', ms);
}

// ── Telnyx signature verification ─────────────────────────
function verifyTelnyxSignature(
  payload: string,
  signature: string,
  timestamp: string,
  publicKey: string
): boolean {
  try {
    const message = `${timestamp}|${payload}`;
    const keyBuffer = Buffer.from(publicKey, 'base64');
    // Ed25519 verify
    return crypto.verify(
      null,
      Buffer.from(message),
      { key: keyBuffer, format: 'der', type: 'spki' },
      Buffer.from(signature, 'base64')
    );
  } catch {
    return false;
  }
}

export async function telnyxWebhookRoutes(app: FastifyInstance) {

  // POST /webhooks/telnyx
  app.post('/telnyx', {
    config: { rawBody: true },
  }, async (req: any, reply) => {

    // Signature verification (non-blocking for now — enable after testing)
    // const sig = req.headers['telnyx-signature-ed25519'] as string;
    // const ts = req.headers['telnyx-timestamp'] as string;
    // if (!verifyTelnyxSignature(req.rawBody, sig, ts, process.env.TELNYX_PUBLIC_KEY!)) {
    //   return reply.status(401).send({ error: 'Invalid signature' });
    // }

    const event = req.body?.data;
    if (!event) return reply.send({ received: true });

    const eventType: string = event.event_type;
    const payload = event.payload ?? {};
    const callControlId: string = payload.call_control_id;
    const clientStateRaw: string = payload.client_state;

    app.log.info(`[WEBHOOK] ${eventType} | ccid: ${callControlId}`);

    let clientState: Record<string, any> = {};
    if (clientStateRaw) {
      clientState = decodeClientState(clientStateRaw);
    }

    await supabase.from('audit_events').insert({
      entity_type: 'telnyx_event',
      entity_id: null,
      event_type: eventType,
      payload: { call_control_id: callControlId, client_state: clientState, raw: payload },
    });

    switch (eventType) {

      // ── AGENT LEG ANSWERED ────────────────────────────────
      case 'call.answered': {
        const legType = clientState.leg_type;

        if (legType === 'agent') {
          const agentId = clientState.agent_id;
          const callId = clientState.call_id;
          const leadId = clientState.lead_id;

          // Store agent leg ID on session
          await supabase
            .from('agent_sessions')
            .update({
              active_call_id: callId,
              updated_at: new Date().toISOString(),
            })
            .eq('agent_id', agentId);

          // Store agent leg control id on call, status=agent_answered
          await supabase
            .from('calls')
            .update({
              agent_leg_id: callControlId,
              status: 'agent_answered',
            })
            .eq('id', callId);

          app.log.info(`[WEBHOOK] Agent leg answered | agent: ${agentId} | now dialing lead`);

          try {
            await telnyx.calls.actions.speak(callControlId, {
              payload: 'Connecting you to a lead now. Please stand by.',
              voice: 'female',
              language: 'en-US',
            });
          } catch(e) { app.log.warn('[WEBHOOK] Agent speak failed: ' + e); }

          // NOW dial the lead leg
          if (callId && agentId && leadId) {
            await dialLeadLeg(app, { callId, agentId, leadId, agentCallControlId: callControlId });
          } else {
            app.log.error(`[WEBHOOK] Missing ids for lead dial | call:${callId} agent:${agentId} lead:${leadId}`);
          }
        }

        if (legType === 'lead') {
          // Lead answered — wait for AMD result before bridging
          app.log.info(`[WEBHOOK] Lead leg answered — awaiting AMD`);
          const callId = clientState.call_id;
          if (callId) {
            await supabase
              .from('calls')
              .update({ status: 'lead_answered', lead_leg_id: callControlId })
              .eq('id', callId);
          }
        }
        break;
      }

      // ── AMD RESULT ────────────────────────────────────────
      case 'call.machine.detection.ended':
      case 'call.machine.premium.detection.ended': {
        const result: string = payload.result; // 'human' | 'machine' | 'unknown'
        const callId = clientState.call_id;
        const agentId = clientState.agent_id;

        app.log.info(`[WEBHOOK] AMD result: ${result} | call: ${callId}`);

        if (!callId || !agentId) break;

        const isHuman = result === 'human' || result === 'not_sure';

        if (isHuman) {
          // Fetch agent leg control id to bridge against
          const { data: call } = await supabase
            .from('calls')
            .select('agent_leg_id, lead_leg_id, lead_id')
            .eq('id', callId)
            .single();

          const leadLegId = callControlId || call?.lead_leg_id;
          const agentLegId = call?.agent_leg_id;

          if (!agentLegId || !leadLegId) {
            app.log.error(`[WEBHOOK] Missing leg ids for bridge | agent:${agentLegId} lead:${leadLegId}`);
            await hangupCall(leadLegId);
            await releaseAgent(agentId, callId);
            await setAgentCooldown(agentId);
            break;
          }

          try {
            await bridgeLegs(leadLegId, agentLegId);

            await supabase
              .from('calls')
              .update({
                agent_leg_id: agentLegId,
                lead_leg_id: leadLegId,
                status: 'bridged',
                answered_at: new Date().toISOString(),
              })
              .eq('id', callId);

            if (call?.lead_id) {
              await supabase
                .from('leads')
                .update({ status: 'answered' })
                .eq('id', call.lead_id);
            }

            await supabase
              .from('agent_sessions')
              .update({ state: 'IN_CALL', updated_at: new Date().toISOString() })
              .eq('agent_id', agentId);

            app.log.info(`[WEBHOOK] Bridged! agent: ${agentId} | call: ${callId}`);
          } catch (err) {
            app.log.error(`[WEBHOOK] Bridge failed: ${err}`);
            await hangupCall(leadLegId);
            await releaseAgent(agentId, callId);
            await setAgentCooldown(agentId);
          }
        } else {
          // Machine/unknown detected — hang up lead leg, release agent
          app.log.info(`[WEBHOOK] Lead skipped — voicemail/no-answer, agent returning to READY`);
          await hangupCall(callControlId);

          const { data: call } = await supabase
            .from('calls')
            .select('lead_id, agent_leg_id')
            .eq('id', callId)
            .single();

          if (call?.lead_id) {
            await supabase
              .from('leads')
              .update({ status: 'voicemail', assigned_agent_id: null })
              .eq('id', call.lead_id);
          }

          // Hang up the agent leg too so the agent's browser call clears
          if (call?.agent_leg_id) {
            await hangupCall(call.agent_leg_id);
          }

          await supabase
            .from('calls')
            .update({ status: 'voicemail', ended_at: new Date().toISOString() })
            .eq('id', callId);

          await releaseAgent(agentId, callId);
          await setAgentCooldown(agentId);
        }
        break;
      }

      // ── CALL HANGUP ───────────────────────────────────────
      case 'call.hangup': {
        const callId = clientState.call_id;
        const agentId = clientState.agent_id;
        const legType = clientState.leg_type;

        if (!callId) break;

        const { data: call } = await supabase
          .from('calls')
          .select('status, started_at, agent_id')
          .eq('id', callId)
          .single();

        if (!call) break;

        // Calculate duration if call was bridged
        const duration = call.started_at
          ? Math.floor((Date.now() - new Date(call.started_at).getTime()) / 1000)
          : null;

        if (call.status === 'bridged' || call.status === 'IN_CALL') {
          // Real call ended — move agent to WRAP_UP
          await supabase
            .from('calls')
            .update({
              status: 'completed',
              ended_at: new Date().toISOString(),
              duration_seconds: duration,
            })
            .eq('id', callId);

          const resolvedAgentId = agentId ?? call.agent_id;
          if (resolvedAgentId) {
            await supabase
              .from('agent_sessions')
              .update({
                state: 'WRAP_UP',
                updated_at: new Date().toISOString(),
              })
              .eq('agent_id', resolvedAgentId);
          }

          app.log.info(`[WEBHOOK] Call ended → WRAP_UP | agent: ${resolvedAgentId}`);
        } else if (legType === 'agent') {
          // Agent leg hung up before lead answered/bridged — abort this call.
          // This happens when the agent's WebRTC registration is stale (SIP
          // endpoint not reachable) or the agent hangs up before the lead
          // picks up. Release the agent back to READY with a short cooldown
          // so the ticker doesn't instantly re-queue them in a tight loop.
          app.log.info(`[WEBHOOK] Agent leg hung up pre-bridge — aborting call ${callId}`);

          // Hang up lead leg if it exists
          const { data: legs } = await supabase
            .from('calls')
            .select('lead_leg_id, lead_id')
            .eq('id', callId)
            .single();
          if (legs?.lead_leg_id) await hangupCall(legs.lead_leg_id);
          if (legs?.lead_id) {
            await supabase
              .from('leads')
              .update({ status: 'pending', assigned_agent_id: null })
              .eq('id', legs.lead_id);
          }

          await supabase
            .from('calls')
            .update({ status: 'aborted', ended_at: new Date().toISOString() })
            .eq('id', callId);

          const resolvedAgentId = agentId ?? call.agent_id;
          if (resolvedAgentId) {
            await releaseAgent(resolvedAgentId, callId);
            // Longer cooldown on agent-pre-bridge hangup to avoid tight loops
            // when the SIP endpoint is not actually reachable.
            await setAgentCooldown(resolvedAgentId, 5000);
          }
        } else if (legType === 'lead' && call.status !== 'bridged') {
          // Lead hung up before bridge — no_answer or busy
          app.log.info(`[WEBHOOK] Lead skipped — no-answer/busy, agent returning to READY`);
          await supabase
            .from('calls')
            .update({
              status: 'no_answer',
              ended_at: new Date().toISOString(),
            })
            .eq('id', callId);

          // Hang up agent leg so agent's browser call clears
          const { data: legs } = await supabase
            .from('calls')
            .select('agent_leg_id, lead_id')
            .eq('id', callId)
            .single();
          if (legs?.agent_leg_id) await hangupCall(legs.agent_leg_id);
          if (legs?.lead_id) {
            await supabase
              .from('leads')
              .update({ status: 'no_answer', assigned_agent_id: null })
              .eq('id', legs.lead_id);
          }

          const resolvedAgentId = agentId ?? call.agent_id;
          if (resolvedAgentId) {
            await releaseAgent(resolvedAgentId, callId);
            await setAgentCooldown(resolvedAgentId);
          }
        }
        break;
      }

      // ── NO ANSWER / TIMEOUT ───────────────────────────────
      case 'call.initiated': {
        // Just log for now
        app.log.info(`[WEBHOOK] Call initiated | ccid: ${callControlId}`);
        break;
      }

      default:
        app.log.info(`[WEBHOOK] Unhandled event: ${eventType}`);
    }

    return reply.send({ received: true });
  });
}

// Dial the lead leg after the agent leg answered
async function dialLeadLeg(
  app: FastifyInstance,
  params: {
    callId: string;
    agentId: string;
    leadId: string;
    agentCallControlId: string;
  }
) {
  const { data: lead } = await supabase
    .from('leads')
    .select('id, phone, attempts')
    .eq('id', params.leadId)
    .single();

  if (!lead?.phone) {
    app.log.error(`[WEBHOOK] Lead ${params.leadId} missing phone — cannot dial`);
    await hangupCall(params.agentCallControlId);
    await releaseAgent(params.agentId, params.callId);
    return;
  }

  try {
    const leadCallResponse = await telnyx.calls.dial({
      connection_id: process.env.TELNYX_CONNECTION_ID,
      to: lead.phone,
      from: process.env.TELNYX_OUTBOUND_NUMBER,
      webhook_url: process.env.TELNYX_WEBHOOK_URL,
      answering_machine_detection: 'premium',
      answering_machine_detection_config: {
        total_analysis_time_millis: 1500,
        after_greeting_silence_millis: 400,
        maximum_number_of_words: 3,
      },
      client_state: Buffer.from(JSON.stringify({
        leg_type: 'lead',
        call_id: params.callId,
        agent_id: params.agentId,
        lead_id: lead.id,
      })).toString('base64'),
    });

    const leadCallControlId = leadCallResponse.data.call_control_id;

    await supabase
      .from('calls')
      .update({
        lead_leg_id: leadCallControlId,
        call_control_id: leadCallControlId,
        status: 'lead_dialing',
      })
      .eq('id', params.callId);

    await supabase
      .from('leads')
      .update({
        status: 'dialing',
        attempts: (lead.attempts ?? 0) + 1,
        last_called_at: new Date().toISOString(),
      })
      .eq('id', lead.id);

    app.log.info(`[WEBHOOK] Dialing lead ${lead.phone} | call: ${params.callId}`);
  } catch (err: any) {
    app.log.error(`[WEBHOOK] Lead dial failed: ${err.message}`);
    await hangupCall(params.agentCallControlId);
    await supabase
      .from('leads')
      .update({ status: 'failed', assigned_agent_id: null })
      .eq('id', lead.id);
    await supabase
      .from('calls')
      .update({ status: 'failed', ended_at: new Date().toISOString() })
      .eq('id', params.callId);
    await releaseAgent(params.agentId, params.callId);
    await setAgentCooldown(params.agentId);
  }
}

// ── Release agent back to READY ───────────────────────────
async function releaseAgent(agentId: string, callId: string) {
  await supabase
    .from('agent_sessions')
    .update({
      state: 'READY',
      active_call_id: null,
      last_ready_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('agent_id', agentId);

  await supabase
    .from('calls')
    .update({ status: 'completed', ended_at: new Date().toISOString() })
    .eq('id', callId)
    .in('status', [
      'dialing',
      'agent_reserved',
      'agent_dialing',
      'agent_answered',
      'lead_dialing',
      'lead_answered',
      'no_answer',
      'voicemail',
      'failed',
    ]);
}
