/**
 * wxPublished — the phone's side of the wx → Supabase publishing contract.
 *
 * Ruling 2026-08-20: the tailnet wx server is lab-only. It publishes point
 * forecasts INTO Supabase (wx_point_forecasts); phones read them there and
 * announce which coarse cell they occupy (wx_subscriptions) so the publisher
 * knows where the fleet is. Supabase cannot reach the wx server — the flow
 * is push-only by construction — so the app treats the table as just another
 * source: fast when a row exists, silently absent when it does not.
 *
 * Privacy is structural: the cell is 0.25° (~25 km), carries no user id, and
 * the announce payload is the cell alone. A boat's precise position never
 * leaves the phone through this path.
 */
import { supabase } from '../supabase';
import { withTimeout } from '../../utils/deadline';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('wxPublished');

/** SW-corner 0.25° cell, ×100 — '-2725_15300' for (-27.21, 153.06). */
export function cellIdFor(lat: number, lon: number): string {
    const snap = (v: number) => Math.round(Math.floor(v / 0.25) * 25); // ×100 of the 0.25° floor
    return `${snap(lat)}_${snap(lon)}`;
}

const ANNOUNCE_KEY = 'thalassa_wx_cell_announced_v1';
const ANNOUNCE_REFRESH_MS = 6 * 3_600_000;

/**
 * Tell the publisher a boat is in this cell. Change-detected: writes only when
 * the cell differs from the last announced one or 6 h have passed, so a boat
 * at anchor costs ~4 tiny upserts a day. Fire-and-forget by design — weather
 * fetching must never wait on, or fail because of, the announcement.
 */
export function announceCell(lat: number, lon: number): void {
    if (!supabase) return;
    try {
        const cell = cellIdFor(lat, lon);
        const prev = JSON.parse(localStorage.getItem(ANNOUNCE_KEY) || 'null') as {
            cell: string;
            at: number;
        } | null;
        if (prev && prev.cell === cell && Date.now() - prev.at < ANNOUNCE_REFRESH_MS) return;
        localStorage.setItem(ANNOUNCE_KEY, JSON.stringify({ cell, at: Date.now() }));
        void supabase
            .from('wx_subscriptions')
            .upsert({ cell_id: cell, last_seen_at: new Date().toISOString() }, { onConflict: 'cell_id' })
            .then(({ error }) => {
                if (error) log.warn('cell announce failed:', error.message);
            });
    } catch {
        /* storage or serialisation trouble — the next fetch retries */
    }
}

/** A run older than this is not worth preferring over a live API call. The
 *  staleness pill still shows the true age of whatever is displayed. */
const MAX_PUBLISHED_AGE_MS = 24 * 3_600_000;
/** One indexed PK read — if Supabase cannot answer this fast, the live proxy
 *  path will beat it anyway, so stop waiting and let it. */
const READ_BUDGET_MS = 2_500;

export interface PublishedForecast {
    payload: unknown; // Open-Meteo-response-shaped; parsed by the existing parser
    runAt: string;
}

/** The published forecast for this cell+model, or null (absent, stale, slow,
 *  or unreachable — all equivalent to the caller: fall through to the proxy). */
export async function fetchPublishedForecast(
    lat: number,
    lon: number,
    model: string,
): Promise<PublishedForecast | null> {
    if (!supabase) return null;
    try {
        const result = await withTimeout(
            supabase
                .from('wx_point_forecasts')
                .select('payload, run_at')
                .eq('cell_id', cellIdFor(lat, lon))
                .eq('model', model)
                .maybeSingle()
                .then((r) => r) as Promise<{
                data: { payload: unknown; run_at: string } | null;
                error: unknown;
            } | null>,
            null,
            READ_BUDGET_MS,
        );
        if (!result || result.error || !result.data) return null;
        const age = Date.now() - Date.parse(result.data.run_at);
        if (!Number.isFinite(age) || age > MAX_PUBLISHED_AGE_MS) return null;
        return { payload: result.data.payload, runAt: result.data.run_at };
    } catch (e) {
        log.warn('published forecast read failed:', (e as Error)?.message || e);
        return null;
    }
}

const modelsCache = new Map<string, { models: string[]; at: number }>();
const MODELS_CACHE_MS = 30 * 60_000;

/**
 * Which models the publisher has rows for in this cell — drives the model
 * picker, so Spitfire appears exactly where its domain has data and a model
 * the publisher dropped stops being offered. Empty array = publisher not
 * live for this cell (the picker falls back to its built-in list).
 */
export async function listPublishedModels(lat: number, lon: number): Promise<string[]> {
    if (!supabase) return [];
    const cell = cellIdFor(lat, lon);
    const hit = modelsCache.get(cell);
    if (hit && Date.now() - hit.at < MODELS_CACHE_MS) return hit.models;
    try {
        const result = await withTimeout(
            supabase
                .from('wx_point_forecasts')
                .select('model, run_at')
                .eq('cell_id', cell)
                .then((r) => r) as Promise<{ data: { model: string; run_at: string }[] | null; error: unknown } | null>,
            null,
            READ_BUDGET_MS,
        );
        if (!result || result.error || !result.data) return hit?.models ?? [];
        const fresh = result.data
            .filter((r) => Date.now() - Date.parse(r.run_at) <= MAX_PUBLISHED_AGE_MS)
            .map((r) => r.model);
        modelsCache.set(cell, { models: fresh, at: Date.now() });
        return fresh;
    } catch {
        return hit?.models ?? [];
    }
}
