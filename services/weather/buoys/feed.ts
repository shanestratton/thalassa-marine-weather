/**
 * The nearest wave buoy, worldwide (build 123, W1-11).
 *
 * One question: "is there a buoy within 50 NM that measured the sea in the
 * last 3 h, and what did it say?" Networks are providers (./providers); this
 * file only decides which to ask, caches their answers for 10 min, applies the
 * shared QC (./qc) and picks the nearest good reading.
 *
 * Honest by construction:
 *  - a tap no network covers fetches nothing and says no feed is read there
 *    (never "no buoy": Sydney, Marseille and Tokyo Bay have live buoys);
 *  - a covering network that failed is named ("Couldn't reach NDBC buoys"),
 *    never passed off as "no buoy";
 *  - a network the web build cannot read (no CORS) is named as app-only.
 * Coverage today: US coasts, the Caribbean, Hawaii and the Pacific islands,
 * Korea, UK waters (all via NDBC), Queensland and Ireland. Thin or none in
 * South America, Africa, the Indian Ocean and most of the South Pacific.
 */
import { Capacitor } from '@capacitor/core';
import { calculateDistance } from '../../../utils/navigationCalculations';
import { BUOY_CACHE_TTL_MS } from './net';
import { placedAndFresh, qcObservation } from './qc';
import { ndbcProvider } from './providers/ndbc';
import { qldDesProvider } from './providers/qldDes';
import { irishMiProvider } from './providers/irishMI';
import type { BuoyNetworkId, BuoyObs, BuoyProvider, BuoyUnreachable, NearestBuoyResult } from './types';

export { BUOY_CACHE_TTL_MS } from './net';
export { BUOY_MAX_AGE_MS } from './qc';

export const BUOY_RADIUS_NM = 50;
export const BUOY_PROVIDERS: readonly BuoyProvider[] = [ndbcProvider, qldDesProvider, irishMiProvider];

/** Per tap, at most this many second-look requests (NDBC spectral files, ~17 KB each). */
const MAX_SECOND_LOOKS = 2;

interface Cached<T> {
    at: number;
    value: Promise<T>;
}
const latestCache = new Map<BuoyNetworkId, Cached<BuoyObs[]>>();
const wavesCache = new Map<string, Cached<BuoyObs | null>>();

