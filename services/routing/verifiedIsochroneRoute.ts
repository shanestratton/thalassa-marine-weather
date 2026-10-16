import type { IsochroneNode, IsochroneResult } from '../isochrone/types';
import { cumulativeLegs } from '../isochrone/geodesy';
import { sailingStatsForNodes } from '../isochrone/routeStats';
import { routeComfortForNodes } from '../isochrone/routeComfort';

/** Chart verification must not erase the modeled ETA or attach old modes to a new geometry. */
export function verifiedIsochroneRoute(
    candidate: IsochroneResult,
    validated: IsochroneNode[],
    departureIso: string,
    fallbackSpeedKts: number,
): IsochroneResult {
    const sameGeometry =
        validated.length === candidate.route.length &&
        validated.every(
            (node, i) =>
                Math.abs(node.lat - candidate.route[i].lat) < 1e-7 &&
                Math.abs(node.lon - candidate.route[i].lon) < 1e-7,
        );
    if (sameGeometry) return { ...candidate, route: candidate.route.map((node) => ({ ...node })) };
    const legs = cumulativeLegs(validated, fallbackSpeedKts > 0 ? fallbackSpeedKts : 6);
    const route = validated.map(
        (node, i): IsochroneNode => ({
            ...node,
            timeHours: legs[i].hours,
            distance: legs[i].nm,
            propulsion: 'unknown',
            tackSide: null,
            waveHeightM: null,
            wavePeriodS: null,
            waveFromDeg: null,
        }),
    );
    const totalDistanceNM = legs.at(-1)?.nm ?? 0;
    const totalDurationHours = legs.at(-1)?.hours ?? 0;
    return {
        ...candidate,
        route,
        routeCoordinates: route.map((node) => [node.lon, node.lat]),
        shallowFlags: route.map(() => false),
        totalDistanceNM: Math.round(totalDistanceNM * 10) / 10,
        totalDurationHours: Math.round(totalDurationHours * 10) / 10,
        arrivalTime: new Date(Date.parse(departureIso) + totalDurationHours * 3_600_000).toISOString(),
        sailingStats: sailingStatsForNodes(route),
        motorHours: null,
        comfort: routeComfortForNodes(route),
        environmentNotes: [
            ...(candidate.environmentNotes ?? []),
            'Chart verification changed the modeled path. Duration uses cruising speed; propulsion and prior wave clearance are unknown.',
        ],
    };
}
