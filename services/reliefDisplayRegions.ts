/** Public illustrative terrain only. No routing, soundings, clearance or alarm consumer. */
import { parseReliefAvailability, reliefTileAvailable, type ReliefAvailability } from './reliefAvailability';
import au250 from '../data/relief/au250-v2.json' with { type: 'json' };
import nz from '../data/relief/nz-v2.json' with { type: 'json' };
import { reliefAvailabilityBounds } from './reliefViewport';
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
    label?: string;
    sourceUrl?: string;
    coverage?: string;
    /** Required for a future sparse regional generation; exact finite-source tile runs. */
    availability?: ReliefAvailability;
}
export const RELIEF_AU_BOUNDS: [number, number, number, number] = [142, -29.5, 156.5, -9];
/**
 * Only published generations belong here. AU250 and LINZ v2 were completely
 * published and independently byte-read back on 17 October 2026. NOAA/EMODnet
 * proofs remain inactive. Sparse admission is local; no metadata download.
 */
export const RELIEF_DISPLAY_REGIONS: readonly ReliefDisplayRegion[] = [
    // Colour extends under the GBR edge to prevent a visible seam; the
    // global hillshade fades earlier because it cannot provide fine detail.
    { id: 'global', minzoom: 0, maxzoom: 9, tintFade: [13.5, 14.5], shadeFade: [10, 11], datum: 'GEBCO MSL' },
    ...publishedSparse('au250', au250, 10, 50308, {
        bounds: [92, -60, 172, -8],
        tintFade: [10.5, 11.5],
        shadeFade: [10.5, 11.5],
        label: 'Australia · nominal 250 m composite',
        sourceUrl: 'https://pid.geoscience.gov.au/dataset/ga/151280',
        datum: 'Approximately MSL; no vertical conversion. Source resolution is not survey accuracy.',
        coverage: '50,308 sparse tile pairs; finite source seafloor only. Local holes use coarse GEBCO fallback.',
        attribution:
            'Derived from <a href="https://pid.geoscience.gov.au/dataset/ga/151280">Geoscience Australia AusBathyTopo Australia 2026 250m</a>, © Commonwealth of Australia; <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> (section 5 disclaimer); GEBCO 2026; © OpenStreetMap contributors (ODbL land mask). Approximately MSL; illustrative, not for navigation.',
    }),
    {
        id: 'au',
        minzoom: 8,
        maxzoom: 13,
        bounds: RELIEF_AU_BOUNDS,
        tintFade: [13.5, 14.5],
        shadeFade: [13.5, 14.5],
        datum: 'GA GBR MSL; illustrative blend over GEBCO',
    },
    ...publishedSparse('nz', nz, 14, 2197, {
        tintFade: [14.5, 15.5],
        shadeFade: [14.5, 15.5],
        label: 'New Zealand · 61 surveyed coastal patches',
        sourceUrl: 'https://data.linz.govt.nz/layer/122508-new-zealand-coastal-lidar-1m-dem/',
        datum: 'NZVD2016 native heights; not MSL. No vertical conversion; coarse GEBCO fallback uses approximate MSL.',
        coverage:
            '2,197 sparse tile pairs from 61 surveyed patches, not whole-country 1 m coverage. Gaps remain coarse or empty.',
        attribution:
            'Derived from <a href="https://data.linz.govt.nz/layer/122508-new-zealand-coastal-lidar-1m-dem/">LINZ NZ Coastal LiDAR 1 m DEM surveyed patches</a>; <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>; GEBCO 2026 fallback; © OpenStreetMap contributors (ODbL land mask). Native NZVD2016, not MSL; no vertical conversion. Illustrative, not for navigation.',
    }),
];
/** Reject a malformed bundled generation rather than silently making it dense. */
function publishedSparse(
    id: string,
    input: unknown,
    maxzoom: number,
    count: number,
    details: Pick<
        ReliefDisplayRegion,
        'tintFade' | 'shadeFade' | 'datum' | 'label' | 'coverage' | 'sourceUrl' | 'attribution' | 'bounds'
    >,
): ReliefDisplayRegion[] {
    const availability = parseReliefAvailability(input, { region: id, version: 'v2', minzoom: 8, maxzoom });
    return availability?.tilePairs === count
        ? [
              {
                  id,
                  version: 'v2',
                  minzoom: 8,
                  maxzoom,
                  ...details,
                  bounds: details.bounds ?? reliefAvailabilityBounds(availability),
                  availability,
              },
          ]
        : [];
}
export function reliefRegionBase(base: string, region: ReliefDisplayRegion): string {
    return region.version ? base.replace(/\/v[1-9]\d{0,2}$/, `/${region.version}`) : base;
}
/** The app's own terrain namespace; never recognises a chart-vault filename. */
export function ownedReliefFile(name: string): boolean {
    const match = /^(v[1-9]\d{0,2})_([a-z][a-z0-9]{0,15})_(dem|idx)_(\d+)_(\d+)_(\d+)\.(png|webp)$/.exec(name);
    if (!match) return false;
    const [, version, id, kind, zs, xs, ys, extension] = match,
        region = RELIEF_DISPLAY_REGIONS.find((candidate) => candidate.id === id),
        z = Number(zs);
    return !!(
        region &&
        (!region.version || version === region.version) &&
        z >= region.minzoom &&
        z <= region.maxzoom &&
        Number(xs) < 2 ** z &&
        Number(ys) < 2 ** z &&
        reliefTileAvailable(region.availability, z, Number(xs), Number(ys)) &&
        (kind === 'dem' ? extension === 'webp' : extension === 'png')
    );
}
