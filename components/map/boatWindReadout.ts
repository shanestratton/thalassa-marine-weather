/**
 * boatWindReadout — her own wind for her own-ship marker, wherever Obs's wind
 * field is not showing it (build 123, W1-WC).
 *
 * Shane 2026-10-07: "what about if it is just the highest zoom (14) as soon as
 * the punter zooms out from there, then the wind models kick in??", then "go
 * do it", on the recommendation that once the models take over her reading
 * moves onto her boat icon as a small arrow and number: a skipper zoomed out
 * never loses sight of what she measures, and when she disagrees with the
 * model it shows at a glance.
 *
 * One truth with the field. MapboxVelocityOverlay publishes here from the
 * very reading the close-in field uses (the same pickers and gates:
 * pickBoatTrueWind via the store lanes, pickCloudTrueWind via her cloud row's
 * 60 s gate), together with whether the field is painting it right now. Her
 * marker shows it only where the field does not, so the two never both claim
 * her wind. Pure and DOM-free: the marker paints it (useVesselTracker).
 *
 * The marker is imperative DOM, so it subscribes directly; the
 * subscribe/get pair is the useSyncExternalStore contract, should a React
 * reader ever want it.
 */
import { CLOSE_IN_CALM_KT, formatCloseInWind, type BoatWind } from './closeInWind';
import type { OwnshipSubject } from './ownshipBoatFix';

/** The boat the location box follows: her skipper's id when crewing, null for the own boat. */
export interface FollowedBoat {
    crewOwnerId: string | null;
}

export interface BoatWindReadout {
    /** Her own true wind now, by the close-in field's own pickers and gates. */
    wind: BoatWind;
    /** Whose wind it is: the boat the location box follows. */
    boat: FollowedBoat;
    /**
     * The wind field on screen is painting her wind now: close-in, in at her
     * zoom (BOAT_WIND_MIN_ZOOM), she on screen, the scrubber at now. Her icon
     * then carries nothing.
     */
    fieldShowsHers: boolean;
}

/**
 * What the overlay publishes: her usable wind for the followed boat, only at
 * now. Scrubbed away, the hour is the model's; following the phone or a
 * place, or with no usable reading, there is nothing of hers to show.
 */
export function resolveBoatWindReadout(input: {
    /** Her wind from the store lanes or her cloud row; null = none usable, or not hers to read. */
    wind: BoatWind | null;
    /** The followed boat; null while the box follows the phone. */
    boat: FollowedBoat | null;
    scrubAtNow: boolean;
    fieldShowsHers: boolean;
}): BoatWindReadout | null {
    const { wind, boat, scrubAtNow, fieldShowsHers } = input;
    if (!wind || !boat || !scrubAtNow) return null;
    return { wind, boat, fieldShowsHers };
}

// ── The shared readout ──────────────────────────────────────────

let readout: BoatWindReadout | null = null;
const listeners = new Set<() => void>();

/** Every speed unit the app offers (formatCloseInWind's own keys): her icon reads in one of them. */
const SPEED_UNITS = ['kts', 'mph', 'kmh', 'mps'] as const;

/**
 * Everything her icon can draw from a readout, in any unit: the chip's
 * words (the Calm line, the unit's rounding and the 16-point compass are
 * all in them), its arrow step, its tone, whose it is and whether the field
 * already shows it. Two readouts with the same key look the same on every
 * icon, so an instrument tick that changes nothing visible notifies nobody,
 * and one that crosses any line the chip draws always does.
 */
function visibleKey(r: BoatWindReadout | null): string {
    if (r === null) return '';
    return JSON.stringify([
        r.fieldShowsHers,
        r.boat.crewOwnerId,
        r.wind.stale,
        arrowDegFor(r.wind),
        ...SPEED_UNITS.map((unit) => formatCloseInWind(r.wind, unit)),
    ]);
}

let readoutKey = '';

/** Written by MapboxVelocityOverlay while Obs's wind layer is on; null otherwise. */
export function setBoatWindReadout(next: BoatWindReadout | null): void {
    // None reads '' and any readout's key is a JSON array, so this also tells none from one.
    const key = visibleKey(next);
    if (key === readoutKey) return;
    readout = next ? { wind: { ...next.wind }, boat: { ...next.boat }, fieldShowsHers: next.fieldShowsHers } : null;
    readoutKey = key;
    for (const listener of [...listeners]) listener();
}

