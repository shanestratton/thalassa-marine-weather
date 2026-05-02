/**
 * Cloud fallback — Claude Haiku 4.5 + ElevenLabs (same voice as Bosun).
 *
 * Used when Bosun on the boat is unreachable. Routes through the Supabase
 * Edge Function `proxy-bosun-fallback` which holds the Anthropic and
 * ElevenLabs keys server-side (same pattern as proxy-stormglass).
 *
 * Two paths:
 *   askCloudText(req)     send typed text → Haiku w/ tools → answer + audio
 *   askCloudVoice(blob)   send recorded audio → ElevenLabs Scribe STT
 *                         → Haiku w/ tools → answer + audio
 *
 * Both return the same VoiceQueryResponse envelope.
 *
 * Transport: native fetch() with AbortController. CapacitorHttp's iOS
 * implementation silently caps at URLSession's 60s timeoutIntervalForRequest
 * regardless of the readTimeout option, which surfaced as the
 * "second-query times out at 60s" bug. The Edge Function returns proper
 * CORS headers (Access-Control-Allow-Origin: *), so cross-origin fetch
 * works from the WKWebView origin.
 */

import { blobToBase64 } from './audioRecorder';
import type { VoiceQueryRequest, VoiceQueryResponse } from '../../types/voice';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

// Cloud Haiku in tool-use mode can chain Scribe STT + thalassa_weather +
// final synthesis + ElevenLabs TTS. Each adds 1-5s; cold Edge Function
// startup adds another 5-10s. 90s ceiling — surfaces real hangs while
// allowing for genuinely long queries with tool use.
const CLOUD_REQUEST_TIMEOUT_MS = 90_000;

export class CloudFallbackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CloudFallbackError';
    }
}

interface AskBody {
    text?: string;
    audio_b64?: string;
    mime_type?: string;
    session_id?: string;
}

async function postToFallback(body: AskBody): Promise<VoiceQueryResponse> {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new CloudFallbackError('Cloud fallback not configured (missing Supabase credentials).');
    }

    const url = `${SUPABASE_URL}/functions/v1/proxy-bosun-fallback`;

    // AbortController so we can enforce our timeout JavaScript-side. iOS's
    // CapacitorHttp ignores readTimeout > 60s, so we use native fetch + abort
    // with the deadline we actually want.
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), CLOUD_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } catch (err) {
        const e = err as Error;
        if (e.name === 'AbortError') {
            throw new CloudFallbackError(
                `Cloud fallback timed out after ${Math.round(CLOUD_REQUEST_TIMEOUT_MS / 1000)}s. ` +
                    `Try again, or switch to typed input.`,
            );
        }
        throw new CloudFallbackError(`Cloud fallback request failed: ${e.message}`);
    } finally {
        clearTimeout(watchdog);
    }

    if (!response.ok) {
        let errMsg = `Cloud responded with HTTP ${response.status}`;
        try {
            const errBody = await response.json();
            if (errBody?.error) errMsg = errBody.error;
        } catch {
            /* non-JSON body — keep the status code message */
        }
        throw new CloudFallbackError(errMsg);
    }

    let data: Partial<VoiceQueryResponse>;
    try {
        data = await response.json();
    } catch {
        throw new CloudFallbackError('Cloud fallback returned a non-JSON response');
    }

    if (!data || typeof data.answer_text !== 'string') {
        throw new CloudFallbackError('Cloud fallback returned an unexpected response shape');
    }

    return {
        transcript: data.transcript ?? body.text ?? '',
        answer_text: data.answer_text,
        audio_b64: data.audio_b64,
        source: 'cloud',
        timings_ms: data.timings_ms,
    };
}

/** Send a typed-text query to the cloud Haiku fallback. */
export async function askCloudText(req: VoiceQueryRequest): Promise<VoiceQueryResponse> {
    return postToFallback({ text: req.text, session_id: req.sessionId });
}

/**
 * Send a recorded audio blob to the cloud Haiku fallback. The Edge Function
 * runs ElevenLabs Scribe for STT, then Haiku, then ElevenLabs TTS, and
 * returns the full VoiceQueryResponse envelope.
 */
export async function askCloudVoice(audioBlob: Blob): Promise<VoiceQueryResponse> {
    const audio_b64 = await blobToBase64(audioBlob);
    if (!audio_b64) {
        throw new CloudFallbackError('Recorded audio is empty — try holding for a moment longer.');
    }
    return postToFallback({ audio_b64, mime_type: audioBlob.type || 'audio/mp4' });
}

// ── backwards-compat alias for any callers still using askCloud(text) ──
export const askCloud = askCloudText;
