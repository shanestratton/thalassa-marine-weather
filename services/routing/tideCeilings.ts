/**
 * The highest tide per place, loaded BEFORE a route is computed (owner
 * decision 11, Shane 2026-10-01: "ok avoid water no tide can clear").
 *
 * The router makes water no tide clears for the boat impassable
 * (services/engine/tideCeiling), so it needs the highest tide the app knows
 * wherever the route might go — not only where the finished route's shallow
 * runs turn out to be, which is where the tide chips fetch their curves
 * afterwards (components/map/tideWindowChips annotateTideWindows). This loads
 * the same curves, one per 0.25° bucket of the tide cache, over the same
 * 14 days and the same departure window, so the chips that follow read them
 * from the cache (TideHeightService fetchTideCurve).
 *
 * Which buckets: those the router's grid can reach (its bbox, padded as
 * routeInshoreOnceEnds pads it), nearest the straight line first, at most
 * ROUTE_TIDE_CURVES_MAX — the chips' own budget (fix-up, 2026-10-01: 9 of
 * its own, each at a spot that moved with every route, missed the Pi's cache
 * every time and spent the public tide proxy's 12 an hour). Each is fetched
 * at its bucket's centre (fetchTideCurve, opts.days), so every route and
 * every chip over the same water shares one curve and one cache entry. A
 * bucket past the cap, or whose fetch fails, gets no ceiling: nothing is
 * proved there, and where the finished route crosses water a tide must clear
 * in such a place it says so (InshoreRouteResult.tideCheck).
 *
 * The top is read from the later of now and the departure on
 * (services/tides/curveHighest, fix-up 2026-10-01): never a tide that has
 * already happened.
 *
 * Offline tidal planes: the app carries none (searched 2026-10-01 — no HAT,
 * MHWS or tidal-plane table is bundled, and the ENC cells carry none); the
 * only offline source is the Pi's tide cache, which fetchTideCurve already
 * reads first.
 */
import { fetchTideCurve, TIDE_CURVE_MAX_DAYS, type TideCurve } from '../TideHeightService';
import { curveHighestM, curveSpanDays, ROUTE_TIDE_CURVES_MAX, TIDE_WINDOW_HORIZON_MS } from '../tides/curveHighest';
import { tideBucketStep } from '../engine/tideCeiling';
import type { TideCeiling } from '../engine/types';
import { withTimeout } from '../../utils/deadline';

/** Per curve: a stalled fetch costs the route this much, never more. */
const CEILING_FETCH_TIMEOUT_MS = 8_000;

interface LatLon {
    lat: number;
    lon: number;
}

/**
 * The buckets to load for a route (pure): each 0.25° bucket the router's
 * grid bbox touches, as its centre (where its curve is fetched), nearest the
 * straight line first, at most `max`.
 */
export function routeAreaTideBuckets(from: LatLon, to: LatLon, max = ROUTE_TIDE_CURVES_MAX): LatLon[] {
    if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) return [];
    const minLat = Math.min(from.lat, to.lat);
    const maxLat = Math.max(from.lat, to.lat);
    const minLon = Math.min(from.lon, to.lon);
    const maxLon = Math.max(from.lon, to.lon);
    // routeInshoreOnceEnds' own padding.
    const pad = Math.max(Math.max(maxLat - minLat, maxLon - minLon) * 0.5, 0.08);
    const [r0, c0] = tideBucketStep(minLat - pad, minLon - pad);
    const [r1, c1] = tideBucketStep(maxLat + pad, maxLon + pad);
    const out: { centre: LatLon; d: number }[] = [];
    const kx = Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
    const dx = (to.lon - from.lon) * kx;
    const dy = to.lat - from.lat;
    const len2 = dx * dx + dy * dy;
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const centre = { lat: r / 4, lon: c / 4 };
            // How far the bucket lies from the from→to line: from the point
            // of the line nearest its centre, to the nearest point of the
            // bucket (0 when the line runs through it).
            const t =
                len2 === 0
                    ? 0
                    : Math.max(
                          0,
                          Math.min(1, ((centre.lon - from.lon) * kx * dx + (centre.lat - from.lat) * dy) / len2),
                      );
            const onLine = { lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t };
            const clamp = (v: number, mid: number): number => Math.max(mid - 0.125, Math.min(mid + 0.125, v));
            const near = { lat: clamp(onLine.lat, centre.lat), lon: clamp(onLine.lon, centre.lon) };
            const d = Math.hypot((near.lon - onLine.lon) * kx, near.lat - onLine.lat);
            out.push({ centre, d });
        }
    }
    return out
        .sort((a, b) => a.d - b.d)
        .slice(0, Math.max(0, max))
        .map((b) => b.centre);
}

/** What was loaded: the ceilings, and how many buckets were asked for. */
export interface RouteTideCeilings {
    ceilings: TideCeiling[];
    asked: number;
}

/**
 * Load the highest tide per place for a route (decision 11). Never throws;
 * a bucket whose curve is missing, times out or yields nothing is left out.
 * `nowMs` is the clock the top is read from (with the departure); a test's.
 */
export async function routeAreaTideCeilings(
    from: LatLon,
    to: LatLon,
    departureMs: number,
    fetchCurve: (lat: number, lon: number, startMs: number, endMs: number) => Promise<TideCurve | null> = (
        lat,
        lon,
        startMs,
        endMs,
    ) => fetchTideCurve(lat, lon, startMs, endMs, { days: TIDE_CURVE_MAX_DAYS }),
    nowMs: number = Date.now(),
): Promise<RouteTideCeilings> {
    const spots = routeAreaTideBuckets(from, to);
    const start = Number.isFinite(departureMs) ? departureMs : nowMs;
    const fromMs = Math.max(nowMs, start);
    const curves = await Promise.all(
        spots.map((s) =>
            withTimeout(
                fetchCurve(s.lat, s.lon, start, start + TIDE_WINDOW_HORIZON_MS).catch(() => null),
                null,
                CEILING_FETCH_TIMEOUT_MS,
            ),
        ),
    );
    const ceilings: TideCeiling[] = [];
    curves.forEach((curve, k) => {
        if (!curve) return;
        const highestM = curveHighestM(curve, fromMs);
        if (highestM === null) return;
        ceilings.push({ lat: spots[k].lat, lon: spots[k].lon, highestM, days: curveSpanDays(curve, fromMs) });
    });
    return { ceilings, asked: spots.length };
}
