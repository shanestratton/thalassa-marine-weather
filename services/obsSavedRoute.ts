import type { SavedRouteLibraryItem } from './savedRouteLibrary';
import type { RouteOrTrack } from './shiplog/RoutesAndTracks';
import { haversineNM } from '../utils/gpsFollow';

/** Read-only chart adapter for the same validated library used by Plan. */
export function savedRouteToChartItem(item: SavedRouteLibraryItem): RouteOrTrack {
    const points = item.points.map(({ lat, lon }) => ({ lat, lon }));
    let distanceNm = 0;
    const bbox: RouteOrTrack['bbox'] = [180, 90, -180, -90];
    points.forEach((point, index) => {
        bbox[0] = Math.min(bbox[0], point.lon);
        bbox[1] = Math.min(bbox[1], point.lat);
        bbox[2] = Math.max(bbox[2], point.lon);
        bbox[3] = Math.max(bbox[3], point.lat);
        if (index) {
            const previous = points[index - 1];
            distanceNm += haversineNM(previous.lat, previous.lon, point.lat, point.lon);
        }
    });
    return {
        id: item.source === 'logbook-route' ? item.voyageId : item.key,
        label: item.label,
        sublabel:
            item.source === 'logbook-route'
                ? item.sublabel
                : `${item.source === 'trip-passage' ? `Passage · ${item.legCount} legs` : 'Saved route'} · ${distanceNm.toFixed(1)} NM`,
        points,
        bbox,
        timestamp: item.timestamp,
        distanceNm,
        kind: 'sea',
        isLocal: item.source === 'logbook-route' && item.isLocal,
        savedRouteId: item.source === 'saved-trace' ? item.routeId : undefined,
    };
}
