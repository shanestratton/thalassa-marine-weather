/**
 * localNotices — curated LOCAL / state-level Notices to Mariners.
 *
 * The broadcast aggregator (services/NoticeToMarinersService.ts — NGA, AMSA
 * NAVAREA X, UKHO, LINZ) carries ocean/coastal SafetyNET warnings, but NOT
 * state-authority standing notices like Maritime Safety Queensland's
 * recurring Mooloolah River bar notices (shoaling/dredging — NtM 501 of 2025
 * and a long line of predecessors). Those live here: a hand-curated bundled
 * JSON (`public/notices/notices-au.json`) with an AREA of effect per notice,
 * shipped with the app so it works offline. Supabase-remote merge is phase 2.
 *
 * Doctrine: notices are ADVISORY overlays — they never touch routing geometry
 * or cost. A notice is something the skipper reads, not something the engine
 * steers around. ONE guarded exception lives in services/ntmRouting.ts:
 * hand-curated survey zones from a SPECIFIC notice, injected only while that
 * notice is verifiably current AND the skipper has explicitly acknowledged it
 * — see that module's header for the full guard stack.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('localNotices');

export interface LocalNotice {
    id: string;
    title: string;
    /** bar | dredging | hazard | works | event | general */
    category: string;
    /** Standing notice (the Mooloolah bar class) vs dated/temporary. */
    permanent?: boolean;
    lat: number;
    lon: number;
    /** Area of effect — a route passing within this is "affected". */
    radiusM: number;
    summary: string;
    detail: string;
    sourceUrl?: string;
    sourceName?: string;
    /** ISO date for dated notices. */
    issued?: string;
}

let cache: LocalNotice[] | null = null;
let inflight: Promise<LocalNotice[]> | null = null;

/** Load the bundled local notice set (cached for the session). Fail-quiet: []. */
export async function loadLocalNotices(): Promise<LocalNotice[]> {
    if (cache) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const res = await fetch('/notices/notices-au.json');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { notices?: LocalNotice[] };
            cache = (data.notices ?? []).filter(
                (n) => Number.isFinite(n.lat) && Number.isFinite(n.lon) && Number.isFinite(n.radiusM),
            );
            log.warn(`[ntm-local] loaded ${cache.length} curated notice(s)`);
            return cache;
        } catch (err) {
            log.warn(`[ntm-local] curated notices unavailable: ${err instanceof Error ? err.message : String(err)}`);
            cache = [];
            return cache;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Min distance (m) from a point to a polyline of [lon, lat] tuples. */
export function pointToPolylineM(lat: number, lon: number, polyline: ReadonlyArray<readonly [number, number]>): number {
    const mx = mPerDegLon(lat);
    let best = Infinity;
    for (let i = 0; i + 1 < polyline.length; i++) {
        const ax = (polyline[i][0] - lon) * mx;
        const ay = (polyline[i][1] - lat) * M_PER_DEG_LAT;
        const bx = (polyline[i + 1][0] - lon) * mx;
        const by = (polyline[i + 1][1] - lat) * M_PER_DEG_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) best = d;
    }
    return best;
}

/** Local notices whose area of effect the route passes through (+ extra buffer). */
export function localNoticesNearPolyline(
    notices: readonly LocalNotice[],
    polyline: ReadonlyArray<readonly [number, number]>,
    extraBufferM = 0,
): LocalNotice[] {
    if (polyline.length < 2) return [];
    return notices.filter((n) => pointToPolylineM(n.lat, n.lon, polyline) <= n.radiusM + extraBufferM);
}
