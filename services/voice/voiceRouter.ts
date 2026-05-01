/**
 * Voice router — picks Bosun (boat) or cloud (Haiku) for a given query.
 *
 * Routing logic (V1, simple):
 *   1. Try Bosun first — quick health check (~1s)
 *   2. If Bosun is up, use it (full vessel knowledge + live tools)
 *   3. If Bosun is down, fall through to Claude Haiku
 *   4. If neither works, return a clean error the UI can show
 *
 * Future: smarter routing — send "live boat state" queries to Bosun even
 * if cloud is faster, send conversational queries to cloud even if Bosun
 * is up. Needs telemetry on which path users prefer per query type.
 */

import { askBosun, isBosunReachable, BosunUnreachableError } from './bosunVoice';
import { askCloud, CloudFallbackError } from './cloudFallback';
import type { VoiceQueryRequest, VoiceQueryResponse } from '../../types/voice';

export type RoutingPreference = 'auto' | 'bosun-only' | 'cloud-only';

export interface RoutingDecision {
    /** Whether the request was sent to Bosun, cloud, or failed. */
    source: 'bosun' | 'cloud' | 'failed';
    /** Why we chose this route — surfaced to dev mode only. */
    reason: string;
}

/**
 * Ask Bosun first; fall back to cloud Haiku on Bosun failure.
 * Always resolves with a VoiceQueryResponse — wraps both error paths.
 */
export async function ask(req: VoiceQueryRequest, preference: RoutingPreference = 'auto'): Promise<VoiceQueryResponse> {
    if (preference === 'cloud-only') {
        return askCloud(req);
    }

    if (preference === 'bosun-only') {
        return askBosun(req); // throws if unreachable - caller handles
    }

    // Auto: try Bosun, fall back to cloud
    let bosunReachable = false;
    try {
        bosunReachable = await isBosunReachable();
    } catch {
        bosunReachable = false;
    }

    if (bosunReachable) {
        try {
            return await askBosun(req);
        } catch (err) {
            // Bosun was reachable a second ago but failed mid-request.
            // Try cloud as a last resort.
            if (err instanceof BosunUnreachableError) {
                return askCloud(req);
            }
            // For non-network errors (bad response shape, 5xx), surface
            // them rather than masking with a cloud fallback.
            throw err;
        }
    }

    try {
        return await askCloud(req);
    } catch (err) {
        if (err instanceof CloudFallbackError) {
            throw new Error(
                'Both Bosun and the cloud fallback are unreachable. ' + 'Check boat WiFi or internet connection.',
            );
        }
        throw err;
    }
}
