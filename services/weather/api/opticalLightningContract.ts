/** Cloud optical flash centroids only. Never a network pulse, strike type or alert authority. */
export const OPTICAL_WARNING =
    'Satellite optical flashes; cloud centroids, not ground-strike positions. Gaps never mean clear conditions. No lightning alerts use this layer.';
export const OPTICAL_LIMITS = {
    index: 192 * 1024,
    tile: 32 * 1024,
    tiles: 256,
    sources: 32,
    viewport: 9,
    points: 600,
    session: 768 * 1024,
    age: 300000,
} as const;
export interface OpticalSource {
    provider: 'noaa-glm' | 'eumetsat-li';
    product: 'GLM-L2-LCFA' | 'LI-2-LFL';
    platform: 'GOES-18' | 'GOES-19' | 'MTI1';
    rawSha256: string;
    rawBytes: number;
    observedStart: number;
    observedEnd: number;
    processedAt: number;
    receivedAt: number;
    qc: 'glm-quality-zero' | 'li-confidence-zero-unwarned';
    licence: 'NOAA-NODD' | 'EUMETSAT-Core';
}
export interface OpticalIndex {
    generatedAt: number;
    expiresAt: number;
    truncated: boolean;
    sources: readonly OpticalSource[];
    tiles: Readonly<Record<string, { bytes: number; sha256: string; rows: number }>>;
}
export type OpticalFlash = readonly [
    longitude: number,
    latitude: number,
    firstAt: number,
    lastAt: number,
    source: number,
    id: string,
];
export const opticalRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
export const opticalHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const fail = (): never => {
    throw Error('Qualified satellite optical observations unavailable');
};
const exact = (v: Record<string, unknown>, keys: string) =>
    Object.keys(v).sort().join(',') === keys.split(' ').sort().join(',');
