/**
 * floatPlan — composes the document a skipper leaves with someone ashore.
 *
 * A float plan is not an itinerary. Its whole purpose is the overdue time:
 * "if you have not heard from me by X, ring Y". Everything else is detail a
 * rescue coordinator would otherwise have to extract from a frightened
 * relative at midnight.
 *
 * PURE ON PURPOSE. No fetches, no storage, no share call — this returns a
 * string and nothing else, so the whole document is testable and the caller
 * decides where it goes. It is never persisted server-side and never reaches
 * the public tracking page: that page answers "where is this boat and where
 * has it been", while this answers "what is aboard and who to call", which is
 * an inventory plus a set of credentials. It goes to one chosen person.
 *
 * Plain text rather than PDF, deliberately. This gets read on a phone, in the
 * dark, by someone worried — text lands in SMS, WhatsApp or email and is
 * legible without opening anything.
 */

import type { VesselProfile } from '../types/vessel';
import { calculateBearing, calculateDistance } from '../utils/navigationCalculations';

export interface FloatPlanRoute {
    /** Route name, e.g. "Newport - Lady Musgrave". */
    name?: string;
    from?: string;
    to?: string;
    distanceNM?: number;
    waypoints?: { lat: number; lon: number }[];
}

export interface FloatPlanInput {
    vessel: Partial<VesselProfile> | null | undefined;
    route: FloatPlanRoute;
    departureMs: number;
    etaMs?: number | null;
    /** The field that matters: when to raise the alarm. */
    overdueMs: number;
    /** Souls on board, including the skipper. */
    personsOnBoard?: number;
    /** Who the shore contact should ring — VMR, Marine Rescue, water police. */
    whoToCall?: string;
    /** Optional: how to reach the skipper (sat phone, VHF watch, etc). */
    contactAboard?: string;
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
};

function when(ms: number | null | undefined): string | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return new Date(ms).toLocaleString([], DATE_OPTS);
}

/**
 * "27°08.5'S 153°05.3'E" — degrees and decimal minutes, the form marine
 * radio and SAR actually use (decimal degrees made an operator convert).
 */
export function floatPlanCoord(p: { lat: number; lon: number }): string {
    const dm = (v: number): string => {
        const abs = Math.abs(v);
        const deg = Math.floor(abs);
        const min = (abs - deg) * 60;
        return `${deg}°${min.toFixed(1).padStart(4, '0')}'`;
    };
    return `${dm(p.lat)}${p.lat >= 0 ? 'N' : 'S'} ${dm(p.lon)}${p.lon >= 0 ? 'E' : 'W'}`;
}

/**
 * Thin a dense traced route to the positions a rescue coordinator can act
 * on: departure, destination, and each major course alteration (≥25° with
 * ≥0.5 NM legs both sides). A tracer route carries every plotted vertex —
 * printing 40 numbered coordinates is a wall, not a track. Capped at 12
 * lines; when thinning drops points the caption says so.
 */
export function keyTrackPoints(waypoints: { lat: number; lon: number }[]): {
    points: { lat: number; lon: number }[];
    thinned: boolean;
} {
    if (waypoints.length <= 6) return { points: waypoints, thinned: false };
    const TURN_DEG = 25;
    const MIN_LEG_NM = 0.5;
    const keep: { lat: number; lon: number }[] = [waypoints[0]];
    for (let i = 1; i < waypoints.length - 1; i++) {
        const a = waypoints[i - 1];
        const b = waypoints[i];
        const c = waypoints[i + 1];
        let turn = calculateBearing(b.lat, b.lon, c.lat, c.lon) - calculateBearing(a.lat, a.lon, b.lat, b.lon);
        if (turn > 180) turn -= 360;
        if (turn < -180) turn += 360;
        if (
            Math.abs(turn) >= TURN_DEG &&
            calculateDistance(a.lat, a.lon, b.lat, b.lon) >= MIN_LEG_NM &&
            calculateDistance(b.lat, b.lon, c.lat, c.lon) >= MIN_LEG_NM
        ) {
            keep.push(b);
        }
    }
    keep.push(waypoints[waypoints.length - 1]);
    // Still too many turns (a winding channel): keep the biggest picture —
    // ends plus evenly-sampled interior, 12 lines max.
    if (keep.length > 12) {
        const sampled = [keep[0]];
        const step = (keep.length - 2) / 10;
        for (let i = 0; i < 10; i++) sampled.push(keep[1 + Math.round(i * step)]);
        sampled.push(keep[keep.length - 1]);
        return { points: sampled, thinned: true };
    }
    return { points: keep, thinned: keep.length < waypoints.length };
}

/** Total great-circle distance along a set of waypoints, in NM. */
export function trackDistanceNM(waypoints: { lat: number; lon: number }[]): number {
    let nm = 0;
    for (let i = 1; i < waypoints.length; i++) {
        nm += calculateDistance(waypoints[i - 1].lat, waypoints[i - 1].lon, waypoints[i].lat, waypoints[i].lon);
    }
    return nm;
}

