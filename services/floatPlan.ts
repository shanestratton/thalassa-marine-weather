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
    /** Optional per-person roster — the USCG persons-onboard table. Names
     * (and a short note each: role, age, medical) beat a bare count when a
     * coordinator is deciding what to send. */
    personsRoster?: Array<{ name: string; note?: string }>;
    /** Days of food and water aboard for the persons listed. */
    provisionsDays?: number;
    /** IANA zone used for every displayed time, e.g. Australia/Brisbane.
     * Defaults to the device zone, but callers may pin it for a passage. */
    timeZone?: string;
}

export type FloatPlanChannel = 'sms' | 'whatsapp' | 'email' | 'generic';

export interface FloatPlanSharePayload {
    channel: FloatPlanChannel;
    title: string;
    /** Email subject. Kept separately because native share sheets do not
     * reliably map `title` into a mail subject. */
    subject?: string;
    text: string;
    characterCount: number;
    smsSegments?: number;
}

export interface FloatPlanValidation {
    errors: string[];
    warnings: string[];
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

function resolvedTimeZone(requested?: string): string {
    if (requested) {
        try {
            new Intl.DateTimeFormat('en-AU', { timeZone: requested }).format(0);
            return requested;
        } catch {
            /* fall through to the device zone */
        }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function when(ms: number | null | undefined, timeZone?: string): string | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return new Date(ms).toLocaleString([], { ...DATE_OPTS, timeZone: resolvedTimeZone(timeZone) });
}

/** "AEST (UTC+10)" rather than the ambiguous "local time". */
export function floatPlanTimeZoneLabel(ms: number, requestedTimeZone?: string): string {
    const timeZone = resolvedTimeZone(requestedTimeZone);
    const date = new Date(Number.isFinite(ms) ? ms : Date.now());
    const part = (timeZoneName: 'short' | 'shortOffset'): string =>
        new Intl.DateTimeFormat('en-AU', { timeZone, timeZoneName })
            .formatToParts(date)
            .find((p) => p.type === 'timeZoneName')?.value || '';
    const short = part('short');
    const offset = part('shortOffset')
        .replace(/^GMT/, 'UTC')
        .replace(/UTC([+-])0(\d)(?::00)?$/, 'UTC$1$2')
        .replace(/:00$/, '');
    if (!short || short === 'UTC' || short.startsWith('GMT') || short.startsWith('UTC'))
        return offset || short || 'UTC';
    return offset && offset !== short ? `${short} (${offset})` : short;
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

export interface FloatPlanDocument {
    input: FloatPlanInput;
    vesselName: string;
    identity: string;
    description: string;
    liferaft: string;
    trackPoints: { lat: number; lon: number }[];
    trackWasThinned: boolean;
    plottedPointCount: number;
    distanceNM: number | null;
    features: string;
    comms: string;
    propulsion: string;
    rosterLines: string[];
    departure: string;
    eta: string | null;
    overdue: string;
    timeZoneLabel: string;
    rescueContact: string;
}

function oneLine(value: string | null | undefined): string {
    return (
        value
            ?.replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || ''
    );
}

/**
 * A float plan is only actionable when the shore contact is told exactly
 * where to raise the alarm. Requiring at least a short emergency number
 * (000/112) also accepts normal local and international phone formats while
 * rejecting a place name that the recipient would still have to research in
 * an emergency.
 */
function hasActionableRescueContact(value: string | null | undefined): boolean {
    const contact = oneLine(value);
    const digitCount = (contact.match(/\d/g) ?? []).length;
    return contact.length > 0 && digitCount >= 3;
}

export function prepareFloatPlan(input: FloatPlanInput): FloatPlanDocument {
    const { vessel, route } = input;
    const vesselName = oneLine(vessel?.name) || 'Unnamed vessel';
    const identity = joinParts([
        vessel?.hailingPort ? `Hailing port ${oneLine(vessel.hailingPort)}` : null,
        vessel?.registration ? `Rego ${oneLine(vessel.registration)}` : null,
        vessel?.mmsi ? `MMSI ${oneLine(vessel.mmsi)}` : null,
        vessel?.callSign ? `Call sign ${oneLine(vessel.callSign)}` : null,
    ]);
    const description = joinParts([
        oneLine(vessel?.model),
        vessel?.type === 'sail' ? 'sail' : vessel?.type === 'power' ? 'power' : null,
        vessel?.hullType,
        vessel?.hullMaterial ? oneLine(vessel.hullMaterial) : null,
        typeof vessel?.length === 'number' && vessel.length > 0 ? `${Math.round(vessel.length)} ft` : null,
        // Draft is stored in FEET (see services/units.ts vesselDraftMetres).
        typeof vessel?.draft === 'number' && vessel.draft > 0 ? `${vessel.draft.toFixed(1)} ft draft` : null,
        vessel?.hullColor ? `${oneLine(vessel.hullColor)} hull` : null,
        vessel?.trimColor ? `${oneLine(vessel.trimColor)} trim` : null,
    ]);
    // What a search aircraft should LOOK for — USCG 'prominent features'.
    const features = vessel?.prominentFeatures ? `Look for: ${oneLine(vessel.prominentFeatures)}` : '';
    const comms = joinParts(
        [
            vessel?.radiosMonitored ? `Radios: ${oneLine(vessel.radiosMonitored)}` : null,
            vessel?.satPhone ? `Sat phone ${oneLine(vessel.satPhone)}` : null,
        ],
        '; ',
    );
    const propulsion = joinParts([
        typeof vessel?.fuelCapacity === 'number' && vessel.fuelCapacity > 0
            ? `Fuel ${Math.round(vessel.fuelCapacity)} L`
            : null,
        typeof vessel?.waterCapacity === 'number' && vessel.waterCapacity > 0
            ? `water ${Math.round(vessel.waterCapacity)} L`
            : null,
        typeof vessel?.cruisingSpeed === 'number' && vessel.cruisingSpeed > 0
            ? `cruise ${Math.round(vessel.cruisingSpeed)} kn`
            : null,
    ]);
    const rosterLines = (input.personsRoster ?? [])
        .map((person) => ({ name: oneLine(person.name), note: oneLine(person.note) }))
        .filter((person) => person.name.length > 0)
        .map((person, index) => `${index + 1}. ${person.name}${person.note ? ` — ${person.note}` : ''}`);
    const liferaft = joinParts(
        [
            typeof vessel?.liferaftCapacity === 'number' && vessel.liferaftCapacity > 0
                ? `Liferaft ${vessel.liferaftCapacity} person`
                : null,
            vessel?.liferaftServiceDate ? `serviced ${oneLine(vessel.liferaftServiceDate)}` : null,
        ],
        ', ',
    );
    const allWaypoints = route.waypoints ?? [];
    const { points: trackPoints, thinned } = keyTrackPoints(allWaypoints);
    const distanceNM =
        typeof route.distanceNM === 'number' && route.distanceNM > 0
            ? route.distanceNM
            : allWaypoints.length >= 2
              ? trackDistanceNM(allWaypoints)
              : null;

    return {
        input,
        vesselName,
        identity,
        description,
        liferaft,
        trackPoints,
        trackWasThinned: thinned,
        plottedPointCount: allWaypoints.length,
        distanceNM,
        features,
        comms,
        propulsion,
        rosterLines,
        departure: when(input.departureMs, input.timeZone) ?? 'not set',
        eta: when(input.etaMs, input.timeZone),
        overdue: when(input.overdueMs, input.timeZone) ?? 'not set',
        timeZoneLabel: floatPlanTimeZoneLabel(input.overdueMs, input.timeZone),
        rescueContact:
            oneLine(input.whoToCall) || 'NOT SET — add a jurisdiction-specific rescue phone number before sharing',
    };
}

function sampledTrack(points: { lat: number; lon: number }[], maximum: number): { lat: number; lon: number }[] {
    if (points.length <= maximum) return points;
    return Array.from({ length: maximum }, (_, i) => points[Math.round((i * (points.length - 1)) / (maximum - 1))]);
}

function trackLines(
    document: FloatPlanDocument,
    options: { maximum?: number; coordinate?: (point: { lat: number; lon: number }) => string } = {},
): string[] {
    const points = sampledTrack(document.trackPoints, options.maximum ?? 12);
    const coordinate = options.coordinate ?? floatPlanCoord;
    const lines = points.map((point, index) => {
        const tag = index === 0 ? ' (depart)' : index === points.length - 1 ? ' (destination)' : '';
        return `${index + 1}. ${coordinate(point)}${tag}`;
    });
    if ((document.trackWasThinned || points.length < document.trackPoints.length) && lines.length > 0) {
        lines.push(`Key positions of ${document.plottedPointCount} plotted; full route is aboard.`);
    }
    return lines;
}

function whatsappSafe(value: string): string {
    return oneLine(value)
        .replace(/\\/g, '\\\\')
        .replace(/([*_~`])/g, '\\$1');
}

function emailHeaderSafe(value: string): string {
    return oneLine(value).slice(0, 180);
}

function smsCoordinate(point: { lat: number; lon: number }): string {
    const dm = (value: number): string => {
        const absolute = Math.abs(value);
        return `${Math.floor(absolute)} ${((absolute - Math.floor(absolute)) * 60).toFixed(1).padStart(4, '0')}`;
    };
    return `${dm(point.lat)}${point.lat >= 0 ? 'N' : 'S'} ${dm(point.lon)}${point.lon >= 0 ? 'E' : 'W'}`;
}

function smsAscii(value: string): string {
    const normalized = value
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/×/g, 'x')
        .replace(/·/g, '|')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');

    return [...normalized]
        .filter((character) => {
            const codePoint = character.codePointAt(0) ?? -1;
            return character === '\n' || character === '\r' || (codePoint >= 0x20 && codePoint <= 0x7e);
        })
        .join('');
}

const GSM_BASIC = new Set(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'.split(
        '',
    ),
);
const GSM_EXTENDED = new Set('^{}\\[~]|€'.split(''));

export function estimateSmsSegments(text: string): number {
    let units = 0;
    let gsm = true;
    for (const character of text) {
        if (GSM_BASIC.has(character)) units += 1;
        else if (GSM_EXTENDED.has(character)) units += 2;
        else {
            gsm = false;
            break;
        }
    }
    if (!gsm) return Math.max(1, Math.ceil([...text].length / ([...text].length <= 70 ? 70 : 67)));
    return Math.max(1, Math.ceil(units / (units <= 160 ? 160 : 153)));
}

export function composeFloatPlan(input: FloatPlanInput): string {
    const document = prepareFloatPlan(input);
    const { route } = input;
    const intendedTrack = trackLines(document);

    const blocks: (string | null)[] = [
        `FLOAT PLAN — ${document.vesselName}`,
        // The point of the whole document, so it comes FIRST — the person
        // ashore should not scroll past the boat's paint colour to find out
        // when to start worrying. Always rendered.
        section('IF YOU HAVE NOT HEARD FROM US', [
            `No contact by: ${document.overdue} ${document.timeZoneLabel}`,
            `Call: ${document.rescueContact}`,
        ]),
        section('PASSAGE', [
            route.name ? `Plan: ${oneLine(route.name)}` : null,
            route.from ? `From: ${oneLine(route.from)}` : null,
            `Depart: ${document.departure}`,
            route.to ? `To: ${oneLine(route.to)}` : null,
            document.eta ? `ETA: ${document.eta}` : null,
            document.distanceNM ? `Distance: ${document.distanceNM.toFixed(0)} NM` : null,
        ]),
        // USCG float-plan section taxonomy (v10.2) without the branding:
        // VESSEL / SAFETY & SURVIVAL / PERSONS ONBOARD — but the alarm block
        // stays FIRST; a message is read top-down, unlike a wall form.
        section('VESSEL', vesselLines(document)),
        section('SAFETY & SURVIVAL', safetyLines(document)),
        section('PERSONS ONBOARD', personsLines(document)),
        intendedTrack.length > 0 ? section('INTENDED TRACK', intendedTrack) : null,
        `Please reply RECEIVED. Keep this plan until we send a safe-arrival message.\nPrepared in Thalassa. Thalassa does not upload this plan. Verify the recipients and audience in the destination app before sending. All times ${document.timeZoneLabel}.`,
    ];

    return blocks.filter((b): b is string => Boolean(b)).join('\n\n');
}

function safetyLines(document: FloatPlanDocument, options: { compact?: boolean } = {}): string[] {
    const vessel = document.input.vessel;
    const provisionsDays = document.input.provisionsDays;
    // compact = the SMS set. A USCG-scale field list explodes GSM segment
    // count, so SMS keeps the pre-restructure essentials only.
    const extended = options.compact
        ? []
        : [
              vessel?.tenderDescription ? `Tender: ${oneLine(vessel.tenderDescription)}` : '',
              typeof provisionsDays === 'number' && provisionsDays > 0
                  ? `Provisions ~${Math.round(provisionsDays)} days`
                  : '',
          ];
    return [
        vessel?.epirbHexId ? `EPIRB hex ${oneLine(vessel.epirbHexId)}` : '',
        document.liferaft,
        vessel?.flaresExpiry ? `Flares expire ${oneLine(vessel.flaresExpiry)}` : '',
        ...extended,
        oneLine(vessel?.safetyNotes),
    ].filter(Boolean);
}

/** The VESSEL block, USCG-shaped: description, identity, what to look for,
 *  communication fit, propulsion/endurance. One line each, empties dropped. */
function vesselLines(document: FloatPlanDocument): string[] {
    return [document.description, document.identity, document.features, document.comms, document.propulsion].filter(
        Boolean,
    );
}

/** PERSONS ONBOARD, USCG-shaped: count, roster, how to reach the boat. */
function personsLines(document: FloatPlanDocument): string[] {
    const { personsOnBoard, contactAboard } = document.input;
    return [
        typeof personsOnBoard === 'number' && personsOnBoard > 0 ? `${personsOnBoard} on board` : '',
        ...document.rosterLines,
        contactAboard ? `Contact aboard: ${oneLine(contactAboard)}` : '',
    ].filter(Boolean);
}

function formatEmail(document: FloatPlanDocument): string {
    const { input } = document;
    const routeLine = joinParts([oneLine(input.route.from), oneLine(input.route.to)], ' → ');
    const blocks = [
        [`FLOAT PLAN | ${document.vesselName}`, routeLine].filter(Boolean).join('\n'),
        [
            'RAISE THE ALARM',
            `No contact by: ${document.overdue} ${document.timeZoneLabel}`,
            `Call: ${document.rescueContact}`,
        ].join('\n'),
        [
            'PASSAGE',
            input.route.name ? `Plan: ${oneLine(input.route.name)}` : '',
            input.route.from ? `From: ${oneLine(input.route.from)}` : '',
            `Departure: ${document.departure}`,
            input.route.to ? `To: ${oneLine(input.route.to)}` : '',
            document.eta ? `ETA: ${document.eta}` : '',
            document.distanceNM ? `Distance: ${document.distanceNM.toFixed(0)} NM` : '',
        ]
            .filter(Boolean)
            .join('\n'),
        ['VESSEL', ...vesselLines(document)].filter(Boolean).join('\n'),
        ['SAFETY & SURVIVAL', ...safetyLines(document)].filter(Boolean).join('\n'),
        [
            'PERSONS ONBOARD',
            `People aboard: ${input.personsOnBoard && input.personsOnBoard > 0 ? input.personsOnBoard : 'not set'}`,
            ...document.rosterLines,
            input.contactAboard ? `Contact aboard: ${oneLine(input.contactAboard)}` : '',
        ]
            .filter(Boolean)
            .join('\n'),
        document.trackPoints.length > 0 ? ['INTENDED TRACK', ...trackLines(document)].join('\n') : '',
        ['IF WE ARE OVERDUE — WHAT TO DO', ...emergencyGuideLines(document)].join('\n'),
        `Please reply RECEIVED so we know you have this plan.\nKeep it until we send a safe-arrival message.\n\nPrepared in Thalassa. Thalassa does not upload this plan. Verify the recipient before sending. All times ${document.timeZoneLabel}.`,
    ];
    return blocks.filter(Boolean).join('\n\n────────────────────\n\n');
}

/**
 * What the holder actually does when we are overdue.
 *
 * This is the part that matters. The rest of the plan is reference; this is the
 * only section anyone reads under stress, at 2am, half asleep, worried.
 *
 * The Coast Guard Auxiliary's own guide covers the same ground but does it as a
 * seven-step flow of nested IF/THEN tables, which is hard to follow at the best
 * of times. Ours is a ladder: one instruction per rung, each ending in a plain
 * test for whether to climb the next. Written from scratch — theirs is
 * copyrighted, and in any case a document read in a panic should be readable in
 * a panic.
 *
 * Two things are deliberate. The first rung gives permission to do nothing
 * before the overdue time, because a holder who panics early burns the goodwill
 * that gets a real search started. And "say you do not know" is stated
 * explicitly: a helpful guess sends aircraft to the wrong patch of sea.
 */
function emergencyGuideLines(document: FloatPlanDocument): string[] {
    const { input } = document;
    const lines: string[] = [
        `Nothing needs doing before ${document.overdue} ${document.timeZoneLabel}. If you have not heard from`,
        'us by then, work down this list. Stop as soon as you are no longer worried.',
        '',
        '1. Try us first.',
    ];

    lines.push(
        input.contactAboard
            ? `   ${oneLine(input.contactAboard)}`
            : '   Use whatever number or radio you normally reach us on.',
    );
    lines.push('   If you get us, you are done — nothing else here applies.', '');

    // Named people beat a category. "Ask anyone who might have heard" is
    // useless at 2am; a name and a number is something a frightened person can
    // actually do. This is also the rung that prevents most false alarms — the
    // usual answer is that somebody has already heard from the boat.
    const ashore = [input.vessel?.shoreContact1, input.vessel?.shoreContact2]
        .map((entry) => oneLine(entry))
        .filter(Boolean);

    if (ashore.length > 0) {
        lines.push('2. Ring the people ashore who might have heard from us.');
        ashore.forEach((entry) => lines.push(`   ${entry}`));
        lines.push('   If any of them has had contact and you are satisfied, you are done.', '');
    } else {
        lines.push(
            '2. Ask anyone else who might have heard from us.',
            '   Marina, harbour office, family, another boat we were travelling with.',
            '   If someone has had contact and you are satisfied, you are done.',
            '',
        );
    }

    lines.push(
        '3. Still worried? Make the call.',
        `   ${document.rescueContact}`,
        '   Say: "I am reporting an overdue vessel." Then read them this plan from the top.',
        '',
        '4. Tell them only what is written here.',
        '   If you do not know something, say you do not know. A guess is worse than a gap —',
        '   it can send a search to the wrong stretch of coast.',
        '',
        '5. Stay reachable.',
        '   Keep your phone free. They will ring back for more, and you are now the person',
        '   who knows most about where we are.',
    );

    return lines;
}

function formatWhatsApp(document: FloatPlanDocument): string {
    const { input } = document;
    const line = (label: string, value: string): string => `*${label}:* ${whatsappSafe(value)}`;
    const safety = safetyLines(document).map((item) => `• ${whatsappSafe(item)}`);
    const track = trackLines(document).map((item) => `• ${whatsappSafe(item)}`);
    const people = input.personsOnBoard && input.personsOnBoard > 0 ? String(input.personsOnBoard) : 'not set';

    return [
        `🛟 *FLOAT PLAN — ${whatsappSafe(document.vesselName)}*`,
        input.route.from || input.route.to
            ? `_${whatsappSafe(oneLine(input.route.from) || 'Departure')} → ${whatsappSafe(oneLine(input.route.to) || 'Destination')}_`
            : '',
        '',
        '🚨 *RAISE THE ALARM*',
        line('No contact by', `${document.overdue} ${document.timeZoneLabel}`),
        line('Call', document.rescueContact),
        '',
        '🧭 *PASSAGE*',
        input.route.name ? line('Plan', oneLine(input.route.name)) : '',
        input.route.from ? line('From', oneLine(input.route.from)) : '',
        line('Departure', document.departure),
        input.route.to ? line('To', oneLine(input.route.to)) : '',
        document.eta ? line('ETA', document.eta) : '',
        document.distanceNM ? line('Distance', `${document.distanceNM.toFixed(0)} NM`) : '',
        '',
        '⛵ *VESSEL*',
        ...vesselLines(document).map((item) => `• ${whatsappSafe(item)}`),
        '',
        safety.length > 0 ? '🛟 *SAFETY & SURVIVAL*' : '',
        ...safety,
        safety.length > 0 ? '' : '',
        '👥 *PERSONS ONBOARD*',
        line('Aboard', people),
        ...document.rosterLines.map((item) => `• ${whatsappSafe(item)}`),
        input.contactAboard ? line('Reach us', oneLine(input.contactAboard)) : '',
        safety.length > 0 ? '' : '',
        track.length > 0 ? '📍 *INTENDED TRACK*' : '',
        ...track,
        '',
        '✅ *Please reply RECEIVED.*',
        '_Keep this plan until we send a safe-arrival message._',
        `_Prepared in Thalassa · Thalassa does not upload this plan · Verify the recipient before sending · All times ${whatsappSafe(document.timeZoneLabel)}_`,
    ]
        .filter((item, index, all) => item !== '' || (index > 0 && all[index - 1] !== ''))
        .join('\n')
        .trim();
}

function formatSms(document: FloatPlanDocument): string {
    const { input } = document;
    const people = input.personsOnBoard && input.personsOnBoard > 0 ? String(input.personsOnBoard) : 'NOT SET';
    const passage = [
        input.route.from ? `FROM ${oneLine(input.route.from)}` : '',
        input.route.to ? `TO ${oneLine(input.route.to)}` : '',
        `DEP ${document.departure}`,
        document.eta ? `ETA ${document.eta}` : '',
        document.distanceNM ? `${document.distanceNM.toFixed(0)} NM` : '',
    ].filter(Boolean);
    const vessel = [document.description, document.identity].filter(Boolean).join(' | ');
    const safety = safetyLines(document, { compact: true }).join('; ');
    const track = trackLines(document, { maximum: 4, coordinate: smsCoordinate });

    return smsAscii(
        [
            `FLOAT PLAN: ${document.vesselName}`,
            `OVERDUE: ${document.overdue} ${document.timeZoneLabel}`,
            `CALL: ${document.rescueContact}`,
            `PASSAGE: ${passage.join(' | ')}`,
            `POB: ${people}${input.contactAboard ? ` | CONTACT: ${oneLine(input.contactAboard)}` : ''}`,
            vessel ? `VESSEL: ${vessel}` : '',
            safety ? `SAFETY: ${safety}` : 'SAFETY: not recorded',
            track.length > 0 ? `TRACK: ${track.join(' > ')}` : '',
            'Reply RECEIVED. Keep until safe-arrival message. Thalassa does not upload this plan. Check recipient before send.',
        ]
            .filter(Boolean)
            .join('\n'),
    );
}

export function createFloatPlanSharePayload(input: FloatPlanInput, channel: FloatPlanChannel): FloatPlanSharePayload {
    const document = prepareFloatPlan(input);
    const routeLabel = [oneLine(input.route.from), oneLine(input.route.to)].filter(Boolean).join(' to ');
    const subject = emailHeaderSafe(`Float plan | ${document.vesselName}${routeLabel ? ` | ${routeLabel}` : ''}`);
    const text =
        channel === 'email'
            ? formatEmail(document)
            : channel === 'whatsapp'
              ? formatWhatsApp(document)
              : channel === 'sms'
                ? formatSms(document)
                : composeFloatPlan(input);
    return {
        channel,
        title: subject,
        subject: channel === 'email' ? subject : undefined,
        text,
        characterCount: [...text].length,
        smsSegments: channel === 'sms' ? estimateSmsSegments(text) : undefined,
    };
}

export function createFloatPlanShareUrl(
    payload: FloatPlanSharePayload,
    platform: 'ios' | 'android' | 'web' = 'web',
): string | null {
    if (payload.channel === 'email') {
        return `mailto:?subject=${encodeURIComponent(payload.subject || payload.title)}&body=${encodeURIComponent(payload.text)}`;
    }
    if (payload.channel === 'sms') {
        return `sms:${platform === 'ios' ? '&' : '?'}body=${encodeURIComponent(payload.text)}`;
    }
    if (payload.channel === 'whatsapp') return `https://wa.me/?text=${encodeURIComponent(payload.text)}`;
    return null;
}

export function validateFloatPlan(input: FloatPlanInput, nowMs = Date.now()): FloatPlanValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const departureValid = Number.isFinite(input.departureMs);
    const overdueValid = Number.isFinite(input.overdueMs);
    const etaValid = input.etaMs == null || Number.isFinite(input.etaMs);

    if (!oneLine(input.vessel?.name)) errors.push('Add the vessel name before sharing.');
    if (!oneLine(input.route.from)) errors.push('Add a departure place.');
    if (!oneLine(input.route.to)) errors.push('Add a destination.');
    if (!departureValid) errors.push('Set a valid departure time.');
    if (!overdueValid) errors.push('Set a valid overdue time.');
    if (!etaValid) errors.push('Set a valid ETA.');
    if (overdueValid && input.overdueMs <= nowMs) errors.push('The overdue time must be in the future.');
    const afterMs = Number.isFinite(input.etaMs) ? Number(input.etaMs) : input.departureMs;
    if (overdueValid && Number.isFinite(afterMs) && input.overdueMs <= afterMs) {
        errors.push(`The overdue time must be after the ${Number.isFinite(input.etaMs) ? 'ETA' : 'departure'}.`);
    }
    if (!Number.isInteger(input.personsOnBoard) || Number(input.personsOnBoard) <= 0) {
        errors.push('Set the number of people aboard.');
    }
    if (
        (input.route.waypoints ?? []).some(
            (point) =>
                !Number.isFinite(point.lat) ||
                !Number.isFinite(point.lon) ||
                point.lat < -90 ||
                point.lat > 90 ||
                point.lon < -180 ||
                point.lon > 180,
        )
    ) {
        errors.push('The intended track contains an invalid position.');
    }
    if (!hasActionableRescueContact(input.whoToCall)) {
        errors.push(
            'Add the jurisdiction-specific rescue contact and phone number your shore contact must call if you are overdue.',
        );
    }
    if (!oneLine(input.contactAboard)) warnings.push('Add a phone, VHF watch, or satellite contact if available.');
    if (!oneLine(input.vessel?.epirbHexId)) warnings.push('No EPIRB hex ID is recorded.');
    const rosterNames = (input.personsRoster ?? []).filter((person) => oneLine(person.name).length > 0).length;
    if (rosterNames > 0 && typeof input.personsOnBoard === 'number' && rosterNames !== input.personsOnBoard) {
        warnings.push(
            `The roster lists ${rosterNames} name${rosterNames === 1 ? '' : 's'} but persons on board is ${input.personsOnBoard}.`,
        );
    }

    return { errors: [...new Set(errors)], warnings };
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
