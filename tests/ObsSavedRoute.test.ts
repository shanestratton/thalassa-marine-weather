import { describe, expect, it } from 'vitest';
import { savedRouteToChartItem } from '../services/obsSavedRoute';
import type { SavedRouteLibraryItem } from '../services/savedRouteLibrary';

const timestamp = Date.parse('2026-09-25T00:00:00Z');
const points = [
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 2 },
];

function savedRoute(): SavedRouteLibraryItem {
    return {
        source: 'saved-trace',
        key: 'saved:route-a',
        routeId: 'route-a',
        label: 'Daydream Island → Hamilton Island',
        points: points.map((point) => ({ ...point })),
        timestamp,
    };
}

describe('OBS saved route library adapter', () => {
    it('preserves the canonical identity, label and all bends while calculating chart bounds and distance', () => {
        const item = savedRouteToChartItem(savedRoute());

        expect(item).toMatchObject({
            id: 'saved:route-a',
            savedRouteId: 'route-a',
            label: 'Daydream Island → Hamilton Island',
            points,
            bbox: [1, 0, 2, 1],
            timestamp,
            kind: 'sea',
            isLocal: false,
            sublabel: 'Saved route · 120.1 NM',
        });
        // Two one-degree legs are about 120 NM, not the ~85 NM direct
        // endpoint shortcut. The adapter must retain the planned bend.
        expect(item.distanceNm).toBeCloseTo(120.07, 1);
    });

    it('gives a derived multi-leg passage its own stable identity and leg-count subtitle', () => {
        const passage: SavedRouteLibraryItem = {
            source: 'trip-passage',
            key: 'passage:trip-a',
            tripId: 'trip-a',
            label: 'Newport → Whitsundays (Passage)',
            points,
            timestamp,
            legCount: 3,
        };
        const item = savedRouteToChartItem(passage);

        expect(item).toMatchObject({
            id: 'passage:trip-a',
            label: passage.label,
            points,
            bbox: [1, 0, 2, 1],
            timestamp,
            isLocal: false,
            sublabel: 'Passage · 3 legs · 120.1 NM',
        });
        expect(item.savedRouteId).toBeUndefined();
        expect(item.id).not.toBe(savedRouteToChartItem(savedRoute()).id);
    });

    it.each([true, false])('preserves the exact legacy voyage identity, subtitle and local status (%s)', (isLocal) => {
        const legacy: SavedRouteLibraryItem = {
            source: 'logbook-route',
            key: 'logbook:planned_legacy-a',
            voyageId: 'planned_legacy-a',
            label: 'Butterfly Bay → Daydream Island',
            sublabel: 'Planned · 18 NM',
            points,
            timestamp,
            isLocal,
        };

        expect(savedRouteToChartItem(legacy)).toMatchObject({
            id: 'planned_legacy-a',
            label: legacy.label,
            sublabel: legacy.sublabel,
            points,
            bbox: [1, 0, 2, 1],
            timestamp,
            isLocal,
        });
    });

    it('clones each coordinate so a chart selection cannot modify the saved route library', () => {
        const source = savedRoute();
        const item = savedRouteToChartItem(source);

        expect(item.points).not.toBe(source.points);
        item.points.forEach((point, index) => expect(point).not.toBe(source.points[index]));
        item.points[0].lat = 40;
        item.points.push({ lat: 2, lon: 3 });
        expect(source.points).toEqual(points);
    });
});
