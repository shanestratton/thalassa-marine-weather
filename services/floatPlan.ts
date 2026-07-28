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

/** "27.14S 153.09E" — the form a radio operator can read aloud. */
export function floatPlanCoord(p: { lat: number; lon: number }): string {
    const lat = `${Math.abs(p.lat).toFixed(2)}${p.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(p.lon).toFixed(2)}${p.lon >= 0 ? 'E' : 'W'}`;
    return `${lat} ${lon}`;
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

    const waypoints = (route.waypoints ?? []).map((p, i) => `${i + 1}. ${floatPlanCoord(p)}`);

    const blocks: (string | null)[] = [
        `FLOAT PLAN — ${vesselName}`,
        section('VESSEL', [description || null, identity || null]),
        section('PASSAGE', [
            route.from ? `From      ${route.from}` : null,
            `Depart    ${when(departureMs) ?? 'not set'}`,
            route.to ? `To        ${route.to}` : null,
            etaMs ? `ETA       ${when(etaMs)}` : null,
            typeof route.distanceNM === 'number' && route.distanceNM > 0
                ? `Distance  ${route.distanceNM.toFixed(0)} NM`
                : null,
        ]),
        section('PEOPLE', [
            typeof personsOnBoard === 'number' && personsOnBoard > 0 ? `${personsOnBoard} on board` : null,
            contactAboard ? `Contact aboard: ${contactAboard}` : null,
        ]),
        section('SAFETY', [
            vessel?.epirbHexId ? `EPIRB hex ${vessel.epirbHexId}` : null,
            liferaft || null,
            vessel?.flaresExpiry ? `Flares expire ${vessel.flaresExpiry}` : null,
        ]),
        // The point of the whole document. Always rendered, even with no
        // contact given — a bare overdue time still tells someone when to
        // start worrying, which is more than nothing.
        section('IF YOU HAVE NOT HEARD FROM US', [
            `By        ${when(overdueMs) ?? 'not set'}`,
            whoToCall ? `Call      ${whoToCall}` : 'Call      your local marine rescue or water police',
        ]),
        waypoints.length > 0 ? section('INTENDED TRACK', waypoints) : null,
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
