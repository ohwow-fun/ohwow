/**
 * Meeting Listener Types
 * Local audio capture, transcription, and structured meeting notes.
 */

// ============================================================================
// TRANSCRIPT
// ============================================================================

export interface LocalTranscriptEntry {
  /** Milliseconds offset from session start */
  timestampMs: number;
  /** Transcribed text for this chunk */
  text: string;
  /** Detected speaker (if diarization available) */
  speaker?: string;
  /** STT confidence (0–1) */
  confidence: number;
}

// ============================================================================
// MEETING NOTES (structured analysis)
// ============================================================================

export interface MeetingDecision {
  decision: string;
  context: string;
}

export interface MeetingActionItem {
  item: string;
  assignee?: string;
  dueDate?: string;
  priority: 'low' | 'medium' | 'high';
}

export interface MeetingOpenQuestion {
  question: string;
  context: string;
}

export interface MeetingKeyQuote {
  quote: string;
  speaker?: string;
}

export interface MeetingAttendee {
  name: string;
  role?: string;
}

export interface MeetingTopic {
  topic: string;
  summary: string;
}

export interface MeetingNotes {
  summary: string;
  keyPoints: string[];
  decisions: MeetingDecision[];
  actionItems: MeetingActionItem[];
  openQuestions: MeetingOpenQuestion[];
  keyQuotes: MeetingKeyQuote[];
  lastUpdated: string;
}

// ============================================================================
// SESSION
// ============================================================================

export type MeetingSessionStatus = 'listening' | 'processing' | 'completed' | 'error';

export interface LocalMeetingSession {
  id: string;
  workspaceId: string;
  status: MeetingSessionStatus;
  app: string;
  startedAt: string;
  endedAt?: string;
  transcript: LocalTranscriptEntry[];
  notes: MeetingNotes;
  chunkCount: number;
  lastSyncAt?: string;
  cloudSessionId?: string;
}

// ============================================================================
// SYNC PAYLOAD (sent to cloud via control plane)
// ============================================================================

export interface MeetingSessionSyncPayload {
  sessionId: string;
  status: MeetingSessionStatus;
  app: string;
  startedAt: string;
  endedAt?: string;
  /** Only new entries since last sync (incremental) */
  transcriptDelta: LocalTranscriptEntry[];
  notes: MeetingNotes;
  wordCount: number;
  chunkCount: number;
  /** Final meeting data — only populated when status is 'completed' */
  completedMeeting?: {
    title: string;
    fullTranscript: string;
    durationSeconds: number;
    attendees: MeetingAttendee[];
    topics: MeetingTopic[];
    decisions: MeetingDecision[];
    actionItems: MeetingActionItem[];
    openQuestions: MeetingOpenQuestion[];
    keyQuotes: MeetingKeyQuote[];
  };
}
