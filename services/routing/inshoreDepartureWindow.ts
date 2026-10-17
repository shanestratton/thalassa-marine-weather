import type { VesselProfile } from '../../types';
import type { ThalassaRouteDisclosure } from '../../types/autorouting';
import type { IsochroneResult } from '../isochrone/types';
import type { TideCurve } from '../TideHeightService';
import { cumulativeLegs, haversineNm } from '../isochrone/geodesy';
import { vesselAirDraftMetres, vesselDraftMetres } from '../units';
import { vesselIsochroneConfig } from './isochronePolicy';

/** The 128 tide gate, on one exact verified inshore line. Chart facts stay in this closure only. */
export async function inshoreDepartureContext(
    coordinates: [number, number][],
    engine: ThalassaRouteDisclosure,
    vessel: VesselProfile,
    departureTime: string,
    loadCurve: (lat: number, lon: number, from: number, to: number) => Promise<TideCurve | null>,
) {
    const { leaveSpots, leaveCurves, leaveWindow, leaveChosen } = await import('../dayPlanner/leaveWindow');
    if (engine.backstop !== 'verified' || !engine.stateMask || engine.stateMask.length !== coordinates.length - 1)
        throw new Error('An inshore departure comparison needs a verified chart route.');
    const speed = vesselIsochroneConfig(vessel, engine.distanceNM).motoringSpeed;
    const legs = cumulativeLegs(
        coordinates.map(([lon, lat]) => ({ lat, lon })),
        speed,
    );
    const route = coordinates.map(([lon, lat], i) => ({
        lat,
        lon,
        timeHours: legs[i].hours,
        distance: legs[i].nm,
        speed,
        bearing: 0,
        tws: 0,
        twa: 0,
        parentIndex: null,
        propulsion: 'unknown' as const,
    }));
    const duration = legs.at(-1)?.hours ?? 0;
    const start = Date.parse(departureTime);
    const result: IsochroneResult = {
        route,
        routeCoordinates: coordinates.map((p) => [...p]),
        shallowFlags: coordinates.map(() => false),
        isochrones: [],
        totalDistanceNM: legs.at(-1)?.nm ?? 0,
        totalDurationHours: duration,
        arrivalTime: new Date(start + duration * 3_600_000).toISOString(),
        environmentNotes: [
            'This hop is under 15 NM and uses the inshore chart router. Duration assumes engine cruising speed; actual propulsion is unknown.',
        ],
    };
    const spots = leaveSpots(coordinates, engine, vesselDraftMetres(vessel));
    const curves = spots ? await leaveCurves(spots, loadCurve, start, start + (168 + duration + 24) * 3_600_000) : [];
    return {
        route: result,
        tideForRoute: async (
            candidate: IsochroneResult,
            departureMs: number,
        ): Promise<'clear' | 'blocked' | 'unknown' | 'not-gated'> => {
            if (
                !spots ||
                candidate.routeCoordinates.length !== coordinates.length ||
                candidate.routeCoordinates.some((p, i) => p[0] !== coordinates[i][0] || p[1] !== coordinates[i][1])
            )
                return 'unknown';
            if (spots.red) return 'blocked';
            const window = leaveWindow({
                spots,
                curves,
                departures: [
                    {
                        departureMs,
                        stayEndMs: null,
                        out: { durationMs: candidate.totalDurationHours * 3_600_000 },
                        home: null,
                    },
                ],
                earliestMs: departureMs,
                dayTrip: false,
                cruiseKts: speed,
            });
            if (window.kind === 'not-gated') return 'not-gated';
            if (window.kind === 'unknown' || window.kind === 'no-times') return 'unknown';
            return leaveChosen(window.windows, departureMs) === 'works' ? 'clear' : 'blocked';
        },
    };
}

export async function prepareInshoreDepartureWindow(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    vessel: VesselProfile,
    departureTime: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
) {
    const [
        { tryInshoreRoute },
        { inshoreRouteCrossesLand },
        { inshoreSegmentStates },
        { fetchTideCurve, TIDE_CURVE_MAX_DAYS },
    ] = await Promise.all([
        import('../InshoreRouter'),
        import('./landBackstop'),
        import('../../components/map/inshoreRouteState'),
        import('../TideHeightService'),
    ]);
    if (!isCurrent()) return null;
    const result = await tryInshoreRoute(
        origin,
        destination,
        vesselDraftMetres(vessel),
        vesselAirDraftMetres(vessel),
        'safest',
        { departureMs: Date.parse(departureTime), signal },
    );
    if (!isCurrent()) return null;
    if (!result || !('polyline' in result))
        throw new Error(
            result?.error ??
                'This short hop needs an installed inshore chart route before its departure window can be compared.',
        );
    const backstop = await inshoreRouteCrossesLand(result.polyline, { chartVerdicts: result.chartVerdicts });
    if (!isCurrent()) return null;
    if (result.hardLand?.awayM || backstop.status !== 'verified' || backstop.crossesLand)
        throw new Error(
            'The inshore route could not pass chart and land verification. Refine the pins or check chart coverage.',
        );
    const first = result.polyline[0],
        last = result.polyline.at(-1);
    if (
        !first ||
        !last ||
        haversineNm(origin.lat, origin.lon, first[1], first[0]) > 0.06 ||
        haversineNm(destination.lat, destination.lon, last[1], last[0]) > 0.06
    )
        throw new Error('Place both pins on the verified inshore water before comparing departure times.');
    return inshoreDepartureContext(
        result.polyline,
        { ...result, stateMask: inshoreSegmentStates(result), backstop: 'verified' },
        vessel,
        departureTime,
        (lat, lon, from, to) => fetchTideCurve(lat, lon, from, to, { days: TIDE_CURVE_MAX_DAYS }),
    );
}
