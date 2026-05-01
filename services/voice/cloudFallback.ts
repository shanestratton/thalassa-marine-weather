/**
 * Cloud fallback — Claude Haiku 4.5 + ElevenLabs (same voice as Bosun).
 *
 * Used when Bosun on the boat is unreachable. Routes through a Supabase
 * Edge Function `proxy-bosun-fallback` which holds the Anthropic and
 * ElevenLabs API keys server-side (same pattern as proxy-stormglass).
 *
 * Returns the same VoiceQueryResponse envelope as askBosun() so the UI
 * doesn't have to switch on source — only the badge changes.
 */

import { CapacitorHttp } from '@capacitor/core';
import type { VoiceQueryRequest, VoiceQueryResponse } from '../../types/voice';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

// Cloud Haiku in tool-use mode can chain through web_search + thalassa_weather
// + final synthesis + ElevenLabs TTS. Each tool call adds 1-5s, and the cold
// Edge Function startup can add another 5-10s. 90s is a generous ceiling that
// still surfaces real hangs (e.g. tools looping) without false-positive timeouts.
const CLOUD_REQUEST_TIMEOUT_MS = 90_000;

export class CloudFallbackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CloudFallbackError';
    }
}

/**
 * Send the transcript to Claude Haiku via the Supabase Edge Function.
 * Throws CloudFallbackError on any failure — UI should surface "shore
 * answer unavailable" rather than retrying.
 */
export async function askCloud(req: VoiceQueryRequest): Promise<VoiceQueryResponse> {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new CloudFallbackError('Cloud fallback not configured (missing Supabase credentials).');
    }

    const url = `${SUPABASE_URL}/functions/v1/proxy-bosun-fallback`;

    let response;
    try {
        response = await CapacitorHttp.post({
            url,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            data: {
                text: req.text,
                session_id: req.sessionId,
            },
            connectTimeout: 5_000,
            readTimeout: CLOUD_REQUEST_TIMEOUT_MS,
        });
    } catch (err) {
        throw new CloudFallbackError(`Cloud fallback request failed: ${(err as Error).message}`);
    }

    if (response.status < 200 || response.status >= 300) {
        throw new CloudFallbackError(`Cloud fallback responded with HTTP ${response.status}`);
    }

    const data = response.data as Partial<VoiceQueryResponse>;
    if (!data || typeof data.answer_text !== 'string') {
        throw new CloudFallbackError('Cloud fallback returned an unexpected response shape');
    }

    return {
        transcript: data.transcript ?? req.text,
        answer_text: data.answer_text,
        audio_b64: data.audio_b64,
        source: 'cloud',
        timings_ms: data.timings_ms,
    };
}
