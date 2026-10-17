/** Bounded chart picture for Targets and offline search; never a filtered alarm input. */
import { AisStore } from '../AisStore';

let internet: GeoJSON.Feature[] = [];
const listeners = new Set<() => void>();

export function publishAisTargetPicture(features: GeoJSON.Feature[]): void {
    internet = features.filter((feature) => feature.properties?.source !== 'local').slice(0, 2000);
    for (const listener of listeners) listener();
}

export function subscribeAisTargetPicture(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Fresh receiver reports win over duplicate internet records, even without a map open. */
export function readAisTargetPicture(): GeoJSON.Feature<GeoJSON.Point>[] {
    const local = AisStore.toGeoJSON().features.map((feature) => ({
        ...feature,
        properties: { ...feature.properties, source: 'local' },
    }));
    const seen = new Set(local.map((feature) => Number(feature.properties.mmsi)));
    return [...local, ...internet.filter((feature) => !seen.has(Number(feature.properties?.mmsi)))].filter(
        (feature): feature is GeoJSON.Feature<GeoJSON.Point> =>
            feature.geometry?.type === 'Point' &&
            feature.geometry.coordinates.every(Number.isFinite) &&
            Math.abs(feature.geometry.coordinates[1]) <= 90 &&
            Math.abs(feature.geometry.coordinates[0]) <= 180 &&
            (feature.geometry.coordinates[0] !== 0 || feature.geometry.coordinates[1] !== 0),
    );
}

export function searchAisTargetPicture(query: string): GeoJSON.Feature<GeoJSON.Point>[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length < 2) return [];
    const positioned = readAisTargetPicture();
    const seen = new Set(positioned.map((feature) => Number(feature.properties?.mmsi)));
    const unpositioned: GeoJSON.Feature<GeoJSON.Point>[] = [...AisStore.getTargets().values()]
        .filter((target) => !seen.has(target.mmsi))
        .map((target) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { ...target, source: 'local', hasPosition: false },
        }));
    return [...positioned, ...unpositioned]
        .filter((feature) => {
            const p = feature.properties ?? {};
            return [p.name, p.mmsi, p.callSign].some((value) =>
                String(value ?? '')
                    .toLocaleLowerCase()
                    .includes(needle),
            );
        })
        .slice(0, 10);
}
