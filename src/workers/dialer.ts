import 'dotenv/config';
import { Worker, Queue, Job } from 'bullmq';
import { supabase } from '../lib/supabase.js';
import { redis } from '../lib/redis.js';
import Telnyx from 'telnyx';

const telnyx = new (Telnyx as any)({ apiKey: process.env.TELNYX_API_KEY });

const DIAL_QUEUE = 'dial-queue';
const TICK_INTERVAL_MS = 3000; // Check for READY agents every 3s
const DIALER_MODE = (process.env.DIALER_MODE ?? 'production').toLowerCase();
const TEST_PHONE_NUMBER = process.env.TEST_PHONE_NUMBER ?? '';
const POST_RELEASE_COOLDOWN_MS = 2000; // delay before agent becomes eligible again

function buildAgentDialTarget(sipUsername: string): string {
  // Agents register under the call control application's SIP subdomain.
  // For AEON DIAL the subdomain is 'aeondial', so endpoints live at
  // sip:user@aeondial.sip.telnyx.com. Using bare sip.telnyx.com returns
  // 403/user_busy because Telnyx can't find the registration.
  const fallbackDomain = process.env.AGENT_LEG_SIP_DOMAIN || 'aeondial.sip.telnyx.com';
  const normalizedUsername = sipUsername.trim().replace(/^sip:/, '').split('@')[0];
  return `sip:${normalizedUsername}@${fallbackDomain}`;
}

