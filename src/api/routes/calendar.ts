/**
 * Calendar Routes
 * CRUD for calendar accounts, events, and availability queries.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import { GoogleCalendarConnector, eventToLocalRow } from '../../integrations/connectors/google-calendar-connector.js';
export function createCalendarRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  // ── Accounts ─────���───────────────────────────────────────────────

  router.get('/api/calendar/accounts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('calendar_accounts')
        .select('id, workspace_id, provider, label, enabled, last_synced_at, created_at, updated_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/calendar/accounts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { provider, label, credentials } = req.body;
      if (!label) { res.status(400).json({ error: 'label is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('calendar_accounts').insert({
        id, workspace_id: workspaceId,
        provider: provider || 'local',
        label,
        credentials: credentials ? JSON.stringify(credentials) : '{}',
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('calendar_accounts')
        .select('id, workspace_id, provider, label, enabled, created_at, updated_at')
        .eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Events ───────────────────────────────────────────────────────

  router.get('/api/calendar/events', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);

      let query = db.from('calendar_events').select('*').eq('workspace_id', workspaceId);
      if (req.query.start) query = query.gte('start_at', req.query.start as string);
      if (req.query.end) query = query.lte('end_at', req.query.end as string);
      if (req.query.account_id) query = query.eq('account_id', req.query.account_id as string);

      const { data, error } = await query
        .order('start_at', { ascending: true })
        .limit(limit);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/calendar/events', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { title, start_at, end_at, description, location, attendees, all_day, account_id, recurrence_rule, organizer_email, reminders } = req.body;
      if (!title || !start_at || !end_at) {
        res.status(400).json({ error: 'title, start_at, and end_at are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('calendar_events').insert({
        id, workspace_id: workspaceId, title,
        start_at, end_at,
        description: description || null,
        location: location || null,
        attendees: attendees ? JSON.stringify(attendees) : '[]',
        all_day: all_day ? 1 : 0,
        account_id: account_id || null,
        recurrence_rule: recurrence_rule || null,
        organizer_email: organizer_email || null,
        reminders: reminders ? JSON.stringify(reminders) : '[]',
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }
      const { data: created } = await db.from('calendar_events').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/calendar/events/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      if (updates.attendees && typeof updates.attendees !== 'string') updates.attendees = JSON.stringify(updates.attendees);
      if (updates.reminders && typeof updates.reminders !== 'string') updates.reminders = JSON.stringify(updates.reminders);
      if (updates.all_day !== undefined) updates.all_day = updates.all_day ? 1 : 0;

      const { error } = await db.from('calendar_events')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('calendar_events').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/calendar/events/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('calendar_events')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Availability ─────────────────────────────────────────────────

  router.get('/api/calendar/availability', async (req, res) => {
    try {
      const { workspaceId } = req;
      const start = req.query.start as string;
      const end = req.query.end as string;
      const durationMinutes = parseInt(req.query.duration_minutes as string || '30', 10);

      if (!start || !end) {
        res.status(400).json({ error: 'start and end are required' });
        return;
      }

      // Fetch all events in the range
      const { data: events } = await db.from('calendar_events')
        .select('start_at, end_at')
        .eq('workspace_id', workspaceId)
        .gte('end_at', start)
        .lte('start_at', end)
        .order('start_at', { ascending: true });

      const busy = (events || []).map(e => {
        const ev = e as { start_at: string; end_at: string };
        return { start: new Date(ev.start_at).getTime(), end: new Date(ev.end_at).getTime() };
      }).sort((a, b) => a.start - b.start);

      // Find free slots (business hours: 9am-5pm)
      const slots: Array<{ start: string; end: string }> = [];
      const rangeStart = new Date(start);
      const rangeEnd = new Date(end);
      const durationMs = durationMinutes * 60 * 1000;

      const current = new Date(rangeStart);
      while (current < rangeEnd && slots.length < 20) {
        // Move to 9am if before business hours
        if (current.getHours() < 9) current.setHours(9, 0, 0, 0);
        // Skip weekends
        if (current.getDay() === 0 || current.getDay() === 6) {
          current.setDate(current.getDate() + 1);
          current.setHours(9, 0, 0, 0);
          continue;
        }
        // Skip past 5pm
        if (current.getHours() >= 17) {
          current.setDate(current.getDate() + 1);
          current.setHours(9, 0, 0, 0);
          continue;
        }

        const slotEnd = new Date(current.getTime() + durationMs);
        // Check overlap with busy periods
        const conflict = busy.some(b =>
          current.getTime() < b.end && slotEnd.getTime() > b.start,
        );

        if (!conflict && slotEnd.getHours() <= 17) {
          slots.push({ start: current.toISOString(), end: slotEnd.toISOString() });
        }

        // Advance by 30 min
        current.setTime(current.getTime() + 30 * 60 * 1000);
      }

      res.json({ data: { free_slots: slots, busy_count: busy.length } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Google Calendar Sync ─────────────────────────────────────────

  router.post('/api/calendar/sync', async (req, res) => {
    try {
      const { workspaceId } = req;
      const results: Array<{ accountId: string; label: string; created: number; updated: number; errors: string[] }> = [];

      const { data: accounts } = await db.from('calendar_accounts')
        .select('id, label, provider, credentials, sync_cursor')
        .eq('workspace_id', workspaceId)
        .eq('enabled', 1)
        .eq('provider', 'google');

      for (const acct of (accounts || []) as Array<{ id: string; label: string; provider: string; credentials: string; sync_cursor: string | null }>) {
        let creds: { access_token?: string; calendar_id?: string };
        try { creds = JSON.parse(acct.credentials || '{}'); } catch { creds = {}; }
        if (!creds.access_token) { results.push({ accountId: acct.id, label: acct.label, created: 0, updated: 0, errors: ['No access token'] }); continue; }

        const connector = new GoogleCalendarConnector(creds as { access_token: string });
        const calendarId = creds.calendar_id || 'primary';

        let created = 0; let updated = 0; const errors: string[] = [];

        try {
          const syncToken = acct.sync_cursor || undefined;
          let syncResult;
          try {
            syncResult = await connector.syncEvents(calendarId, syncToken);
          } catch (err) {
            if ((err as { code?: string }).code === 'SYNC_TOKEN_EXPIRED') {
              logger.warn({ accountId: acct.id }, '[calendar] sync token expired, falling back to full sync');
              syncResult = await connector.syncEvents(calendarId, undefined);
            } else throw err;
          }

          for (const event of syncResult.events) {
            if (event.status === 'cancelled') {
              await db.from('calendar_events').delete().eq('account_id', acct.id).eq('external_id', event.id);
              continue;
            }
            const row = eventToLocalRow(event, workspaceId, acct.id);
            const { data: existing } = await db.from('calendar_events')
              .select('id').eq('account_id', acct.id).eq('external_id', event.id).maybeSingle();

            if (existing) {
              await db.from('calendar_events').update(row).eq('id', (existing as { id: string }).id);
              updated++;
            } else {
              const id = crypto.randomUUID();
              await db.from('calendar_events').insert({ id, ...row, created_at: new Date().toISOString() });
              created++;
            }
          }

          if (syncResult.nextSyncToken) {
            await db.from('calendar_accounts').update({
              sync_cursor: syncResult.nextSyncToken,
              last_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('id', acct.id);
          }

          results.push({ accountId: acct.id, label: acct.label, created, updated, errors });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Sync failed';
          logger.error({ err, accountId: acct.id }, '[calendar] sync error');
          results.push({ accountId: acct.id, label: acct.label, created, updated, errors: [msg] });
        }
      }

      res.json({ data: { results, synced_at: new Date().toISOString() } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Create Business Calendar ──────────────────────────────────────

  router.post('/api/calendar/accounts/create-business', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { business_id, access_token, time_zone } = req.body as { business_id?: string; access_token?: string; time_zone?: string };
      if (!business_id || !access_token) {
        res.status(400).json({ error: 'business_id and access_token are required' });
        return;
      }

      const businessNames: Record<string, string> = {
        ohwow: 'ohwow',
        avenued: 'AvenueD',
        dplaza: 'dPlaza',
        studentcenter: 'StudentCenter',
      };
      const calName = businessNames[business_id] || business_id;

      const connector = new GoogleCalendarConnector({ access_token });
      const cal = await connector.createCalendar(`${calName} — Business`, time_zone || 'America/Bogota');

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const credentials = JSON.stringify({ access_token, calendar_id: cal.id });
      await db.from('calendar_accounts').insert({
        id, workspace_id: workspaceId,
        provider: 'google',
        label: `${calName} Calendar`,
        credentials,
        business_id,
        calendar_type: 'created',
        created_at: now, updated_at: now,
      });

      logger.info({ accountId: id, calendarId: cal.id, businessId: business_id }, '[calendar] created business calendar account');
      res.status(201).json({ data: { account_id: id, calendar_id: cal.id, calendar_name: cal.summary, business_id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Calendar Analysis ─────────────────────────────────────────────

  router.get('/api/calendar/analysis', async (req, res) => {
    try {
      const { workspaceId } = req;
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);

      const { data: events } = await db.from('calendar_events')
        .select('title, start_at, end_at, account_id, status')
        .eq('workspace_id', workspaceId)
        .gte('start_at', weekStart.toISOString())
        .lte('end_at', weekEnd.toISOString())
        .neq('status', 'cancelled');

      const { data: accounts } = await db.from('calendar_accounts')
        .select('id, business_id, label')
        .eq('workspace_id', workspaceId);

      const accountMap = new Map<string, string>();
      for (const a of (accounts || []) as Array<{ id: string; business_id: string | null }>) {
        accountMap.set(a.id, a.business_id || 'personal');
      }

      type BusinessStats = { hours: number; meeting_count: number };
      const byBusiness: Record<string, BusinessStats> = {};
      let totalHours = 0;
      let meetingHours = 0;

      for (const ev of (events || []) as Array<{ title: string; start_at: string; end_at: string; account_id: string | null }>) {
        const start = new Date(ev.start_at);
        const end = new Date(ev.end_at);
        const hours = (end.getTime() - start.getTime()) / 3_600_000;
        const biz = ev.account_id ? (accountMap.get(ev.account_id) || 'personal') : 'personal';

        if (!byBusiness[biz]) byBusiness[biz] = { hours: 0, meeting_count: 0 };
        byBusiness[biz].hours += hours;
        byBusiness[biz].meeting_count++;
        totalHours += hours;

        const title = ev.title.toLowerCase();
        if (title.includes('meeting') || title.includes('call') || title.includes('sync') || title.includes('standup') || ev.account_id === null) {
          meetingHours += hours;
        }
      }

      res.json({
        data: {
          week_start: weekStart.toISOString(),
          week_end: weekEnd.toISOString(),
          total_hours: Math.round(totalHours * 10) / 10,
          meeting_hours: Math.round(meetingHours * 10) / 10,
          focus_hours: Math.round((totalHours - meetingHours) * 10) / 10,
          by_business: byBusiness,
          event_count: (events || []).length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