export function opticalTile(lon: number, lat: number): string {
    return `${Math.floor((lon + 180) / 5)}-${Math.min(35, Math.floor((lat + 90) / 5))}`;
}
export function opticalTileKey(v: string): boolean {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
    return !!m && Number(m[1]) < 72 && Number(m[2]) < 36 && `${Number(m[1])}-${Number(m[2])}` === v;
}
export function decodeOpticalPointer(v: unknown, now: number) {
    if (
        !opticalRecord(v) ||
        !exact(v, 'schema kind generation indexBytes generatedAt expiresAt') ||
        v.schema !== 1 ||
        v.kind !== 'optical-flashes-v1' ||
        !opticalHash(v.generation) ||
        !integer(v.indexBytes) ||
        v.indexBytes < 1 ||
        v.indexBytes > OPTICAL_LIMITS.index ||
        !integer(v.generatedAt) ||
        !integer(v.expiresAt) ||
        !(v.generatedAt <= now && now < v.expiresAt && v.expiresAt <= v.generatedAt + 60000)
    )
        return fail();
    return { generation: v.generation, indexBytes: v.indexBytes, generatedAt: v.generatedAt, expiresAt: v.expiresAt };
}
export function decodeOpticalIndex(
    v: unknown,
    pointer: ReturnType<typeof decodeOpticalPointer>,
    now: number,
): OpticalIndex {
    if (
        !opticalRecord(v) ||
        !exact(v, 'schema kind generatedAt expiresAt representation coverage admission truncated sources tiles') ||
        v.schema !== 1 ||
        v.kind !== 'optical-flashes-v1' ||
        v.representation !== 'optical-flash-centroids' ||
        v.coverage !== 'original-observation-windows-with-gaps' ||
        v.admission !== 'reviewed-original-profile-v1' ||
        typeof v.truncated !== 'boolean' ||
        v.generatedAt !== pointer.generatedAt ||
        v.expiresAt !== pointer.expiresAt ||
        !(pointer.generatedAt <= now && now < pointer.expiresAt) ||
        !Array.isArray(v.sources) ||
        !v.sources.length ||
        v.sources.length > OPTICAL_LIMITS.sources ||
        !opticalRecord(v.tiles) ||
        Object.keys(v.tiles).length > OPTICAL_LIMITS.tiles
    )
        return fail();
    const hashes = new Set<string>();
    let originals = 0;
    for (const s of v.sources) {
        if (
            !opticalRecord(s) ||
            !exact(
                s,
                'provider product platform rawSha256 rawBytes observedStart observedEnd processedAt receivedAt qc licence',
            ) ||
            !opticalHash(s.rawSha256) ||
            hashes.has(s.rawSha256) ||
            !integer(s.rawBytes) ||
            s.rawBytes < 16 ||
            s.rawBytes > 8 * 1024 * 1024 ||
            ![s.observedStart, s.observedEnd, s.processedAt, s.receivedAt].every(integer)
        )
            return fail();
        const start = s.observedStart as number,
            end = s.observedEnd as number,
            processed = s.processedAt as number,
            received = s.receivedAt as number;
        if (
            !(
                now - OPTICAL_LIMITS.age <= end &&
                start <= end &&
                end - start <= 600000 &&
                end <= processed &&
                processed <= received &&
                received <= pointer.generatedAt &&
                pointer.expiresAt <= end + OPTICAL_LIMITS.age
            )
        )
            return fail();
        const glm =
            s.provider === 'noaa-glm' &&
            s.product === 'GLM-L2-LCFA' &&
            (s.platform === 'GOES-18' || s.platform === 'GOES-19') &&
            s.qc === 'glm-quality-zero' &&
            s.licence === 'NOAA-NODD';
        const li =
            s.provider === 'eumetsat-li' &&
            s.product === 'LI-2-LFL' &&
            s.platform === 'MTI1' &&
            s.qc === 'li-confidence-zero-unwarned' &&
            s.licence === 'EUMETSAT-Core';
        if (!glm && !li) return fail();
        originals += s.rawBytes;
        if (originals > 64 * 1024 * 1024) return fail();
        hashes.add(s.rawSha256);
    }
    let bytes = pointer.indexBytes + 1024;
    for (const [key, e] of Object.entries(v.tiles)) {
        if (
            !opticalTileKey(key) ||
            !opticalRecord(e) ||
            !exact(e, 'bytes sha256 rows') ||
            !integer(e.bytes) ||
            e.bytes < 1 ||
            e.bytes > OPTICAL_LIMITS.tile ||
            !opticalHash(e.sha256) ||
            !integer(e.rows) ||
            e.rows < 1 ||
            e.rows > 200
        )
            return fail();
        bytes += e.bytes;
        if (bytes > 4 * 1024 * 1024) return fail();
    }
    return v as unknown as OpticalIndex;
}
export function decodeOpticalTile(v: unknown, key: string, index: OpticalIndex, now: number): OpticalFlash[] {
    if (
        !opticalRecord(v) ||
        !exact(v, 'schema kind tile rows') ||
        v.schema !== 1 ||
        v.kind !== 'optical-flashes-v1' ||
        v.tile !== key ||
        !Array.isArray(v.rows) ||
        v.rows.length !== index.tiles[key]?.rows ||
        v.rows.length > 200
    )
        return fail();
    const seen = new Set<string>(),
        rows: OpticalFlash[] = [];
    for (const row of v.rows) {
        if (
            !Array.isArray(row) ||
            row.length !== 6 ||
            !row.slice(0, 4).every(finite) ||
            !integer(row[2]) ||
            !integer(row[3]) ||
            !integer(row[4]) ||
            typeof row[5] !== 'string' ||
            !/^\d{1,10}$/.test(row[5]) ||
            Number(row[5]) > 4294967295 ||
            String(Number(row[5])) !== row[5] ||
            !(-180 <= row[0] && row[0] < 180 && -90 <= row[1] && row[1] <= 90) ||
            opticalTile(row[0], row[1]) !== key ||
            row[2] > row[3] ||
            row[3] - row[2] > 20000
        )
            return fail();
        const source = index.sources[row[4]],
            id = `${row[4]}:${row[5]}`;
        if (!source || row[2] < source.observedStart || row[3] > source.observedEnd || row[3] > now || seen.has(id))
            return fail();
        seen.add(id);
        if (row[2] >= now - OPTICAL_LIMITS.age) rows.push(row as unknown as OpticalFlash);
    }
    return rows;
}
export function opticalViewportTiles(bounds: readonly [number, number, number, number]): string[] {
    const west = bounds[0];
    let [, south, east, north] = bounds;
    if (
        !bounds.every(finite) ||
        south >= north ||
        south < -90 ||
        north > 90 ||
        Math.abs(west) > 1080 ||
        Math.abs(east) > 1080
    )
        return fail();
    if (east < west) east += 360;
    if (east <= west || east - west > 15 || north - south > 15) throw Error('Zoom in for satellite optical flashes');
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
    if (!keys.size || keys.size > OPTICAL_LIMITS.viewport) throw Error('Zoom in for satellite optical flashes');
    return [...keys].sort();
}
