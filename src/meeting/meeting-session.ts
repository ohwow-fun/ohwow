/**
 * Meeting Session Service
 * Orchestrates: audio capture → transcription → running notes → cloud sync.
 * One active session at a time per runtime.
 */

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { logger } from '../lib/logger.js';
import { AudioCaptureService } from '../audio-capture/audio-capture-service.js';
import type { STTProvider } from '../voice/types.js';
import { VoiceboxSTTProvider } from '../voice/voicebox-stt-provider.js';
import { GemmaAudioProvider, WhisperLocalProvider, WhisperAPIProvider } from '../voice/stt-providers.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { ControlPlaneClient } from '../control-plane/client.js';
import type {
  LocalMeetingSession,
  LocalTranscriptEntry,
  MeetingNotes,
  MeetingSessionSyncPayload,
} from './types.js';

const EMPTY_NOTES: MeetingNotes = {
  summary: '',
  keyPoints: [],
  decisions: [],
  actionItems: [],
  openQuestions: [],
  keyQuotes: [],
  lastUpdated: new Date().toISOString(),
};

/** How many chunks between automatic note updates (~90s at 30s chunks) */
const NOTE_UPDATE_INTERVAL = 3;

/** Minimum new words before triggering an early note update */
const MIN_WORDS_FOR_UPDATE = 500;

// ---------------------------------------------------------------------------
// STT provider cascade (reused from audio.ts pattern)
// ---------------------------------------------------------------------------

