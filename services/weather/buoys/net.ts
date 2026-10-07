/**
 * How the buoy feeds are fetched (build 123, W1-11).
 *
 * JSON feeds (Queensland's CKAN, the Irish ERDDAP) try the boat's Pi first and
 * go direct on any miss. Plain-text feeds (NDBC) go direct only: the Pi's
 * generic passthrough JSON.parses every upstream body (pi-cache/src/proxy.ts,
 * fetchAndCache), so a text file through it is a guaranteed 502 and a wasted
 * hop. No Pi redeploy is in build 123, so that stays as it is.
 *
 * Direct requests use CapacitorHttp: native on iOS, which is also what lets
 * the app read NDBC at all — NDBC sends no CORS header, so a browser cannot.
 */
import { CapacitorHttp } from '@capacitor/core';
import { piCache } from '../../PiCacheService';

/** The feeds refresh every 5–30 min; ten minutes keeps a tap cheap and honest. */
export const BUOY_CACHE_TTL_MS = 10 * 60 * 1000;

const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 15_000 };

/** A feed answered, but not with data. `status` lets a provider read a 404 as "no rows". */
export class BuoyFeedError extends Error {
    readonly status: number;
    constructor(source: string, status: number) {
        super(`${source}: HTTP ${status}`);
        this.status = status;
    }
}

export async function getBuoyJson(url: string, source: string): Promise<unknown> {
    const viaPi = await piCache.passthroughJson<unknown>(url, BUOY_CACHE_TTL_MS, source);
    if (viaPi !== null) return viaPi;
    const res = await CapacitorHttp.get({ url, headers: { Accept: 'application/json' }, ...TIMEOUTS });
    if (res.status !== 200 || res.data === null || res.data === undefined || res.data === '') {
        throw new BuoyFeedError(source, res.status);
    }
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

export async function getBuoyText(url: string, source: string): Promise<string> {
    const res = await CapacitorHttp.get({ url, headers: { Accept: 'text/plain' }, ...TIMEOUTS });
    if (res.status !== 200 || typeof res.data !== 'string' || res.data === '') {
        throw new BuoyFeedError(source, res.status);
    }
    return res.data;
}
