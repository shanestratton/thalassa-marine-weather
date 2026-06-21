/**
 * AnchorageService — loads the bundled Whitsundays anchorage reference.
 *
 * Data is shipped in `public/anchorages/` (built by
 * `scripts/anchorages/build-whitsundays.mjs`) and served from the app origin,
 * so the service worker caches it and it works fully offline — the whole point
 * for cruisers out of signal. Sources: OpenStreetMap (ODbL) for anchorage
 * positions/names, GBRMPA (CC BY) for no-anchoring areas and designated
 * anchorages. It is an open-data planning reference, NOT a navigational chart.
 */
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AnchorageService');

export type AnchorageKind = 'anchorage' | 'designated_anchorage' | 'marina';

export interface AnchorageProps {
    id: string;
    name: string;
    kind: AnchorageKind;
    source: 'OpenStreetMap' | 'GBRMPA';
    sourceRef?: string;
    likelyAnchorage?: boolean;
    noAnchoring?: boolean;
    noAnchoringName?: string | null;
    notes?: string | null;
}

export interface AnchorageData {
    points: GeoJSON.FeatureCollection<GeoJSON.Point, AnchorageProps>;
    noAnchor: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    zoning: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
}

const POINTS_URL = '/anchorages/whitsundays.geojson';
const NOANCHOR_URL = '/anchorages/whitsundays-no-anchoring.geojson';
const ZONING_URL = '/anchorages/whitsundays-zoning.geojson';

let cache: Promise<AnchorageData> | null = null;

async function fetchFC<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`anchorage data fetch failed: ${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
}

export const AnchorageService = {
    /** Load (and memoise) the Whitsundays anchorage dataset. */
    load(): Promise<AnchorageData> {
        if (!cache) {
            cache = (async () => {
                const [points, noAnchor, zoning] = await Promise.all([
                    fetchFC<AnchorageData['points']>(POINTS_URL),
                    fetchFC<AnchorageData['noAnchor']>(NOANCHOR_URL),
                    fetchFC<AnchorageData['zoning']>(ZONING_URL),
                ]);
                log.info(
                    `loaded ${points.features.length} anchorage points, ${noAnchor.features.length} no-anchoring areas, ${zoning.features.length} zones`,
                );
                return { points, noAnchor, zoning };
            })().catch((err) => {
                // Reset so a later retry can succeed (e.g. first launch raced the SW cache).
                cache = null;
                throw err;
            });
        }
        return cache;
    },
};
