/** Public illustrative terrain only. No routing, soundings, clearance or alarm consumer. */
export interface ReliefDisplayRegion {
    id: string;
    minzoom: number;
    maxzoom: number;
    bounds?: readonly [number, number, number, number];
    tintFade: readonly [number, number];
    shadeFade: readonly [number, number];
    /** Optional immutable generation for a newly published regional set. */
    version?: string;
    attribution?: string;
    datum: string;
}
export const RELIEF_AU_BOUNDS: [number, number, number, number] = [142, -29.5, 156.5, -9];
/**
 * Only published generations belong here. The build-135 AU250/NOAA proofs,
 * EMODnet proposal and unacquired LINZ grids remain in tools/relief's plan.
 * A reviewed full-generation manifest must precede adding its row here.
 */
export const RELIEF_DISPLAY_REGIONS: readonly ReliefDisplayRegion[] = [
    // Colour extends under the GBR edge to prevent a visible seam; the
    // global hillshade fades earlier because it cannot provide fine detail.
    { id: 'global', minzoom: 0, maxzoom: 9, tintFade: [13.5, 14.5], shadeFade: [10, 11], datum: 'GEBCO MSL' },
    {
        id: 'au',
        minzoom: 8,
        maxzoom: 13,
        bounds: RELIEF_AU_BOUNDS,
        tintFade: [13.5, 14.5],
        shadeFade: [13.5, 14.5],
        datum: 'GA GBR MSL; illustrative blend over GEBCO',
    },
];
export function reliefRegionBase(base: string, region: ReliefDisplayRegion): string {
    return region.version ? base.replace(/\/v[1-9]\d{0,2}$/, `/${region.version}`) : base;
}
/** The app's own terrain namespace; never recognises a chart-vault filename. */
export function ownedReliefFile(name: string): boolean {
    const match = /^v[1-9]\d{0,2}_([a-z][a-z0-9]{0,15})_(dem|idx)_(\d+)_(\d+)_(\d+)\.(png|webp)$/.exec(name);
    if (!match) return false;
    const [, id, kind, zs, xs, ys, extension] = match,
        region = RELIEF_DISPLAY_REGIONS.find((candidate) => candidate.id === id),
        z = Number(zs);
    return !!(
        region &&
        z >= region.minzoom &&
        z <= region.maxzoom &&
        Number(xs) < 2 ** z &&
        Number(ys) < 2 ** z &&
        (kind === 'dem' ? extension === 'webp' : extension === 'png')
    );
}
