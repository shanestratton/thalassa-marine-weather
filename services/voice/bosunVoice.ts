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
 * Transport: native fetch() with AbortController. CapacitorHttp's iOS
 * implementation silently caps at 60s, which doesn't match Bosun's
 * occasional 3-4 minute cold-start cascade times. Plain fetch + a
 * JS-enforced AbortController honours whatever timeout we pass.
 *
 * Both return the same VoiceQueryResponse envelope.
 */

import { BoatNetworkService } from '../BoatNetworkService';
import { blobToBase64 } from './audioRecorder';
import type { VoiceQueryRequest, VoiceQueryResponse } from '../../types/voice';

const BOSUN_WEB_PORT = 5000;
/** 8B cold-start on Pi 5 CPU can be 3-4 minutes; give a generous read timeout. */
const BOSUN_REQUEST_TIMEOUT_MS = 240_000;
/** Health-check probe; very short. */
const HEALTH_TIMEOUT_MS = 1500;

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

/** Quick reachability check before committing to a full LLM round-trip. */
export async function isBosunReachable(): Promise<boolean> {
    const base = getBosunBase();
    if (!base) return false;

    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
        const response = await fetch(`${base}/api/health`, { signal: ctrl.signal });
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(watchdog);
    }
}

/** Shared POST helper with JS-enforced timeout via AbortController. */
async function postJson(
    url: string,
    body: object,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
    signal?.throwIfAborted();
    const ctrl = new AbortController();
    const abortFromCaller = () => ctrl.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    const watchdog = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } catch (err) {
            const e = err as Error;
            if (e.name === 'AbortError') {
                if (signal?.aborted) throw e;
                throw new BosunUnreachableError(`Bosun timed out after ${Math.round(timeoutMs / 1000)}s.`);
            }
            throw new BosunUnreachableError(`Could not reach Bosun: ${e.message}`);
        }

        let data: unknown = null;
        try {
            data = await response.json();
        } catch {
            signal?.throwIfAborted();
            /* non-JSON body */
        }
        return { status: response.status, data };
    } finally {
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', abortFromCaller);
    }
}

/** Send a typed-text query to Bosun. */
export async function askBosunText(req: VoiceQueryRequest, signal?: AbortSignal): Promise<VoiceQueryResponse> {
    signal?.throwIfAborted();
    const base = getBosunBase();
    if (!base) {
        throw new BosunUnreachableError('No Pi discovered on the boat network. Connect to boat WiFi and try again.');
    }
    const r = await postJson(
        `${base}/api/text/ask`,
        { text: req.text, session_id: req.sessionId },
        BOSUN_REQUEST_TIMEOUT_MS,
        signal,
    );
    return parseResponse(r, req.text);
}

/** Send a recorded audio blob to Bosun (Whisper.cpp STT server-side). */
export async function askBosunVoice(audioBlob: Blob, signal?: AbortSignal): Promise<VoiceQueryResponse> {
    signal?.throwIfAborted();
    const base = getBosunBase();
    if (!base) {
        throw new BosunUnreachableError('No Pi discovered on the boat network. Connect to boat WiFi and try again.');
    }
    const audio_b64 = await blobToBase64(audioBlob);
    signal?.throwIfAborted();
    if (!audio_b64) {
        throw new Error('Recorded audio is empty — try holding for a moment longer.');
    }
    const r = await postJson(
        `${base}/api/voice/ask`,
        { audio_b64, mime_type: audioBlob.type || 'audio/mp4' },
        BOSUN_REQUEST_TIMEOUT_MS,
        signal,
    );
    return parseResponse(r);
}

function parseResponse(response: { status: number; data: unknown }, fallbackTranscript = ''): VoiceQueryResponse {
    if (response.status < 200 || response.status >= 300) {
        const errMsg = (response.data as { error?: string })?.error || `Bosun responded with HTTP ${response.status}`;
        throw new BosunUnreachableError(errMsg);
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

// Backwards-compat alias
export const askBosun = askBosunText;