function cached<K, T>(cache: Map<K, Cached<T>>, key: K, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < BUOY_CACHE_TTL_MS) return hit.value;
    const value = load();
    cache.set(key, { at: Date.now(), value });
    // A failure is not remembered: the next tap asks again.
    value.catch(() => {
        if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
}

export function resetBuoyFeedCache(): void {
    latestCache.clear();
    wavesCache.clear();
}

/** The map hands back world-copy longitudes (e.g. 201.8) after an antimeridian pan. */
const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

function covers(provider: BuoyProvider, lat: number, lon: number, radiusNm: number): boolean {
    const padLat = radiusNm / 60;
    const padLon = radiusNm / (60 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    return provider.coverage.some(
        ([south, west, north, east]) =>
            lat >= south - padLat && lat <= north + padLat && lon >= west - padLon && lon <= east + padLon,
    );
}

/**
 * Per station: its newest row that passes QC, or — when its newest row is
 * placed and fresh but carries no wave height at all — that row as a
 * candidate for a second look.
 */
function sortStations(rows: BuoyObs[], nowMs: number): { good: BuoyObs[]; waveless: BuoyObs[] } {
    const byStation = new Map<string, BuoyObs[]>();
    for (const row of rows) {
        const list = byStation.get(row.key);
        if (list) list.push(row);
        else byStation.set(row.key, [row]);
    }
    const good: BuoyObs[] = [];
    const waveless: BuoyObs[] = [];
    for (const list of byStation.values()) {
        list.sort((a, b) => b.time - a.time);
        const passed = list.map((row) => qcObservation(row, nowMs)).find((row) => row !== null);
        if (passed) good.push(passed);
        else if (list[0].hsM === null && placedAndFresh(list[0], nowMs)) waveless.push(list[0]);
    }
    return { good, waveless };
}

function nearestWithin(
    lat: number,
    lon: number,
    radiusNm: number,
    list: BuoyObs[],
): { obs: BuoyObs; distanceNm: number } | null {
    let best: { obs: BuoyObs; distanceNm: number } | null = null;
    for (const obs of list) {
        const distanceNm = calculateDistance(lat, lon, obs.lat, obs.lon);
        if (distanceNm <= radiusNm && (best === null || distanceNm < best.distanceNm)) best = { obs, distanceNm };
    }
    return best;
}

const providerFor = (id: BuoyNetworkId): BuoyProvider | undefined => BUOY_PROVIDERS.find((p) => p.id === id);

/**
 * One network's current good readings, newest per station — for callers that
 * already know which station they want (beaconService). Rejects when the
 * network cannot be reached.
 */
export async function getFreshNetworkObs(network: BuoyNetworkId): Promise<BuoyObs[]> {
    const provider = providerFor(network);
    if (!provider) return [];
    const rows = await cached(latestCache, provider.id, () => provider.fetchLatest());
    return sortStations(rows, Date.now()).good;
}

export async function findNearestWaveBuoy(
    lat: number,
    lonIn: number,
    opts: { radiusNm?: number } = {},
): Promise<NearestBuoyResult> {
    const radiusNm = opts.radiusNm ?? BUOY_RADIUS_NM;
    const lon = wrapLon(lonIn);
    const nowMs = Date.now();
    const native = Capacitor.isNativePlatform();
    const unreachable: BuoyUnreachable[] = [];
    const relevant = BUOY_PROVIDERS.filter((p) => covers(p, lat, lon, radiusNm));

    const answers = await Promise.all(
        relevant.map(async (provider) => {
            if (provider.nativeOnly && !native) {
                unreachable.push({ network: provider.id, name: provider.name, reason: 'web' });
                return null;
            }
            try {
                const rows = await cached(latestCache, provider.id, () => provider.fetchLatest());
                return { provider, ...sortStations(rows, nowMs) };
            } catch {
                unreachable.push({ network: provider.id, name: provider.name, reason: 'failed' });
                return null;
            }
        }),
    );

    const good = answers.flatMap((answer) => answer?.good ?? []);
    let best = nearestWithin(lat, lon, radiusNm, good);

    // Only a waveless station NEARER than the best reading is worth a request,
    // and only one that could have a wave file: near a harbour the nearest
    // waveless rows are tide gauges and airports, and they must not use up the
    // slots ahead of the buoy behind them (42035 off Galveston, 2026-10-07).
    const worth = answers
        .flatMap((answer) => {
            if (!answer?.provider.fetchWaves) return [];
            const { provider } = answer;
            return answer.waveless
                .filter((station) => provider.canLookAgain?.(station) ?? true)
                .map((station) => ({
                    provider,
                    station,
                    distanceNm: calculateDistance(lat, lon, station.lat, station.lon),
                }));
        })
        .filter((look) => look.distanceNm <= radiusNm && (!best || look.distanceNm < best.distanceNm))
        .sort((a, b) => a.distanceNm - b.distanceNm)
        .slice(0, MAX_SECOND_LOOKS);
    const extra = await Promise.all(
        worth.map((look) =>
            cached(
                wavesCache,
                look.station.key,
                () => look.provider.fetchWaves?.(look.station) ?? Promise.resolve(null),
            ).catch(() => null),
        ),
    );
    const extraGood = extra.flatMap((obs) => {
        const passed = obs && qcObservation(obs, nowMs);
        return passed ? [passed] : [];
    });
    const nearer = nearestWithin(lat, lon, radiusNm, extraGood);
    if (nearer && (!best || nearer.distanceNm < best.distanceNm)) best = nearer;

    if (best) return { status: 'found', ...best };
    const order = (u: BuoyUnreachable): number => BUOY_PROVIDERS.findIndex((p) => p.id === u.network);
    return {
        status: 'none',
        radiusNm,
        unreachable: unreachable.sort((a, b) => order(a) - order(b)),
        covered: relevant.length > 0,
    };
}
