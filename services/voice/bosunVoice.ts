/**
 * Bosun voice client — sends transcript text OR audio to the Pi-hosted Bosun
 * cascade over the boat WiFi LAN, returns the answer text + ElevenLabs audio.
 *
 * Pi discovery is reused from BoatNetworkService (the same Pi already runs
 * AvNav charts, SignalK, and the Pi Cache). The Bosun web server lives at
 * port 5000 alongside.
 *
 * Two endpoints:
 *   POST /api/text/ask    typed query path; expects {text, session_id?}
 *   POST /api/voice/ask   voice query path; expects {audio_b64, mime_type}
 *                         server runs Whisper.cpp STT, then the cascade.
 *
 * Both return the same VoiceQueryResponse envelope.
 */

import { CapacitorHttp } from '@capacitor/core';
import { BoatNetworkService } from '../BoatNetworkService';
import { blobToBase64 } from './audioRecorder';
import type { VoiceQueryRequest, VoiceQueryResponse } from '../../types/voice';

const BOSUN_WEB_PORT = 5000;
/** 8B cold-start on Pi 5 CPU can be 3-4 minutes; give a generous read timeout. */
const BOSUN_REQUEST_TIMEOUT_MS = 240_000;

export class BosunUnreachableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BosunUnreachableError';
    }
}

function getBosunBase(): string | null {
    const piHost = BoatNetworkService.getState().piHost;
    if (!piHost) return null;
    return `http://${piHost}:${BOSUN_WEB_PORT}`;
}

/**
 * Quick reachability check before committing to a full LLM round-trip.
 * Returns true within ~1.5s if Bosun is on the boat WiFi and answering.
 */
export async function isBosunReachable(): Promise<boolean> {
    const base = getBosunBase();
    if (!base) return false;
    try {
        const response = await CapacitorHttp.get({
            url: `${base}/api/health`,
            connectTimeout: 1500,
            readTimeout: 1500,
        });
        return response.status >= 200 && response.status < 300;
    } catch {
        return false;
    }
}

/**
 * Send a typed-text query to Bosun. Used when the skipper types instead
 * of speaking.
 */
export async function askBosunText(req: VoiceQueryRequest): Promise<VoiceQueryResponse> {
    const base = getBosunBase();
    if (!base) {
        throw new BosunUnreachableError('No Pi discovered on the boat network. Connect to boat WiFi and try again.');
    }

    let response;
    try {
        response = await CapacitorHttp.post({
            url: `${base}/api/text/ask`,
            headers: { 'Content-Type': 'application/json' },
            data: { text: req.text, session_id: req.sessionId },
            connectTimeout: 5_000,
            readTimeout: BOSUN_REQUEST_TIMEOUT_MS,
        });
    } catch (err) {
        throw new BosunUnreachableError(`Could not reach Bosun: ${(err as Error).message}`);
    }

    return parseResponse(response, req.text);
}

/**
 * Send a recorded audio blob to Bosun. Server-side Whisper.cpp transcribes
 * it, the cascade answers, and ElevenLabs generates the voice reply.
 *
 * The blob is base64-encoded into a JSON body. CapacitorHttp doesn't have
 * great multipart support, and base64 keeps the request shape simple. The
 * ~33% size overhead is fine for short-utterance recordings (typically
 * 5-30 KB raw, 7-40 KB encoded).
 */
export async function askBosunVoice(audioBlob: Blob): Promise<VoiceQueryResponse> {
    const base = getBosunBase();
    if (!base) {
        throw new BosunUnreachableError('No Pi discovered on the boat network. Connect to boat WiFi and try again.');
    }

    const audio_b64 = await blobToBase64(audioBlob);
    if (!audio_b64) {
        throw new Error('Recorded audio is empty — try holding for a moment longer.');
    }

    let response;
    try {
        response = await CapacitorHttp.post({
            url: `${base}/api/voice/ask`,
            headers: { 'Content-Type': 'application/json' },
            data: {
                audio_b64,
                mime_type: audioBlob.type || 'audio/mp4',
            },
            connectTimeout: 5_000,
            readTimeout: BOSUN_REQUEST_TIMEOUT_MS,
        });
    } catch (err) {
        throw new BosunUnreachableError(`Could not reach Bosun: ${(err as Error).message}`);
    }

    return parseResponse(response);
}

// ── shared response handling ────────────────────────────────────────────

function parseResponse(response: { status: number; data: unknown }, fallbackTranscript = ''): VoiceQueryResponse {
    if (response.status < 200 || response.status >= 300) {
        throw new BosunUnreachableError(`Bosun responded with HTTP ${response.status}`);
    }
    const data = response.data as Partial<VoiceQueryResponse>;
    if (!data || typeof data.answer_text !== 'string') {
        throw new Error('Bosun returned an unexpected response shape');
    }
    return {
        transcript: data.transcript ?? fallbackTranscript,
        answer_text: data.answer_text,
        audio_b64: data.audio_b64,
        source: 'bosun',
        tool_calls: data.tool_calls,
        timings_ms: data.timings_ms,
    };
}

// ── backwards-compat alias ──────────────────────────────────────────────
// Older callers (and any future text-only path) can still use askBosun()
// for typed queries. Voice calls should switch to askBosunVoice() with a Blob.
export const askBosun = askBosunText;
