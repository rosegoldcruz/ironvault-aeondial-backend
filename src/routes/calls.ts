import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { hangupCall } from '../lib/telnyx.js';

const wrapUpSchema = z.object({
  disposition: z.enum([
    'Interested',
    'Not Interested',
    'Callback',
    'Do Not Call',
    'No Answer',
    'Voicemail',
    'Wrong Number',
    'Other',
  ]),
  notes: z.string().optional(),
  callback_at: z.string().datetime().optional(),
});

export async function callRoutes(app: FastifyInstance) {

  // GET /calls/current — get agent's active call with lead info
  app.get('/current', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: call } = await supabase
      .from('calls')
      .select(`
        *,
        leads (
          id, first_name, last_name, phone, email,
          city, state, quality
        )
      `)
      .eq('agent_id', agentId)
      .in('status', [
        'created',
        'agent_dialing',
        'agent_answered',
        'lead_dialing',
        'lead_answered',
        'dialing',
        'agent_reserved',
        'bridged',
      ])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return reply.send({ call: call ?? null });
  });

  // POST /calls/:id/wrapup — submit disposition and notes
  app.post('/:id/wrapup', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;
    const { id: callId } = req.params as { id: string };

    const body = wrapUpSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid wrap-up data', details: body.error.flatten() });
    }

    const { disposition, notes, callback_at } = body.data;

    // Verify this call belongs to this agent
    const { data: call } = await supabase
      .from('calls')
      .select('id, lead_id, agent_id, status')
      .eq('id', callId)
      .eq('agent_id', agentId)
      .single();

    if (!call) {
      return reply.status(404).send({ error: 'Call not found' });
    }

    // Update call
    await supabase
      .from('calls')
      .update({
        disposition,
        notes: notes ?? null,
        status: 'completed',
        wrapped_at: new Date().toISOString(),
      })
      .eq('id', callId);

    // Update lead status
    let leadStatus = 'disposed';
    if (disposition === 'Do Not Call') leadStatus = 'dnc';
    else if (disposition === 'Callback') leadStatus = 'callback';
    else if (disposition === 'No Answer') leadStatus = 'no_answer';
    else if (disposition === 'Voicemail') leadStatus = 'voicemail';

    const leadUpdate: any = {
      status: leadStatus,
      assigned_agent_id: null,
    };

    if (disposition === 'Callback' && callback_at) {
      leadUpdate.callback_at = callback_at;
    }

    await supabase
      .from('leads')
      .update(leadUpdate)
      .eq('id', call.lead_id);

    // If DNC, make sure it never gets dialed again
    if (disposition === 'Do Not Call') {
      await supabase
        .from('leads')
        .update({ status: 'dnc', callback_at: null })
        .eq('id', call.lead_id);
    }

    // Schedule callback if needed
    if (disposition === 'Callback' && callback_at) {
      await supabase.from('callbacks').insert({
        call_id: callId,
        lead_id: call.lead_id,
        agent_id: agentId,
        scheduled_at: callback_at,
        notes: notes ?? null,
        status: 'pending',
      });
    }

    // Return agent to READY or keep PAUSED based on session
    const { data: session } = await supabase
      .from('agent_sessions')
      .select('state')
      .eq('agent_id', agentId)
      .single();

    // If agent is in WRAP_UP, set back to READY
    if (session?.state === 'WRAP_UP') {
      await supabase
        .from('agent_sessions')
        .update({
          state: 'READY',
          active_call_id: null,
          last_ready_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('agent_id', agentId);
    }

    await supabase.from('audit_events').insert({
      entity_type: 'call',
      entity_id: callId,
      event_type: 'CALL_WRAPPED_UP',
      payload: { disposition, notes, callback_at, agent_id: agentId },
    });

    return reply.send({ success: true, state: 'READY' });
  });

  // POST /calls/:id/hangup — end call via Telnyx (from END CALL button)
  app.post('/:id/hangup', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;
    const { id: callId } = req.params as { id: string };

    const { data: call } = await supabase
      .from('calls')
      .select('id, agent_leg_id, lead_leg_id, status, agent_id')
      .eq('id', callId)
      .eq('agent_id', agentId)
      .single();

    if (!call) {
      return reply.status(404).send({ error: 'Call not found' });
    }

    // Hang up both legs if they exist; ignore errors (already dead calls 404)
    const hangups: Promise<any>[] = [];
    if (call.lead_leg_id) hangups.push(hangupCall(call.lead_leg_id).catch(() => null));
    if (call.agent_leg_id) hangups.push(hangupCall(call.agent_leg_id).catch(() => null));
    await Promise.all(hangups);

    return reply.send({ success: true });
  });

  // GET /calls/history — recent calls for agent
  app.get('/history', { onRequest: [app.authenticate] } as any, async (req: any, reply) => {
    const { agentId } = req.user;

    const { data: calls } = await supabase
      .from('calls')
      .select(`
        id, status, disposition, notes, started_at, ended_at, duration_seconds,
        leads (first_name, last_name, phone, city, state)
      `)
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(50);

    return reply.send({ calls: calls ?? [] });
  });
}
