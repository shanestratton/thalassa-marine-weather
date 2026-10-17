/** Actual selected ASCAT observations; never a continuous grid or buoy truth. */
export const ASCAT_LIMITS = {
    index: 768 * 1024,
    tile: 96 * 1024,
    cohort: 64 * 1024 * 1024,
    viewportTiles: 9,
    arrows: 600,
    sessionBytes: 8 * 1024 * 1024,
} as const;
export const ASCAT_KIND = 'ascat-coastal';
export const ASCAT_DIRECTION = 'meteorological-from-degrees-true';
export const ASCAT_QC = 'manual1.17-reject-all-except-redundancy-and-speed-notices';
export const ASCAT_CREDIT =
    'Contains modified EUMETSAT OSI SAF ASCAT Coastal information; KNMI; © EUMETSAT; CC BY 4.0. Metop-B DOI 10.15770/EUM_SAF_OSI_NRT_2018; Metop-C DOI 10.15770/EUM_SAF_OSI_NRT_2019.';
export type AscatRow = readonly [
    longitude: number,
    latitude: number,
    observedAt: number,
    speedMps: number,
    fromDegrees: number,
    source: number,
];
export interface AscatSource {
    dataset: 'osisaf_ascat_b_coa' | 'osisaf_ascat_c_coa';
    version: 'nrt';
    filename: string;
    rawSha256: string;
    rawBytes: number;
    orbitStart: number;
    orbitEnd: number;
    processedAt: number;
    observedStart: number;
    observedEnd: number;
    doi: string;
}
export interface AscatTileDescriptor {
    bytes: number;
    sha256: string;
    rows: number;
    observedStart: number;
    observedEnd: number;
}
export interface AscatIndex {
    generatedAt: number;
    expiresAt: number;
    copyright: string;
    sources: readonly AscatSource[];
    tiles: Readonly<Record<string, AscatTileDescriptor>>;
}
export interface AscatPointer {
    generatedAt: number;
    expiresAt: number;
    generation: string;
    indexBytes: number;
    indexSha256: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown, low: number, high: number): v is number =>
    Number.isSafeInteger(v) && (v as number) >= low && (v as number) <= high;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const clock = (v: unknown): v is number => integer(v, 631152000, 4102444800);
