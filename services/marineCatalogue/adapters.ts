import type { AnchorageData } from '../anchorages/AnchorageService';
import type { CruisingPoint } from '../anchorages/cruisingReference';
import { placeSourceUrl, type CatalogueManifest, type MarinePlace } from './schema';

export function catalogueAnchorages(
    records: MarinePlace[],
    manifests: CatalogueManifest[],
): AnchorageData['points']['features'] {
    return records
        .filter((p) => p.kind === 'anchorage')
        .map((p) => {
            const m = manifests.find((row) => row.dataset === (p.id.startsWith('noaa:') ? 'noaa' : 'osm'));
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: {
                    id: p.id,
                    name: p.name,
                    kind: 'anchorage',
                    source: p.id.startsWith('noaa:') ? 'NOAA' : 'OpenStreetMap',
                    sourceRef: placeSourceUrl(p),
                    likelyAnchorage: true,
                    fetchLandNM: p.fetchLandNM,
                    notes: [
                        `${p.approximate ? 'Representative area centre; not an anchor-drop position. ' : ''}Less data here: depth, holding, swing room and local restrictions are not verified.`,
                        p.access ? `Access reported: ${p.access}.` : 'Permission unknown.',
                        ...(p.restrictions ?? []),
                        m ? `Source snapshot ${m.sourceAt.slice(0, 10)}. ${m.coverage}` : 'Source snapshot unknown.',
                    ].join(' '),
                },
            };
        });
}
export function catalogueMoorings(records: MarinePlace[], manifest: CatalogueManifest): CruisingPoint[] {
    return records
        .filter((p) => p.id.startsWith('osm-') && ['anchorage', 'mooring'].includes(p.kind))
        .map((p) => ({
            id: p.id,
            kind: p.kind as 'anchorage' | 'mooring',
            name: p.name,
            lat: p.lat,
            lon: p.lon,
            colours: p.colours ?? [],
            band: null,
            mooringClass: null,
            access: p.access || 'Unknown — check permission',
            notes: 'Less data here. No live availability, vessel limits or verified holding. Check the physical buoy and local rules.',
            restrictionNotes: p.restrictions ?? [],
            source: 'OpenStreetMap',
            sourceUrl: placeSourceUrl(p),
            retrievedAt: manifest.sourceAt,
            approximate: p.approximate,
            fetchLandNM: p.fetchLandNM,
        }));
}
