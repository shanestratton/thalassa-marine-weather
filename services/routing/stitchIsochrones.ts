import type { IsochroneResult } from '../isochrone/types';
import { combineSailingStats } from '../isochrone/routeSailingStats';
import { combineRouteComfort } from '../isochrone/routeComfort';

/** Leg clocks are relative to each leg's departure; the displayed route has one clock. */
export function stitchIsochrones(first: IsochroneResult, second: IsochroneResult): IsochroneResult {
    // Summary fields are rounded to tenths. They cannot rebase a forecast
    // clock: 0.34 h must stay 0.34 h at the next departure, rather than 0.3 h.
    const tail = first.route.at(-1),
        nextTail = second.route.at(-1);
    const offset = Number.isFinite(tail?.timeHours) ? tail!.timeHours : first.totalDurationHours;
    const distanceOffset = Number.isFinite(tail?.distance) ? tail!.distance : first.totalDistanceNM;
    const shifted = second.route.map((node) => ({
        ...node,
        timeHours: node.timeHours + offset,
        distance: node.distance + distanceOffset,
    }));
    const sailingStats = combineSailingStats([first.sailingStats, second.sailingStats]);
    return {
        route: [...first.route, ...shifted.slice(1)],
        routeCoordinates: [...first.routeCoordinates, ...second.routeCoordinates.slice(1)],
        shallowFlags: [...first.shallowFlags, ...second.shallowFlags.slice(1)],
        isochrones: [
            ...first.isochrones,
            ...second.isochrones.map((front) => ({
                ...front,
                timeHours: front.timeHours + offset,
                nodes: front.nodes.map((node) => ({
                    ...node,
                    timeHours: node.timeHours + offset,
                    distance: node.distance + distanceOffset,
                })),
            })),
        ],
        totalDistanceNM: Math.round((distanceOffset + (nextTail?.distance ?? second.totalDistanceNM)) * 10) / 10,
        totalDurationHours: Math.round((offset + (nextTail?.timeHours ?? second.totalDurationHours)) * 10) / 10,
        arrivalTime: second.arrivalTime,
        sailingStats,
        motorHours: sailingStats?.motorHours ?? null,
        comfort: combineRouteComfort([first.comfort, second.comfort]),
        environmentNotes: [...new Set([...(first.environmentNotes ?? []), ...(second.environmentNotes ?? [])])],
    };
}
