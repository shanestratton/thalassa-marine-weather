/**
 * Voice console types — shared between PTT UI, Bosun client, and cloud fallback.
 *
 * Both paths (Bosun on the boat, Claude Haiku in the cloud) return the same
 * envelope shape so the UI doesn't care which brain answered. The only
 * difference is the `source` field which the console badges in the UI.
 */

export type VoiceSource = 'bosun' | 'cloud' | 'unknown';

export interface VoiceQueryRequest {
    /** What the skipper said (already transcribed by iOS Web Speech API). */
    text: string;
    /** Optional: device-side conversation id, for future thread continuity. */
    sessionId?: string;
}

export interface VoiceQueryResponse {
    /** Echo of the transcript so the UI can correct any STT drift. */
    transcript: string;
    /** Bosun's text answer — always present, always shown in the UI. */
    answer_text: string;
    /** Base64-encoded MP3 (ElevenLabs). May be empty if TTS failed. */
    audio_b64?: string;
    /** Which brain answered — 'bosun' or 'cloud'. */
    source: VoiceSource;
    /** Optional: tool calls Bosun made to answer (live SOC reads, etc.). */
    tool_calls?: Array<{
        name: string;
        args: Record<string, unknown>;
        status: 'success' | 'error' | 'denied';
        result?: unknown;
        error?: string;
    }>;
    /** Round-trip diagnostics — surfaced in dev mode. */
    timings_ms?: {
        total: number;
        rag?: number;
        llm?: number;
        tts?: number;
    };
}

/** UI-only state — not sent over the wire. */
export type RecorderState =
    | { kind: 'idle' }
    | { kind: 'recording'; startedAt: number }
    | { kind: 'sending'; transcript: string }
    | { kind: 'awaiting'; transcript: string }
    | { kind: 'playing'; response: VoiceQueryResponse }
    | { kind: 'error'; message: string };

export interface VoiceTurn {
    id: string;
    timestamp: number;
    transcript: string;
    response: VoiceQueryResponse;
}