async function getBestSTTProvider(ollamaUrl?: string, openaiKey?: string): Promise<STTProvider | null> {
  const candidates: STTProvider[] = [
    new VoiceboxSTTProvider(),
  ];

  const url = ollamaUrl || 'http://localhost:11434';
  candidates.push(
    new GemmaAudioProvider(url, 'gemma4:e2b'),
    new WhisperLocalProvider(url),
  );

  if (openaiKey) {
    candidates.push(new WhisperAPIProvider(openaiKey));
  }

  for (const provider of candidates) {
    try {
      if (await provider.isAvailable()) return provider;
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Meeting Session
// ---------------------------------------------------------------------------

export class MeetingSession {
  private capture: AudioCaptureService | null = null;
  private session: LocalMeetingSession | null = null;
  private sttProvider: STTProvider | null = null;
  private startTime = 0;
  private chunksSinceLastNoteUpdate = 0;
  private wordsSinceLastNoteUpdate = 0;
  private lastSyncIndex = 0;

  constructor(
    private db: DatabaseAdapter,
    private modelRouter: ModelRouter | null,
    private controlPlane: ControlPlaneClient | null,
    private workspaceId: string,
    private ollamaUrl?: string,
    private openaiApiKey?: string,
  ) {}

  /** Whether a meeting is currently being recorded. */
  get isActive(): boolean {
    return this.session?.status === 'listening';
  }

  /** Get the current session (if any). */
  getSession(): LocalMeetingSession | null {
    return this.session;
  }

  /** Get current running notes. */
  getNotes(): MeetingNotes | null {
    return this.session?.notes ?? null;
  }

  /** Get transcript entries added since last sync. */
  getTranscriptDelta(): LocalTranscriptEntry[] {
    if (!this.session) return [];
    return this.session.transcript.slice(this.lastSyncIndex);
  }

  /** Mark transcript as synced up to current point. */
  markSynced(): void {
    if (!this.session) return;
    this.lastSyncIndex = this.session.transcript.length;
    this.session.lastSyncAt = new Date().toISOString();
    this.persistSession();
  }

  // =========================================================================
  // START
  // =========================================================================

  async start(app: string = 'all'): Promise<LocalMeetingSession> {
    if (this.isActive) {
      throw new Error('A meeting session is already active. Stop it first.');
    }

    // Resolve STT provider
    this.sttProvider = await getBestSTTProvider(this.ollamaUrl, this.openaiApiKey);
    if (!this.sttProvider) {
      throw new Error('No speech-to-text provider available. Pull a Whisper model in Ollama or configure an OpenAI API key.');
    }

    // Resolve app bundle ID
    const bundleId = this.resolveAppBundleId(app);

    // Create session record
    const id = randomUUID();
    this.startTime = Date.now();
    this.chunksSinceLastNoteUpdate = 0;
    this.wordsSinceLastNoteUpdate = 0;
    this.lastSyncIndex = 0;

    this.session = {
      id,
      workspaceId: this.workspaceId,
      status: 'listening',
      app,
      startedAt: new Date().toISOString(),
      transcript: [],
      notes: { ...EMPTY_NOTES },
      chunkCount: 0,
    };

    // Persist to local DB
    await this.insertSession();

    // Start audio capture
    this.capture = new AudioCaptureService();
    this.capture.on('chunk', (filePath: string) => {
      this.handleChunk(filePath).catch(err => {
        logger.error({ err }, '[Meeting] Chunk processing failed');
      });
    });
    this.capture.on('error', (err: Error) => {
      logger.error({ err }, '[Meeting] Capture error');
    });
    this.capture.on('stopped', () => {
      logger.info('[Meeting] Capture stopped');
    });

    try {
      await this.capture.start({
        app: bundleId,
        chunkSeconds: 30,
      });
    } catch (err) {
      this.session.status = 'error';
      await this.persistSession();
      throw err;
    }

    logger.info({ id, app, provider: this.sttProvider.name }, '[Meeting] Session started');

    // Sync initial session to cloud
    this.syncToCloud().catch(err => {
      logger.debug({ err }, '[Meeting] Initial cloud sync failed (non-blocking)');
    });

    return this.session;
  }

  // =========================================================================
  // STOP
  // =========================================================================

  async stop(): Promise<MeetingNotes> {
    if (!this.session || !this.capture) {
      throw new Error('No active meeting session');
    }

    // Stop capture (flushes final chunk)
    this.session.status = 'processing';
    await this.persistSession();
    await this.capture.stop();

    // Run final comprehensive analysis
    await this.runFinalAnalysis();

    // Mark complete
    this.session.status = 'completed';
    this.session.endedAt = new Date().toISOString();
    await this.persistSession();

    // Final cloud sync with completed meeting data
    await this.syncToCloud().catch(err => {
      logger.warn({ err }, '[Meeting] Final cloud sync failed');
    });

    const notes = this.session.notes;
    logger.info({
      id: this.session.id,
      chunkCount: this.session.chunkCount,
      transcriptEntries: this.session.transcript.length,
      durationSeconds: Math.round((Date.now() - this.startTime) / 1000),
    }, '[Meeting] Session completed');

    this.capture = null;
    return notes;
  }

  // =========================================================================
  // BUILD SYNC PAYLOAD (called by control plane client)
  // =========================================================================

  buildSyncPayload(): MeetingSessionSyncPayload | null {
    if (!this.session) return null;

    const delta = this.getTranscriptDelta();
    const fullText = this.session.transcript.map(t => t.text).join(' ');
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;

    const payload: MeetingSessionSyncPayload = {
      sessionId: this.session.id,
      status: this.session.status,
      app: this.session.app,
      startedAt: this.session.startedAt,
      endedAt: this.session.endedAt,
      transcriptDelta: delta,
      notes: this.session.notes,
      wordCount,
      chunkCount: this.session.chunkCount,
    };

    // Include completed meeting data for final sync
    if (this.session.status === 'completed' && this.session.notes.summary) {
      payload.completedMeeting = {
        title: this.session.notes.summary.slice(0, 200),
        fullTranscript: fullText,
        durationSeconds: Math.round((Date.now() - this.startTime) / 1000),
        attendees: this.extractAttendees(),
        topics: this.session.notes.keyPoints.map(kp => ({ topic: kp, summary: kp })),
        decisions: this.session.notes.decisions,
        actionItems: this.session.notes.actionItems,
        openQuestions: this.session.notes.openQuestions,
        keyQuotes: this.session.notes.keyQuotes,
      };
    }

    return payload;
  }

  // =========================================================================
  // PRIVATE: Chunk handling
  // =========================================================================

  private async handleChunk(filePath: string): Promise<void> {
    if (!this.session || !this.sttProvider) return;

    try {
      const audioBuffer = readFileSync(filePath);
      const timestampMs = Date.now() - this.startTime;

      logger.debug({ filePath, size: audioBuffer.length }, '[Meeting] Transcribing chunk');

      const result = await this.sttProvider.transcribe(audioBuffer, {
        prompt: 'Transcribe this meeting audio accurately. Include speaker names if detectable.',
      });

      if (!result.text || result.text.trim().length === 0) {
        logger.debug('[Meeting] No speech detected in chunk');
        this.session.chunkCount++;
        return;
      }

      const entry: LocalTranscriptEntry = {
        timestampMs,
        text: result.text,
        speaker: result.segments?.[0]?.speaker,
        confidence: result.confidence,
      };

      this.session.transcript.push(entry);
      this.session.chunkCount++;
      this.chunksSinceLastNoteUpdate++;
      this.wordsSinceLastNoteUpdate += result.text.split(/\s+/).length;

      // Update notes periodically
      const shouldUpdateNotes =
        this.chunksSinceLastNoteUpdate >= NOTE_UPDATE_INTERVAL ||
        this.wordsSinceLastNoteUpdate >= MIN_WORDS_FOR_UPDATE;

      if (shouldUpdateNotes) {
        await this.updateNotes();
        this.chunksSinceLastNoteUpdate = 0;
        this.wordsSinceLastNoteUpdate = 0;
      }

      await this.persistSession();
    } catch (err) {
      logger.error({ err, filePath }, '[Meeting] Failed to process chunk');
    }
  }

  // =========================================================================
  // PRIVATE: Note updates via LLM
  // =========================================================================

  private async updateNotes(): Promise<void> {
    if (!this.session || !this.modelRouter) return;

    const transcript = this.session.transcript
      .map(t => {
        const time = this.formatTimestamp(t.timestampMs);
        const speaker = t.speaker ? `[${t.speaker}]` : '';
        return `${time} ${speaker} ${t.text}`;
      })
      .join('\n');

    const existingNotes = JSON.stringify(this.session.notes, null, 2);

    try {
      const provider = await this.modelRouter.getProvider('agent_task');
      const response = await provider.createMessage({
        messages: [{
          role: 'user',
          content: `You are a meeting note-taker. Update the structured meeting notes based on the full transcript so far.

CURRENT NOTES:
${existingNotes}

FULL TRANSCRIPT:
${transcript}

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "summary": "2-3 sentence meeting summary so far",
  "keyPoints": ["point 1", "point 2"],
  "decisions": [{"decision": "what was decided", "context": "why/how"}],
  "actionItems": [{"item": "what to do", "assignee": "who", "dueDate": "when", "priority": "low|medium|high"}],
  "openQuestions": [{"question": "unresolved question", "context": "context"}],
  "keyQuotes": [{"quote": "notable quote", "speaker": "who said it"}]
}`,
        }],
        maxTokens: 4096,
        temperature: 0.2,
      });

      const parsed = this.parseNotesResponse(response.content);
      if (parsed) {
        parsed.lastUpdated = new Date().toISOString();
        this.session.notes = parsed;
        logger.info({
          keyPoints: parsed.keyPoints.length,
          decisions: parsed.decisions.length,
          actionItems: parsed.actionItems.length,
        }, '[Meeting] Notes updated');
      }
    } catch (err) {
      logger.warn({ err }, '[Meeting] Note update failed (non-blocking)');
    }
  }

  private async runFinalAnalysis(): Promise<void> {
    if (!this.session || !this.modelRouter) return;
    if (this.session.transcript.length === 0) return;

    const transcript = this.session.transcript
      .map(t => {
        const time = this.formatTimestamp(t.timestampMs);
        const speaker = t.speaker ? `[${t.speaker}]` : '';
        return `${time} ${speaker} ${t.text}`;
      })
      .join('\n');

    const durationMin = Math.round((Date.now() - this.startTime) / 60_000);

    try {
      const provider = await this.modelRouter.getProvider('agent_task', 'complex');
      const response = await provider.createMessage({
        messages: [{
          role: 'user',
          content: `You are a meeting analyst. Produce comprehensive meeting notes from this ${durationMin}-minute meeting transcript.

TRANSCRIPT:
${transcript}

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "summary": "Comprehensive 3-5 sentence summary of the entire meeting",
  "keyPoints": ["key point 1", "key point 2", ...],
  "decisions": [{"decision": "what was decided", "context": "background and reasoning"}],
  "actionItems": [{"item": "specific action", "assignee": "person responsible", "dueDate": "deadline if mentioned", "priority": "low|medium|high"}],
  "openQuestions": [{"question": "unresolved question", "context": "why it matters"}],
  "keyQuotes": [{"quote": "exact notable quote", "speaker": "who said it"}]
}

Be thorough. Capture every decision and action item. Identify speakers where possible.`,
        }],
        maxTokens: 8192,
        temperature: 0.1,
      });

      const parsed = this.parseNotesResponse(response.content);
      if (parsed) {
        parsed.lastUpdated = new Date().toISOString();
        this.session.notes = parsed;
        logger.info('[Meeting] Final analysis complete');
      }
    } catch (err) {
      logger.warn({ err }, '[Meeting] Final analysis failed, keeping running notes');
    }
  }

  // =========================================================================
  // PRIVATE: Helpers
  // =========================================================================

  private parseNotesResponse(content: string): MeetingNotes | null {
    try {
      // Strip markdown code fences if present
      const cleaned = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        summary: parsed.summary || '',
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
        keyQuotes: Array.isArray(parsed.keyQuotes) ? parsed.keyQuotes : [],
        lastUpdated: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn({ err, content: content.slice(0, 200) }, '[Meeting] Failed to parse notes JSON');
      return null;
    }
  }

  private formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
  }

  private resolveAppBundleId(app: string): string | undefined {
    const bundleIds: Record<string, string> = {
      zoom: 'us.zoom.xos',
      teams: 'com.microsoft.teams2',
      meet: 'com.google.Chrome', // Meet runs in Chrome
    };
    if (app === 'all') return undefined;
    return bundleIds[app.toLowerCase()] || app; // Allow raw bundle IDs
  }

  private extractAttendees(): Array<{ name: string; role?: string }> {
    const speakers = new Set<string>();
    for (const entry of this.session?.transcript ?? []) {
      if (entry.speaker) speakers.add(entry.speaker);
    }
    return Array.from(speakers).map(name => ({ name }));
  }

  // =========================================================================
  // PRIVATE: Database persistence
  // =========================================================================

  private async insertSession(): Promise<void> {
    if (!this.session) return;
    await this.db.from('meeting_sessions').insert({
      id: this.session.id,
      workspace_id: this.session.workspaceId,
      status: this.session.status,
      app: this.session.app,
      transcript: JSON.stringify(this.session.transcript),
      notes: JSON.stringify(this.session.notes),
      chunk_count: this.session.chunkCount,
      started_at: this.session.startedAt,
    });
  }

  private async persistSession(): Promise<void> {
    if (!this.session) return;
    await this.db.from('meeting_sessions').update({
      status: this.session.status,
      transcript: JSON.stringify(this.session.transcript),
      notes: JSON.stringify(this.session.notes),
      chunk_count: this.session.chunkCount,
      last_sync_at: this.session.lastSyncAt || null,
      ended_at: this.session.endedAt || null,
      updated_at: new Date().toISOString(),
    }).eq('id', this.session.id);
  }

  private async syncToCloud(): Promise<void> {
    if (!this.controlPlane) return;
    const payload = this.buildSyncPayload();
    if (!payload) return;

    try {
      await (this.controlPlane as unknown as { syncMeetingSession(p: MeetingSessionSyncPayload): Promise<void> })
        .syncMeetingSession(payload);
      this.markSynced();
    } catch (err) {
      logger.debug({ err }, '[Meeting] Cloud sync failed');
    }
  }
}