const fail = (): never => {
    throw new Error('Satellite wind original data unavailable');
};
export function ascatTileKey(lon: number, lat: number): string {
    if (!finite(lon) || !finite(lat) || lon < -180 || lon >= 180 || Math.abs(lat) > 90) return fail();
    return `${Math.floor((lon + 180) / 5)}-${Math.min(35, Math.floor((lat + 90) / 5))}`;
}
const tileKey = (key: string) => /^(?:[0-9]|[1-6][0-9]|7[01])-(?:[0-9]|[12][0-9]|3[0-5])$/.test(key);
function fresh(value: Record<string, unknown>, now: number): void {
    if (
        !clock(value.generatedAt) ||
        !clock(value.expiresAt) ||
        value.generatedAt > now + 60 ||
        value.expiresAt <= now ||
        value.expiresAt <= value.generatedAt ||
        value.expiresAt > value.generatedAt + 3600
    )
        fail();
}
export function decodeAscatPointer(value: unknown, now: number): AscatPointer {
    if (
        !object(value) ||
        value.schema !== 1 ||
        value.kind !== ASCAT_KIND ||
        !hash(value.generation) ||
        value.indexSha256 !== value.generation ||
        !integer(value.indexBytes, 1, ASCAT_LIMITS.index)
    )
        return fail();
    fresh(value, now);
    return value as unknown as AscatPointer;
}
export function decodeAscatIndex(value: unknown, pointer: AscatPointer, now: number): AscatIndex {
    if (
        !object(value) ||
        value.schema !== 1 ||
        value.kind !== ASCAT_KIND ||
        value.generatedAt !== pointer.generatedAt ||
        value.expiresAt !== pointer.expiresAt ||
        value.observedHistorySeconds !== 86400 ||
        value.samplingKm !== 12.5 ||
        value.effectiveResolutionKm !== 25 ||
        value.displayCellDegrees !== 0.25 ||
        value.windBasis !== '10m-stress-equivalent' ||
        value.copyright !== `EUMETSAT ${new Date(pointer.generatedAt * 1000).getUTCFullYear()}` ||
        value.unit !== 'm s-1' ||
        value.direction !== ASCAT_DIRECTION ||
        value.qc !== ASCAT_QC ||
        value.coverage !== 'actual-swaths-with-gaps' ||
        value.forecastSkillBasis !== 'separate-satellite-agreement; no buoy-truth adoption' ||
        value.licence !== 'CC-BY-4.0' ||
        value.licenceUrl !== 'https://creativecommons.org/licenses/by/4.0/' ||
        !Array.isArray(value.sources) ||
        !integer(value.sources.length, 1, 32) ||
        !object(value.tiles) ||
        !integer(Object.keys(value.tiles).length, 1, 2592)
    )
        return fail();
    fresh(value, now);
    const generated = pointer.generatedAt,
        seen = new Set<string>();
    for (const source of value.sources) {
        if (
            !object(source) ||
            !['osisaf_ascat_b_coa', 'osisaf_ascat_c_coa'].includes(String(source.dataset)) ||
            source.version !== 'nrt' ||
            !hash(source.rawSha256) ||
            seen.has(source.rawSha256) ||
            !integer(source.rawBytes, 16, 32 * 1024 * 1024) ||
            typeof source.filename !== 'string'
        )
            return fail();
        const satellite = source.dataset === 'osisaf_ascat_b_coa' ? 'b' : 'c';
        const match = source.filename.match(
            new RegExp(
                `^ascat_(\\d{4})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})_metop${satellite}_\\d{5,6}_eps_o_coa_\\d{4,6}(?:_ovw)?\\.l2\\.nc$`,
            ),
        );
        const times = ['orbitStart', 'observedStart', 'observedEnd', 'orbitEnd', 'processedAt'].map(
            (key) => source[key],
        );
        const filenameTime = match
            ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]))
            : null;
        if (
            !match ||
            !filenameTime ||
            filenameTime.toISOString().replace(/[-:T]/g, '').slice(0, 14) !== match.slice(1, 7).join('') ||
            times.some((at) => !clock(at)) ||
            (times as number[]).some(
                (at, i) => at < generated - 86400 || at > generated || (i > 0 && at < (times[i - 1] as number)),
            ) ||
            (times[3] as number) - (times[0] as number) > 7200 ||
            Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) / 1000 !==
                source.orbitStart ||
            source.doi !== `10.15770/EUM_SAF_OSI_NRT_${satellite === 'b' ? '2018' : '2019'}`
        )
            return fail();
        seen.add(source.rawSha256);
    }
    let total = pointer.indexBytes;
    for (const [key, tile] of Object.entries(value.tiles)) {
        if (
            !tileKey(key) ||
            !object(tile) ||
            !integer(tile.bytes, 1, ASCAT_LIMITS.tile) ||
            !hash(tile.sha256) ||
            !integer(tile.rows, 1, 400) ||
            !clock(tile.observedStart) ||
            !clock(tile.observedEnd) ||
            tile.observedStart < generated - 86400 ||
            tile.observedStart > tile.observedEnd ||
            tile.observedEnd > generated
        )
            return fail();
        total += tile.bytes;
    }
    if (total > ASCAT_LIMITS.cohort) return fail();
    return {
        generatedAt: pointer.generatedAt,
        expiresAt: pointer.expiresAt,
        copyright: value.copyright as string,
        sources: value.sources as AscatSource[],
        tiles: value.tiles as Record<string, AscatTileDescriptor>,
    };
}
export function decodeAscatTile(value: unknown, key: string, index: AscatIndex, now: number): readonly AscatRow[] {
    if (now >= index.expiresAt || now < index.generatedAt - 60) return fail();
    const descriptor = index.tiles[key];
    if (
        !descriptor ||
        !object(value) ||
        value.schema !== 1 ||
        value.kind !== ASCAT_KIND ||
        value.tile !== key ||
        !Array.isArray(value.rows) ||
        value.rows.length !== descriptor.rows
    )
        return fail();
    const seen = new Set<string>();
    let start = Infinity,
        end = -Infinity;
    for (const row of value.rows) {
        if (
            !Array.isArray(row) ||
            row.length !== 6 ||
            !row.every(finite) ||
            !integer(row[2], index.generatedAt - 86400, index.generatedAt) ||
            !integer(row[5], 0, index.sources.length - 1) ||
            row[3] < 0 ||
            row[3] > 50 ||
            row[4] < 0 ||
            row[4] >= 360 ||
            ascatTileKey(row[0], row[1]) !== key
        )
            return fail();
        const source = index.sources[row[5]];
        const bin = `${Math.floor((row[0] + 180) * 4)},${Math.min(719, Math.floor((row[1] + 90) * 4))}`;
        if (seen.has(bin) || row[2] < source.observedStart || row[2] > source.observedEnd) return fail();
        seen.add(bin);
        start = Math.min(start, row[2]);
        end = Math.max(end, row[2]);
    }
    if (start !== descriptor.observedStart || end !== descriptor.observedEnd) return fail();
    // Later publication/download never renews the original observation.
    return value.rows.filter((row) => row[2] > now - 86400) as unknown as readonly AscatRow[];
}
/** Fixed tile selection; a wide viewport asks the skipper to zoom, never fetches the world. */
export function ascatViewportTiles(bounds: readonly [number, number, number, number]): string[] {
    const west = bounds[0];
    let south = bounds[1],
        east = bounds[2],
        north = bounds[3];
    if (
        ![west, south, east, north].every(finite) ||
        north <= south ||
        south < -90 ||
        north > 90 ||
        Math.abs(west) > 1080 ||
        Math.abs(east) > 1080
    )
        return fail();
    if (east < west) east += 360;
    if (east <= west || east - west > 15 || north - south > 15)
        throw new Error('Zoom in for satellite wind: at most nine tiles per view');
    south = Math.max(-85.05112878, south);
    north = Math.min(85.05112878, north);
    const keys = new Set<string>();
    for (let x = Math.floor((west + 180) / 5); x <= Math.floor((east + 180 - 1e-9) / 5); x++)
        for (
            let y = Math.max(0, Math.floor((south + 90) / 5));
            y <= Math.min(35, Math.floor((north + 90 - 1e-9) / 5));
            y++
        )
            keys.add(`${((x % 72) + 72) % 72}-${y}`);
    if (!keys.size || keys.size > ASCAT_LIMITS.viewportTiles)
        throw new Error('Zoom in for satellite wind: at most nine tiles per view');
    return [...keys].sort();
}
