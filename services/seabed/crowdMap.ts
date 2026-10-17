/** Public display tiles only. This module is never imported by route/depth/watch code. */
import { assertNetworkAllowed } from '../networkPolicy';
import { decodeUtf8Json, readBoundedResponse, sha256Hex } from '../weather/api/cmemsGridTrust';

export const CROWD_MAP_LABEL = 'Crowd soundings · unverified · not for navigation';
const BASE = 'https://tiles.thalassatiles.com/crowd/v1/';
const KIND = 'thalassa-crowd-soundings-v1';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown, lo: number, hi: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const fail = (): never => {
    throw Error('Qualified crowd soundings are unavailable');
};
export interface CrowdMapIndex {
    generatedAt: number;
    expiresAt: number;
    generation: string;
    utcDayRange: readonly [number, number];
    datums: readonly { id: string; hydroRegion: string }[];
    tiles: Readonly<Record<string, { sha256: string; bytes: number }>>;
}
export function decodeCrowdIndex(value: unknown, generation: string, now: number): CrowdMapIndex {
    if (
        !object(value) ||
        !hash(generation) ||
        value.schema !== 1 ||
        value.kind !== KIND ||
        value.label !== CROWD_MAP_LABEL ||
        value.licence !== 'CC0-1.0' ||
        value.licenceUrl !== 'https://creativecommons.org/publicdomain/zero/1.0/' ||
        value.coverage !== 'qualified-historical-cells-with-gaps' ||
        value.contourIntervalM !== 0.5 ||
        value.projectedGridMetres !== 100 ||
        value.minimumUncertaintyM !== 1 ||
        value.minimumIndependentBoats !== 3 ||
        value.minimumIndependentOwners !== 3 ||
        value.minimumUtcDays !== 3 ||
        value.navigationAuthority !== false ||
        !Number.isSafeInteger(value.generatedAt) ||
        !Number.isSafeInteger(value.expiresAt) ||
        !(
            (value.generatedAt as number) <= now &&
            now < (value.expiresAt as number) &&
            (value.expiresAt as number) <= (value.generatedAt as number) + 3600000
        ) ||
        !Array.isArray(value.utcDayRange) ||
        value.utcDayRange.length !== 2 ||
        !value.utcDayRange.every(Number.isSafeInteger) ||
        !(
            18262 <= value.utcDayRange[0] &&
            value.utcDayRange[0] <= value.utcDayRange[1] &&
            value.utcDayRange[1] <= Math.floor(now / 86400000)
        ) ||
        !Number.isSafeInteger(value.sourceCount) ||
        !number(value.sourceCount, 3, 32) ||
        !object(value.tiles) ||
        !Array.isArray(value.datums) ||
        !value.datums.length ||
        value.datums.length > 8
    )
        return fail();
    const allowed = [
        'schema',
        'kind',
        'label',
        'generatedAt',
        'expiresAt',
        'licence',
        'licenceUrl',
        'coverage',
        'contourIntervalM',
        'projectedGridMetres',
        'minimumUncertaintyM',
        'minimumIndependentBoats',
        'minimumIndependentOwners',
        'minimumUtcDays',
        'navigationAuthority',
        'utcDayRange',
        'sourceCount',
        'datums',
        'tiles',
    ];
    if (Object.keys(value).length !== allowed.length || Object.keys(value).some((k) => !allowed.includes(k)))
        return fail();
    const datums = value.datums.map((d) => {
        if (
            !object(d) ||
            Object.keys(d).length !== 2 ||
            !['id', 'hydroRegion'].every((k) => typeof d[k] === 'string' && d[k].length > 0 && d[k].length <= 120)
        )
            return fail();
        return { id: d.id as string, hydroRegion: d.hydroRegion as string };
    });
    const tiles: Record<string, { sha256: string; bytes: number }> = {};
    if (!Object.keys(value.tiles).length || Object.keys(value.tiles).length > 64) return fail();
    let total = 0;
    for (const [key, v] of Object.entries(value.tiles)) {
        const match = /^(\d{1,3})-(\d{1,3})$/.exec(key);
        if (
            !match ||
            String(Number(match[1])) !== match[1] ||
            String(Number(match[2])) !== match[2] ||
            +match[1] >= 360 ||
            +match[2] >= 180 ||
            !object(v) ||
            Object.keys(v).length !== 2 ||
            !hash(v.sha256) ||
            !Number.isSafeInteger(v.bytes) ||
            !number(v.bytes, 1, 98304)
        )
            return fail();
        total += v.bytes;
        if (total > 8 * 1024 ** 2) return fail();
        tiles[key] = { sha256: v.sha256, bytes: v.bytes };
    }
    return {
        generatedAt: value.generatedAt as number,
        expiresAt: value.expiresAt as number,
        generation,
        utcDayRange: value.utcDayRange as [number, number],
        datums,
        tiles,
    };
}
export function decodeCrowdTile(
    value: unknown,
    index: CrowdMapIndex,
    tile: string,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    if (
        !object(value) ||
        Object.keys(value).length !== 2 ||
        value.type !== 'FeatureCollection' ||
        !Array.isArray(value.features) ||
        !value.features.length ||
        value.features.length > 256
    )
        return fail();
    const features = value.features.map((f): GeoJSON.Feature<GeoJSON.LineString> => {
        if (
            !object(f) ||
            Object.keys(f).length !== 3 ||
            f.type !== 'Feature' ||
            !object(f.geometry) ||
            Object.keys(f.geometry).length !== 2 ||
            f.geometry.type !== 'LineString' ||
            !Array.isArray(f.geometry.coordinates) ||
            f.geometry.coordinates.length !== 2 ||
            !object(f.properties)
        )
            return fail();
        const coordinates = f.geometry.coordinates.map((v) => {
            if (!Array.isArray(v) || v.length !== 2 || !number(v[0], -180, 180) || !number(v[1], -80, 80))
                return fail();
            return [v[0], v[1]];
        });
        const p = f.properties,
            keys = [
                'depthM',
                'datumId',
                'hydroRegion',
                'uncertaintyM',
                'independentBoats',
                'utcDays',
                'contourIntervalM',
                'label',
                'navigationAuthority',
            ];
        if (
            Object.keys(p).length !== keys.length ||
            Object.keys(p).some((k) => !keys.includes(k)) ||
            p.label !== CROWD_MAP_LABEL ||
            p.navigationAuthority !== false ||
            p.contourIntervalM !== 0.5 ||
            !number(p.depthM, 0.5, 200) ||
            p.depthM * 2 !== Math.floor(p.depthM * 2) ||
            !number(p.uncertaintyM, 1, 3) ||
            !['independentBoats', 'utcDays'].every((k) => Number.isSafeInteger(p[k]) && number(p[k], 3, 32)) ||
            !index.datums.some((d) => d.id === p.datumId && d.hydroRegion === p.hydroRegion) ||
            Math.abs(coordinates[0][0] - coordinates[1][0]) > 0.02 ||
            Math.abs(coordinates[0][1] - coordinates[1][1]) > 0.002 ||
            !coordinates.some(
                (v) => `${Math.min(359, Math.floor(v[0] + 180))}-${Math.min(179, Math.floor(v[1] + 90))}` === tile,
            )
        )
            return fail();
        return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { ...p } };
    });
    return { type: 'FeatureCollection', features };
}
export function crowdViewportTiles(bounds: readonly [number, number, number, number]): string[] {
    const [west, south, east, north] = bounds;
    if (
        !bounds.every(Number.isFinite) ||
        !(-180 <= west && west < east && east <= 180 && -80 <= south && south < north && north <= 80) ||
        east - west > 3 ||
        north - south > 3
    )
        return fail();
    const keys = [];
    for (let x = Math.floor(west + 180); x <= Math.min(359, Math.floor(east + 180)); x++)
        for (let y = Math.floor(south + 90); y <= Math.min(179, Math.floor(north + 90)); y++) keys.push(`${x}-${y}`);
    if (keys.length > 9) return fail();
    return keys;
}
let outstanding = 0;
/** One viewport lease; no storage, global tile cache, route adoption or default requests. */
export async function readCrowdViewport(
    bounds: readonly [number, number, number, number],
    signal: AbortSignal,
    ownerCurrent: () => boolean,
) {
    const opened = Date.now(),
        monotonic = performance.now(),
        abort = new AbortController();
    let index: CrowdMapIndex | null = null,
        released = false,
        bytesUsed = 0;
    const retire = () => {
        released = true;
        abort.abort();
    };
    signal.addEventListener('abort', retire, { once: true });
    const current = () => {
        try {
            assertNetworkAllowed('grib', 'Crowd soundings map');
            return (
                !released &&
                !signal.aborted &&
                ownerCurrent() === true &&
                Date.now() >= opened &&
                performance.now() - monotonic < 15 * 60000 &&
                (!index || Date.now() < index.expiresAt)
            );
        } catch {
            return false;
        }
    };
    const read = async (path: string, cap: number, expected?: { sha256: string; bytes: number }) => {
        if (!current() || outstanding >= 2) return fail();
        outstanding++;
        const timer = setTimeout(retire, 10000);
        // A native fetch slot remains charged until that actual request settles.
        const work = (async () => {
            try {
                const response = await fetch(BASE + path, {
                    redirect: 'error',
                    credentials: 'omit',
                    cache: 'no-store',
                    signal: abort.signal,
                });
                if (response.status !== 200) {
                    void response.body?.cancel().catch(() => undefined);
                    return fail();
                }
                const raw = await readBoundedResponse(response, cap, abort.signal);
                bytesUsed += raw.byteLength;
                if (
                    !current() ||
                    bytesUsed > 1200000 ||
                    (expected && (raw.byteLength !== expected.bytes || (await sha256Hex(raw)) !== expected.sha256))
                )
                    return fail();
                return decodeUtf8Json(raw);
            } finally {
                outstanding--;
                clearTimeout(timer);
            }
        })();
        let stop: (() => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => {
            stop = () => reject(new DOMException('Crowd source retired', 'AbortError'));
            abort.signal.addEventListener('abort', stop, { once: true });
            if (abort.signal.aborted) stop();
        });
        try {
            return await Promise.race([work, cancelled]);
        } finally {
            if (stop) abort.signal.removeEventListener('abort', stop);
        }
    };
    try {
        const keys = crowdViewportTiles(bounds);
        const p = await read('latest.json', 1024);
        if (
            !object(p) ||
            Object.keys(p).length !== 7 ||
            p.schema !== 1 ||
            p.kind !== KIND ||
            !hash(p.generation) ||
            p.indexSha256 !== p.generation ||
            !Number.isSafeInteger(p.indexBytes) ||
            !number(p.indexBytes, 1, 262144)
        )
            return fail();
        const generation = p.generation;
        index = decodeCrowdIndex(
            await read(`generations/${generation}/index.json`, 262144, { sha256: generation, bytes: p.indexBytes }),
            generation,
            Date.now(),
        );
        if (p.generatedAt !== index.generatedAt || p.expiresAt !== index.expiresAt) return fail();
        const features: GeoJSON.Feature<GeoJSON.LineString>[] = [],
            seen = new Set<string>();
        for (const key of keys) {
            const entry = index.tiles[key];
            if (!entry) continue;
            const tile = decodeCrowdTile(
                await read(`generations/${generation}/tile-${key}.json`, 98304, entry),
                index,
                key,
            );
            for (const f of tile.features) {
                const identity = JSON.stringify(f);
                if (seen.has(identity)) continue;
                seen.add(identity);
                features.push(f);
                if (features.length > 512) return fail();
            }
        }
        if (!current()) return fail();
        return {
            index,
            data: { type: 'FeatureCollection' as const, features },
            isCurrent: current,
            release: () => {
                retire();
                signal.removeEventListener('abort', retire);
            },
        };
    } catch (error) {
        retire();
        signal.removeEventListener('abort', retire);
        throw error;
    }
}
