/**
 * Bosun voice client — sends a transcript to the Pi-hosted Bosun cascade
 * over the boat WiFi LAN, returns the answer text + ElevenLabs audio.
 *
 * Pi discovery is reused from BoatNetworkService (the same Pi already runs
 * AvNav charts, SignalK, and the Pi Cache). The Bosun web server lives at
 * port 5000 alongside.
 *
 * The endpoint expects iOS to do STT on-device and POST text — keeps the
 * payload tiny, avoids audio-format conversion on the Pi, and matches the
 * cloud-fallback path which is text-in by necessity (Claude has no audio
 * input).
 */

import { CapacitorHttp } from '@capacitor/core';
import { BoatNetworkService } from '../BoatNetworkService';
import type { VoiceQueryRequest, VoiceQueryResponse } from '../../types/voice';

/** Default port for bosun_web.py on the Pi. Aligned with systemd unit. */
const BOSUN_WEB_PORT = 5000;

/** Network timeout for the full request — 8B inference can be slow on cold start. */
const BOSUN_REQUEST_TIMEOUT_MS = 240_000; // 4 minutes - cold start on Pi 5 is brutal

export class BosunUnreachableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BosunUnreachableError';
    }
}

/** Build the Bosun ask URL from the discovered Pi host, or null if no Pi. */
function getBosunUrl(): string | null {
    const piHost = BoatNetworkService.getState().piHost;
    if (!piHost) return null;
    return `http://${piHost}:${BOSUN_WEB_PORT}/api/text/ask`;
}

/**
 * Quick reachability check before committing to a full LLM round-trip.
 * Returns true within ~1s if Bosun is on the boat WiFi and answering.
 */
export async function isBosunReachable(): Promise<boolean> {
    const piHost = BoatNetworkService.getState().piHost;
    if (!piHost) return false;
    const url = `http://${piHost}:${BOSUN_WEB_PORT}/api/health`;
    try {
        const response = await CapacitorHttp.get({
            url,
            connectTimeout: 1500,
            readTimeout: 1500,
        });
        return response.status >= 200 && response.status < 300;
    } catch {
        return false;
    }
}

/**
 * Send a transcript to Bosun and wait for the answer.
 * Throws BosunUnreachableError if the Pi can't be reached — caller should
 * fall through to cloudFallback.askCloud().
 */
export async function askBosun(req: VoiceQueryRequest): Promise<VoiceQueryResponse> {
    const url = getBosunUrl();
    if (!url) {
        throw new BosunUnreachableError('No Pi discovered on the boat network. Connect to boat WiFi and try again.');
    }

    let response;
    try {
        response = await CapacitorHttp.post({
            url,
            headers: { 'Content-Type': 'application/json' },
            data: {
                text: req.text,
                session_id: req.sessionId,
            },
            connectTimeout: 5_000,
            readTimeout: BOSUN_REQUEST_TIMEOUT_MS,
        });
    } catch (err) {
        throw new BosunUnreachableError(`Could not reach Bosun at ${url}: ${(err as Error).message}`);
    }

    if (response.status < 200 || response.status >= 300) {
        throw new BosunUnreachableError(`Bosun responded with HTTP ${response.status}`);
    }

    const data = response.data as Partial<VoiceQueryResponse>;
    if (!data || typeof data.answer_text !== 'string') {
        throw new Error('Bosun returned an unexpected response shape');
    }

    return {
        transcript: data.transcript ?? req.text,
        answer_text: data.answer_text,
        audio_b64: data.audio_b64,
        source: 'bosun',
        tool_calls: data.tool_calls,
        timings_ms: data.timings_ms,
    };
}