export function getBoatWindReadout(): BoatWindReadout | null {
    return readout;
}

export function subscribeBoatWindReadout(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// ── Her icon's chip ─────────────────────────────────────────────

/** The arrow turns in steps this size, so a wandering vane is not a new drawing every tick. */
export const BOAT_WIND_ARROW_STEP_DEG = 5;

export interface BoatWindChip {
    /** formatCloseInWind's words: '14 kt SSW', '6 kt', 'Calm'. */
    text: string;
    /** Where the wind blows TO, deg true, in BOAT_WIND_ARROW_STEP_DEG steps (the way the streaks fly); null = no arrow. */
    arrowDeg: number | null;
    /** The store's stale tier: shown, dimmed. */
    stale: boolean;
    /** Its spoken name: 'Boat wind 14 knots from south-south-west'. */
    label: string;
}

const SPOKEN_UNIT: Record<string, readonly [one: string, many: string]> = {
    kt: ['knot', 'knots'],
    mph: ['mile per hour', 'miles per hour'],
    'km/h': ['kilometre per hour', 'kilometres per hour'],
    'm/s': ['metre per second', 'metres per second'],
};

const SPOKEN_POINT: Record<string, string> = {
    N: 'north',
    NNE: 'north-north-east',
    NE: 'north-east',
    ENE: 'east-north-east',
    E: 'east',
    ESE: 'east-south-east',
    SE: 'south-east',
    SSE: 'south-south-east',
    S: 'south',
    SSW: 'south-south-west',
    SW: 'south-west',
    WSW: 'west-south-west',
    W: 'west',
    WNW: 'west-north-west',
    NW: 'north-west',
    NNW: 'north-north-west',
};

/** The chip's own words with the unit and the point spelled out, so the name never says what the chip does not. */
function spokenBoatWind(text: string, stale: boolean): string {
    const match = /^(\d+(?:\.\d+)?) (kt|mph|km\/h|m\/s)(?: ([NESW]{1,3}))?$/.exec(text);
    let words = text === 'Calm' ? 'calm' : text;
    if (match) {
        const [, value, unit, point] = match;
        const [one, many] = SPOKEN_UNIT[unit];
        words = `${value} ${value === '1' ? one : many}${point ? ` from ${SPOKEN_POINT[point] ?? point}` : ''}`;
    }
    return `Boat wind ${words}${stale ? ', stale' : ''}`;
}

/**
 * What her marker shows: nothing unless the readout is for the boat this
 * marker draws (never the phone, never another boat), and nothing while the
 * field already shows her wind. Calm and a direction-less reading carry no
 * arrow; the arrow flies WITH the wind, as the streaks do.
 */
export function boatWindChipFor(
    current: BoatWindReadout | null,
    subject: OwnshipSubject,
    speedUnit: string | undefined,
): BoatWindChip | null {
    if (!current || current.fieldShowsHers) return null;
    if (subject.kind !== 'boat' || subject.crewOwnerId !== current.boat.crewOwnerId) return null;
    const { wind } = current;
    const text = formatCloseInWind(wind, speedUnit);
    return { text, arrowDeg: arrowDegFor(wind), stale: wind.stale, label: spokenBoatWind(text, wind.stale) };
}

/** The arrow: where the wind blows TO, in BOAT_WIND_ARROW_STEP_DEG steps; none for Calm or a direction-less reading. */
function arrowDegFor(wind: BoatWind): number | null {
    const calm = !Number.isFinite(wind.kt) || wind.kt < CLOSE_IN_CALM_KT;
    if (calm || wind.fromDeg === null || !Number.isFinite(wind.fromDeg)) return null;
    const toDeg = (((wind.fromDeg + 180) % 360) + 360) % 360;
    return (Math.round(toDeg / BOAT_WIND_ARROW_STEP_DEG) * BOAT_WIND_ARROW_STEP_DEG) % 360;
}
