/**
 * Voice console types — shared between PTT UI, Bosun client, and cloud fallback.
 *
 * Both paths (Bosun on the boat, Claude Haiku in the cloud) return the same
 * envelope shape so the UI doesn't care which brain answered. The only
 * difference is the `source` field which the console badges in the UI.
 */

export type VoiceSource = 'bosun' | 'cloud' | 'unknown';

// ── Thalassa state snapshot — bundled with every voice/text request ─────
//
// Sent to the cloud edge function so Haiku has current "what's on the
// skipper's screen" context alongside the cached static vessel profile.
// All fields optional — only what's populated is rendered into the prompt.

export interface ThalassaLocation {
    lat: number;
    lon: number;
    name: string;
    source: 'gps' | 'map_pin' | 'search' | 'favorite' | 'initial';
    /** Seconds since this location was set. */
    ageSec: number;
}

export interface ThalassaConditions {
    locationName: string;
    windKt?: number;
    windDirDeg?: number;
    windDirCompass?: string;
    gustKt?: number;
    waveHeightM?: number;
    wavePeriodSec?: number;
    airTempC?: number;
    waterTempC?: number;
    pressureHpa?: number;
    humidityPct?: number;
    condition?: string;
    description?: string;
    /** Provider/model that generated the data (e.g. "open-meteo", "weatherkit"). */
    source?: string;
    /** Seconds since the data was generated. */
    ageSec?: number;
}

export interface ThalassaPassage {
    from: string;
    to: string;
    distanceNm: number;
    durationHours: number;
    departureTime?: string;
    arrivalTime?: string;
    maxWindKt?: number;
    maxWaveM?: number;
}

export interface ThalassaContext {
    /** Device local time at request time (ISO 8601). */
    localTimeIso: string;
    location?: ThalassaLocation;
    conditions?: ThalassaConditions;
    passage?: ThalassaPassage;
}

export interface VoiceQueryRequest {
    /** What the skipper said (already transcribed by iOS Web Speech API). */
    text: string;
    /** Optional: device-side conversation id, for future thread continuity. */
    sessionId?: string;
    /** Optional: snapshot of Thalassa state (location, weather, passage). */
    context?: ThalassaContext;
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