// ── Queues ────────────────────────────────────────────────
const dialQueue = new Queue(DIAL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

// ── Ticker: find READY agents and queue dial jobs ─────────
async function tick() {
  try {
    // Find all READY agents with no active call
    const { data: readySessions } = await supabase
      .from('agent_sessions')
      .select('id, agent_id')
      .eq('state', 'READY')
      .is('active_call_id', null);

    if (!readySessions || readySessions.length === 0) return;

    for (const session of readySessions) {
      // Check if there's already a queued job for this agent
      const lockKey = `dialer:agent:${session.agent_id}:locked`;
      const locked = await redis.get(lockKey);
      if (locked) continue;

      // Lock this agent for 30 seconds
      await redis.set(lockKey, '1', 'EX', 30);

      await dialQueue.add('dial-next', {
        agentId: session.agent_id,
        sessionId: session.id,
      });
    }
  } catch (err) {
    console.error('[TICKER] Error:', err);
  }
}

// ── Worker: process dial-next jobs ───────────────────────
const dialWorker = new Worker(
  DIAL_QUEUE,
  async (job: Job) => {
    const { agentId } = job.data;

    console.log(`[WORKER] Processing dial-next for agent: ${agentId}`);

    // 1. Re-verify agent is still READY (state may have changed)
    const { data: session } = await supabase
      .from('agent_sessions')
      .select('state, active_call_id, telnyx_client_state')
      .eq('agent_id', agentId)
      .single();

    if (!session || session.state !== 'READY' || session.active_call_id) {
      console.log(`[WORKER] Agent ${agentId} no longer READY — skipping`);
      await releaseLock(agentId);
      return;
    }

    // 2. Get agent info
    const { data: agent } = await supabase
      .from('agents')
      .select('id, telnyx_sip_username, telnyx_credential_id')
      .eq('id', agentId)
      .single();

    if (!agent?.telnyx_sip_username) {
      console.error(`[WORKER] Agent ${agentId} has no Telnyx SIP username`);
      await releaseLock(agentId);
      return;
    }

    // 3. Reserve agent
    await supabase
      .from('agent_sessions')
      .update({ state: 'RESERVED', updated_at: new Date().toISOString() })
      .eq('agent_id', agentId);

    // 4. Pick next lead from active campaigns
    let leadQuery = supabase
      .from('leads')
      .select('id, phone, first_name, last_name, campaign_id, attempts')
      .eq('status', 'pending')
      .is('assigned_agent_id', null)
      .or('callback_at.is.null,callback_at.lte.' + new Date().toISOString())
      .neq('status', 'dnc');

    // TEST MODE: only dial the test number
    if (DIALER_MODE !== 'production') {
      if (!TEST_PHONE_NUMBER) {
        console.warn(`[WORKER] DIALER_MODE=${DIALER_MODE} but TEST_PHONE_NUMBER not set — skipping`);
        await supabase
          .from('agent_sessions')
          .update({ state: 'READY', updated_at: new Date().toISOString() })
          .eq('agent_id', agentId);
        await releaseLock(agentId);
        return;
      }
      leadQuery = leadQuery.eq('phone', TEST_PHONE_NUMBER);
    }

    const { data: lead } = await leadQuery
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (!lead) {
      console.log(`[WORKER] No leads available — releasing agent ${agentId}`);
      await supabase
        .from('agent_sessions')
        .update({ state: 'READY', updated_at: new Date().toISOString() })
        .eq('agent_id', agentId);
      await releaseLock(agentId);
      return;
    }

    // 5. Reserve lead
    await supabase
      .from('leads')
      .update({ status: 'reserved', assigned_agent_id: agentId })
      .eq('id', lead.id);

    // 6. Create call record
    const { data: callRecord } = await supabase
      .from('calls')
      .insert({
        agent_id: agentId,
        lead_id: lead.id,
        campaign_id: lead.campaign_id,
        status: 'created',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (!callRecord) {
      console.error(`[WORKER] Failed to create call record`);
      await rollback(agentId, lead.id);
      return;
    }

    const callId = callRecord.id;
    const agentDialTarget = buildAgentDialTarget(agent.telnyx_sip_username);

    try {
      // 7. Dial ONLY the agent leg. The lead leg is dialed by the webhook handler
      //    when this agent leg is answered. This avoids ringing the lead before
      //    the agent is actually on the line.
      const agentCallResponse = await telnyx.calls.dial({
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: agentDialTarget,
        from: process.env.TELNYX_OUTBOUND_NUMBER,
        webhook_url: process.env.TELNYX_WEBHOOK_URL,
        client_state: Buffer.from(JSON.stringify({
          leg_type: 'agent',
          call_id: callId,
          agent_id: agentId,
          lead_id: lead.id,
        })).toString('base64'),
      });

      const agentCallControlId = agentCallResponse.data.call_control_id;

      // 8. Update call with agent leg, status=agent_dialing
      await supabase
        .from('calls')
        .update({
          agent_leg_id: agentCallControlId,
          status: 'agent_dialing',
        })
        .eq('id', callId);

      console.log(`[WORKER] Dialing agent ${agentDialTarget} | lead held: ${lead.phone} | call: ${callId}`);
    } catch (err: any) {
      console.error(`[WORKER] Agent dial failed: ${err.message}`);
      await rollback(agentId, lead.id);
      await supabase
        .from('calls')
        .update({ status: 'failed', ended_at: new Date().toISOString() })
        .eq('id', callId);
    } finally {
      await releaseLock(agentId);
    }
  },
  {
    connection: redis,
    concurrency: 10, // process 10 agents simultaneously
  }
);

// ── Helpers ───────────────────────────────────────────────
async function releaseLock(agentId: string) {
  await redis.del(`dialer:agent:${agentId}:locked`);
}

// Cooldown lock prevents the ticker from immediately re-queuing an agent
// right after a no-answer/voicemail release. Webhook handler sets this.
export async function setAgentCooldown(agentId: string, ms = POST_RELEASE_COOLDOWN_MS) {
  await redis.set(`dialer:agent:${agentId}:locked`, '1', 'PX', ms);
}

async function rollback(agentId: string, leadId: string) {
  await supabase
    .from('agent_sessions')
    .update({ state: 'READY', updated_at: new Date().toISOString() })
    .eq('agent_id', agentId);

  await supabase
    .from('leads')
    .update({ status: 'pending', assigned_agent_id: null })
    .eq('id', leadId);

  await releaseLock(agentId);
}

// ── Worker error handling ─────────────────────────────────
dialWorker.on('failed', (job, err) => {
  console.error(`[WORKER] Job failed: ${job?.id}`, err);
});

dialWorker.on('completed', (job) => {
  console.log(`[WORKER] Job completed: ${job.id}`);
});

// ── Start ticker ──────────────────────────────────────────
console.log('[DIALER] Worker started — ticking every 3s');
setInterval(tick, TICK_INTERVAL_MS);
tick(); // immediate first tick
