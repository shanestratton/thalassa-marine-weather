/**
 * Which cells to open before anyone asks (127-C-d decision 7): those within a
 * radius of the boat's last fix, finest scale first, so the first chart the
 * skipper opens after a Pi restart is already in memory. Prewarm fills at
 * most a share of the LRU (VAULT_LIMITS.prewarmShare) and runs behind every
 * phone request. The fix comes from thalassa-cache (/v1/hint); it is held in
 * memory and never logged.
 */

export interface PrewarmCandidate {
    cellId: string;
    sourceCellId?: string;
    bbox: [number, number, number, number];
}

const NM_PER_DEGREE = 60;

/** Distance in NM from a point to a cell's box (0 inside it), on a local flat approximation. */
export function distanceToBoxNm(lat: number, lon: number, bbox: [number, number, number, number]): number {
    const [w, s, e, n] = bbox;
    const dLat = lat < s ? s - lat : lat > n ? lat - n : 0;
    let dLon = 0;
    if (w <= e) dLon = lon < w ? w - lon : lon > e ? lon - e : 0;
    const x = dLon * Math.cos((lat * Math.PI) / 180);
    return Math.hypot(dLat, x) * NM_PER_DEGREE;
}

/** The S-57 usage band (1 overview … 6 berthing) from a native id such as ZZ5KESTR; 0 when unknown. */
export function usageBand(cell: PrewarmCandidate): number {
    const id = cell.sourceCellId || cell.cellId;
    const digit = /^[A-Z0-9]{2}([1-6])/.exec(id)?.[1];
    return digit ? Number(digit) : 0;
}

/** Cells within `radiusNm` of the fix, finest band first, then the smallest box, then the nearest. */
export function prewarmOrder(cells: PrewarmCandidate[], at: { lat: number; lon: number }, radiusNm: number): string[] {
    const area = (b: [number, number, number, number]) => Math.abs((b[2] - b[0]) * (b[3] - b[1]));
    return cells
        .map((cell) => ({ cell, nm: distanceToBoxNm(at.lat, at.lon, cell.bbox) }))
        .filter((c) => c.nm <= radiusNm)
        .sort((a, b) => usageBand(b.cell) - usageBand(a.cell) || area(a.cell.bbox) - area(b.cell.bbox) || a.nm - b.nm)
        .map((c) => c.cell.cellId);
}
