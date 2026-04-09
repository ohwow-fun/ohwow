/**
 * Meeting Listener Tools
 * Start/stop system audio capture and get running meeting notes.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { logger } from '../../lib/logger.js';
function getSession(ctx: LocalToolContext) {
  return ctx.meetingSession ?? null;
}

/**
 * Start listening to a meeting via system audio capture.
 */
export async function startMeetingListener(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const session = getSession(ctx);
  if (!session) {
    return {
      success: false,
      error: 'Meeting listener is not available. Requires macOS 13+ with Xcode CLI tools.',
    };
  }

  if (session.isActive) {
    return {
      success: false,
      error: 'A meeting is already being recorded. Stop it first with stop_meeting_listener.',
    };
  }

  const app = (input.app as string) || 'all';
  const validApps = ['zoom', 'teams', 'meet', 'all'];
  if (!validApps.includes(app.toLowerCase()) && !app.includes('.')) {
    return {
      success: false,
      error: `Unknown app "${app}". Use: zoom, teams, meet, all, or a bundle ID like us.zoom.xos`,
    };
  }

  try {
    const result = await session.start(app);
    logger.info({ sessionId: result.id, app }, '[Meeting] Listener started via tool');

    return {
      success: true,
      data: {
        sessionId: result.id,
        app,
        message: app === 'all'
          ? 'Listening to all system audio. I\'ll transcribe and take notes as the meeting progresses. Say "meeting notes" anytime, or "stop listening" when done.'
          : `Listening to ${app} audio. I'll transcribe and take notes as the meeting progresses. Say "meeting notes" anytime, or "stop listening" when done.`,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start audio capture';
    logger.error({ err }, '[Meeting] Failed to start listener');
    return { success: false, error: message };
  }
}

/**
 * Stop the active meeting listener and get final analysis.
 */
export async function stopMeetingListener(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  const session = getSession(ctx);
  if (!session) {
    return {
      success: false,
      error: 'Meeting listener is not available.',
    };
  }

  if (!session.isActive) {
    return {
      success: false,
      error: 'No active meeting session to stop.',
    };
  }

  try {
    const notes = await session.stop();
    const currentSession = session.getSession();
    const durationMinutes = currentSession?.endedAt && currentSession?.startedAt
      ? Math.round((new Date(currentSession.endedAt).getTime() - new Date(currentSession.startedAt).getTime()) / 60_000)
      : 0;

    return {
      success: true,
      data: {
        sessionId: currentSession?.id,
        durationMinutes,
        chunkCount: currentSession?.chunkCount ?? 0,
        notes,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop meeting listener';
    logger.error({ err }, '[Meeting] Failed to stop listener');
    return { success: false, error: message };
  }
}

/**
 * Get the current running notes from an active meeting session.
 */
export async function getMeetingNotes(
  ctx: LocalToolContext,
  _input: Record<string, unknown>,
): Promise<ToolResult> {
  const session = getSession(ctx);
  if (!session) {
    return {
      success: false,
      error: 'Meeting listener is not available.',
    };
  }

  const currentSession = session.getSession();
  if (!currentSession) {
    return {
      success: false,
      error: 'No meeting session found. Start one with start_meeting_listener first.',
    };
  }

  const notes = session.getNotes();
  const transcriptCount = currentSession.transcript.length;
  const wordCount = currentSession.transcript.reduce(
    (sum, t) => sum + t.text.split(/\s+/).length, 0
  );

  return {
    success: true,
    data: {
      sessionId: currentSession.id,
      status: currentSession.status,
      transcriptEntries: transcriptCount,
      wordCount,
      chunkCount: currentSession.chunkCount,
      notes,
    },
  };
}
