import type { IsochroneResult } from '../isochrone/types';
import { combineSailingStats } from '../isochrone/routeStats';
import { combineRouteComfort } from '../isochrone/routeComfort';

/** Leg clocks are relative to each leg's departure; the displayed route has one clock. */
export function stitchIsochrones(first: IsochroneResult, second: IsochroneResult): IsochroneResult {
    const offset = first.totalDurationHours;
    const shifted = second.route.map((node) => ({
        ...node,
        timeHours: node.timeHours + offset,
        distance: node.distance + first.totalDistanceNM,
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
                    distance: node.distance + first.totalDistanceNM,
                })),
            })),
        ],
        totalDistanceNM: Math.round((first.totalDistanceNM + second.totalDistanceNM) * 10) / 10,
        totalDurationHours: Math.round((first.totalDurationHours + second.totalDurationHours) * 10) / 10,
        arrivalTime: second.arrivalTime,
        sailingStats,
        motorHours: sailingStats?.motorHours ?? null,
        comfort: combineRouteComfort([first.comfort, second.comfort]),
        environmentNotes: [...new Set([...(first.environmentNotes ?? []), ...(second.environmentNotes ?? [])])],
    };
}