/** Join the parts that exist with a separator, dropping blanks entirely. */
function joinParts(parts: (string | null | undefined)[], sep = ' · '): string {
    return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

function section(heading: string, lines: (string | null | undefined)[]): string | null {
    const body = lines.filter((l): l is string => Boolean(l && l.trim()));
    if (body.length === 0) return null;
    return `${heading}\n${body.map((l) => `  ${l}`).join('\n')}`;
}

export function composeFloatPlan(input: FloatPlanInput): string {
    const { vessel, route, departureMs, etaMs, overdueMs, personsOnBoard, whoToCall, contactAboard } = input;

    const vesselName = vessel?.name?.trim() || 'Unnamed vessel';

    const identity = joinParts([
        vessel?.registration ? `Rego ${vessel.registration}` : null,
        vessel?.mmsi ? `MMSI ${vessel.mmsi}` : null,
        vessel?.callSign ? `Call sign ${vessel.callSign}` : null,
    ]);

    const description = joinParts([
        vessel?.model,
        vessel?.type === 'sail' ? 'sail' : vessel?.type === 'power' ? 'power' : null,
        vessel?.hullType,
        typeof vessel?.length === 'number' && vessel.length > 0 ? `${Math.round(vessel.length)} ft` : null,
        vessel?.hullColor ? `${vessel.hullColor} hull` : null,
    ]);

    const liferaft = joinParts(
        [
            typeof vessel?.liferaftCapacity === 'number' && vessel.liferaftCapacity > 0
                ? `Liferaft ${vessel.liferaftCapacity} person`
                : null,
            vessel?.liferaftServiceDate ? `serviced ${vessel.liferaftServiceDate}` : null,
        ],
        ', ',
    );

    const allWaypoints = route.waypoints ?? [];
    const { points: trackPoints, thinned } = keyTrackPoints(allWaypoints);
    const trackLines = trackPoints.map((p, i) => {
        const tag = i === 0 ? ' (depart)' : i === trackPoints.length - 1 ? ' (destination)' : '';
        return `${i + 1}. ${floatPlanCoord(p)}${tag}`;
    });
    if (thinned && trackLines.length > 0) {
        trackLines.push(`(key positions of ${allWaypoints.length} plotted — full route is aboard)`);
    }

    const distanceNM =
        typeof route.distanceNM === 'number' && route.distanceNM > 0
            ? route.distanceNM
            : allWaypoints.length >= 2
              ? trackDistanceNM(allWaypoints)
              : null;

    const blocks: (string | null)[] = [
        `FLOAT PLAN — ${vesselName}`,
        // The point of the whole document, so it comes FIRST — the person
        // ashore should not scroll past the boat's paint colour to find out
        // when to start worrying. Always rendered.
        section('IF YOU HAVE NOT HEARD FROM US', [
            `By        ${when(overdueMs) ?? 'not set'}`,
            whoToCall ? `Call      ${whoToCall}` : 'Call      your local marine rescue or water police',
        ]),
        section('PASSAGE', [
            route.from ? `From      ${route.from}` : null,
            `Depart    ${when(departureMs) ?? 'not set'}`,
            route.to ? `To        ${route.to}` : null,
            etaMs ? `ETA       ${when(etaMs)}` : null,
            distanceNM ? `Distance  ${distanceNM.toFixed(0)} NM` : null,
        ]),
        section('PEOPLE', [
            typeof personsOnBoard === 'number' && personsOnBoard > 0 ? `${personsOnBoard} on board` : null,
            contactAboard ? `Contact aboard: ${contactAboard}` : null,
        ]),
        section('VESSEL', [description || null, identity || null]),
        section('SAFETY', [
            vessel?.epirbHexId ? `EPIRB hex ${vessel.epirbHexId}` : null,
            liferaft || null,
            vessel?.flaresExpiry ? `Flares expire ${vessel.flaresExpiry}` : null,
            vessel?.safetyNotes?.trim() || null,
        ]),
        trackLines.length > 0 ? section('INTENDED TRACK', trackLines) : null,
        'Sent from Thalassa. All times local.',
    ];

    return blocks.filter((b): b is string => Boolean(b)).join('\n\n');
}

/**
 * The other half of the loop, and the half everybody forgets. A float plan
 * that is never closed out either triggers a real search while the crew are
 * at the pub, or — worse over time — teaches the shore contact to ignore the
 * next one.
 */
export function composeArrivalMessage(input: { vesselName?: string; destination?: string; arrivedMs: number }): string {
    const name = input.vesselName?.trim() || 'We';
    const at = input.destination?.trim();
    const stamp = when(input.arrivedMs);
    return joinParts(
        [
            `${name} arrived safely${at ? ` at ${at}` : ''}${stamp ? `, ${stamp}` : ''}.`,
            'Stand down — no need to call anyone.',
        ],
        ' ',
    );
}
