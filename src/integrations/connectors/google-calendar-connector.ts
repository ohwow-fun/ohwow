/**
 * Google Calendar Connector
 * Syncs events from Google Calendar API into local SQLite.
 * Credentials (access_token, refresh_token) stored in calendar_accounts.credentials.
 */

import { logger } from '../../lib/logger.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 30_000;

export interface GCalCredentials {
  access_token: string;
  refresh_token?: string;
  token_expires_at?: string;
  client_id?: string;
  client_secret?: string;
}

export interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  organizer?: { email: string; displayName?: string };
  status?: string;
  recurrence?: string[];
  hangoutLink?: string;
  htmlLink?: string;
  colorId?: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  nextSyncToken?: string;
  errors: string[];
}

export class GoogleCalendarConnector {
  private accessToken: string;

  constructor(credentials: GCalCredentials) {
    this.accessToken = credentials.access_token;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${CAL_API}/users/me/calendarList?maxResults=1`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (resp.ok) return { ok: true };
      const body = await resp.text();
      return { ok: false, error: `Auth failed: ${resp.status} ${body}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async listCalendars(): Promise<Array<{ id: string; summary: string; timeZone?: string; backgroundColor?: string }>> {
    const resp = await fetch(`${CAL_API}/users/me/calendarList`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Failed to list calendars: ${resp.status}`);
    const data = await resp.json() as { items?: Array<{ id: string; summary: string; timeZone?: string; backgroundColor?: string }> };
    return data.items || [];
  }

  async createCalendar(summary: string, timeZone = 'America/Bogota'): Promise<{ id: string; summary: string }> {
    const resp = await fetch(`${CAL_API}/calendars`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ summary, timeZone }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Failed to create calendar: ${resp.status}`);
    return resp.json() as Promise<{ id: string; summary: string }>;
  }

  async syncEvents(calendarId: string, syncToken?: string): Promise<{
    events: GCalEvent[];
    nextSyncToken?: string;
    nextPageToken?: string;
  }> {
    const params = new URLSearchParams({
      maxResults: '250',
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    if (syncToken) {
      params.set('syncToken', syncToken);
    } else {
      // Full sync: 3 months back, 6 months forward
      const now = new Date();
      const past = new Date(now);
      past.setMonth(past.getMonth() - 3);
      const future = new Date(now);
      future.setMonth(future.getMonth() + 6);
      params.set('timeMin', past.toISOString());
      params.set('timeMax', future.toISOString());
    }

    const allEvents: GCalEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
      if (pageToken) params.set('pageToken', pageToken);
      const resp = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (resp.status === 410) {
        // Sync token expired — caller should do full sync
        throw Object.assign(new Error('Sync token expired'), { code: 'SYNC_TOKEN_EXPIRED' });
      }
      if (!resp.ok) throw new Error(`Failed to fetch events: ${resp.status}`);

      const data = await resp.json() as {
        items?: GCalEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };

      allEvents.push(...(data.items || []));
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken;
    } while (pageToken);

    return { events: allEvents, nextSyncToken };
  }

  async createEvent(calendarId: string, event: {
    summary: string;
    description?: string;
    location?: string;
    start: { dateTime: string; timeZone?: string };
    end: { dateTime: string; timeZone?: string };
    attendees?: Array<{ email: string }>;
    colorId?: string;
  }): Promise<GCalEvent> {
    const resp = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Failed to create event: ${resp.status}`);
    return resp.json() as Promise<GCalEvent>;
  }

  async getFreeBusy(calendarIds: string[], timeMin: string, timeMax: string): Promise<Record<string, Array<{ start: string; end: string }>>> {
    const resp = await fetch(`${CAL_API}/freeBusy`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: calendarIds.map(id => ({ id })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Failed to query free/busy: ${resp.status}`);
    const data = await resp.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };
    const result: Record<string, Array<{ start: string; end: string }>> = {};
    for (const [id, cal] of Object.entries(data.calendars || {})) {
      result[id] = cal.busy || [];
    }
    return result;
  }
}

export function eventToLocalRow(event: GCalEvent, workspaceId: string, accountId: string): Record<string, unknown> {
  const startAt = event.start.dateTime || event.start.date || '';
  const endAt = event.end.dateTime || event.end.date || '';
  const allDay = !event.start.dateTime ? 1 : 0;
  const attendees = (event.attendees || []).map(a => ({ email: a.email, name: a.displayName, status: a.responseStatus }));

  logger.debug({ eventId: event.id, workspaceId, accountId }, '[google-calendar] mapping event to local row');

  return {
    workspace_id: workspaceId,
    account_id: accountId,
    external_id: event.id,
    title: event.summary || '(No title)',
    description: event.description || null,
    location: event.location || null,
    start_at: startAt,
    end_at: endAt,
    all_day: allDay,
    recurrence_rule: event.recurrence ? event.recurrence.join('\n') : null,
    attendees: JSON.stringify(attendees),
    organizer_email: event.organizer?.email || null,
    status: event.status || 'confirmed',
    metadata: JSON.stringify({ google_meet_url: event.hangoutLink, color_id: event.colorId }),
    updated_at: new Date().toISOString(),
  };
}
