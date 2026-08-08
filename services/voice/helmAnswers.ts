/**
 * helmAnswers — turn a helm query plus an instrument snapshot into the exact
 * words to say.
 *
 * TERSE IS A SAFETY PROPERTY, not a style preference. At the helm in weather
 * every extra word is time the skipper spends listening instead of steering.
 * "Six point two metres." is the whole answer. Calypso's "Good morning, Cap'n"
 * belongs at anchor.
 *
 * NEVER SPEAK A STALE NUMBER AS CURRENT. This is the rule the whole file is
 * built around. An instrument that stopped reporting thirty seconds ago still
 * holds its last value, and reading it aloud in a confident voice is
 * indistinguishable from a live reading — the skipper has no way to tell. A
 * dead depth sounder that says "six point two metres" while the boat is in two
 * is the worst thing this feature could do. So a dead reading says it is dead,
 * and a stale one says how old it is.
 *
 * Pure: snapshot in, string out. No stores, no clock of its own, no device.
 */
import type { HelmQuery } from './helmGrammar';

export type Freshness = 'live' | 'stale' | 'dead';

export interface Reading {
    value: number | null;
    freshness: Freshness;
}

export interface HelmSnapshot {
    /** Depth below the transducer, in metres, as NMEA reports it. */
    depth: Reading;
    /** What the skipper wants to hear it in. */
    depthUnit: 'm' | 'ft';
    heading: Reading;
    cog: Reading;
    sog: Reading;
    /** True wind speed (kt) and direction (°T). */
    tws: Reading;
    twd: Reading;
    /** Apparent wind speed (kt) and signed angle (° , negative to port). */
    aws: Reading;
    awa: Reading;
    waterTemp: Reading;
    /** Station pressure in hPa from the phone's own barometer. */
    pressureHpa: number | null;
    /** 3-hour tendency in hPa, signed. Null when there is not enough history. */
    pressureTrend3h: number | null;
    position: { latitude: number; longitude: number } | null;
    anchor: {
        armed: boolean;
        /** Metres from the set anchor position. */
        distanceM: number | null;
        radiusM: number | null;
        dragging: boolean;
    } | null;
    /** Caller supplies the clock so this stays pure. */
    now: Date;
}

const METRES_TO_FEET = 3.28084;

/**
 * Bearings as separate digits — "zero four five" — because that is how they
 * are said and heard at sea, and because a synthesiser given "045°" will
 * happily read it as "forty-five".
 */
export function spokenBearing(degrees: number): string {
    const rounded = ((Math.round(degrees) % 360) + 360) % 360;
    const digits = rounded.toString().padStart(3, '0').split('');
    const names = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    return digits.map((d) => names[Number(d)]).join(' ');
}

/** One decimal, and no trailing ".0" for a synthesiser to say out loud. */
function num(value: number, decimals = 1): string {
    const fixed = value.toFixed(decimals);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** Degrees and minutes, the way a position is read over the radio. */
export function spokenLatLon(latitude: number, longitude: number): string {
    const part = (value: number, positive: string, negative: string) => {
        const hemisphere = value >= 0 ? positive : negative;
        const abs = Math.abs(value);
        const degrees = Math.floor(abs);
        const minutes = (abs - degrees) * 60;
        return `${degrees} degrees ${num(minutes, 1)} minutes ${hemisphere}`;
    };
    return `${part(latitude, 'north', 'south')}, ${part(longitude, 'east', 'west')}`;
}

/**
 * How to describe an instrument that is not reporting. Names the instrument so
 * the answer is actionable — "no depth" tells the skipper which sensor to
 * suspect, where "no data" tells them nothing.
 */
function unavailable(what: string, freshness: Freshness): string {
    return freshness === 'dead' || freshness === 'stale'
        ? `No ${what} — instrument not reporting.`
        : `No ${what} available.`;
}

/** A live reading, or the reason there isn't one. */
function reading(r: Reading, what: string, format: (value: number) => string): string {
    if (r.value === null || !Number.isFinite(r.value)) return unavailable(what, r.freshness);
    if (r.freshness === 'dead') return unavailable(what, 'dead');
    // Stale still gets spoken — it may be all there is — but never bare.
    const body = format(r.value);
    if (r.freshness !== 'stale') return body;
    // Drop the reading's own full stop first; "6.2 metres. — stale." makes a
    // synthesiser pause mid-answer as though it had finished.
    return `${body.replace(/\.$/, '')} — stale.`;
}

export function answerHelmQuery(query: HelmQuery, snap: HelmSnapshot): string {
    switch (query) {
        case 'depth':
            return reading(snap.depth, 'depth', (metres) =>
                snap.depthUnit === 'ft' ? `${num(metres * METRES_TO_FEET)} feet.` : `${num(metres)} metres.`,
            );

        case 'heading':
            return reading(snap.heading, 'heading', (deg) => `Heading ${spokenBearing(deg)}.`);

        case 'course':
            // COG is meaningless at rest — it is the direction of a movement
            // that isn't happening, and it wanders freely. Saying so is more
            // use than reading out noise.
            if (snap.sog.value !== null && snap.sog.freshness === 'live' && snap.sog.value < 0.5) {
                return 'Not making way — no course over ground.';
            }
            return reading(snap.cog, 'course', (deg) => `Course ${spokenBearing(deg)}.`);

        case 'speed':
            return reading(snap.sog, 'speed', (kt) => `${num(kt)} knots.`);

        case 'wind': {
            // True wind first — it is what the weather is doing. Apparent is
            // the fallback, labelled, so the two are never confused.
            if (snap.tws.value !== null && snap.tws.freshness !== 'dead') {
                const speed = `${num(snap.tws.value)} knots`;
                const from =
                    snap.twd.value !== null && snap.twd.freshness !== 'dead'
                        ? ` from ${spokenBearing(snap.twd.value)}`
                        : '';
                const stale = snap.tws.freshness === 'stale' ? ' — stale.' : '.';
                return `True wind ${speed}${from}${stale}`;
            }
            if (snap.aws.value !== null && snap.aws.freshness !== 'dead') {
                const speed = `${num(snap.aws.value)} knots`;
                let angle = '';
                if (snap.awa.value !== null && snap.awa.freshness !== 'dead') {
                    const side = snap.awa.value < 0 ? 'port' : 'starboard';
                    angle = ` at ${Math.round(Math.abs(snap.awa.value))} degrees ${side}`;
                }
                const stale = snap.aws.freshness === 'stale' ? ' — stale.' : '.';
                return `Apparent wind ${speed}${angle}${stale}`;
            }
            return unavailable('wind', snap.tws.freshness);
        }

        case 'position':
            if (!snap.position) return 'No position — GPS has no fix.';
            return `${spokenLatLon(snap.position.latitude, snap.position.longitude)}.`;

        case 'water-temp':
            return reading(snap.waterTemp, 'water temperature', (c) => `Water ${num(c)} degrees.`);

        case 'pressure': {
            if (snap.pressureHpa === null) return 'No pressure reading.';
            const now = `${Math.round(snap.pressureHpa)} hectopascals`;
            if (snap.pressureTrend3h === null) return `${now}.`;
            const delta = snap.pressureTrend3h;
            // Under half a hectopascal in three hours is not a trend, it is
            // the sensor. Calling it one would invent weather.
            if (Math.abs(delta) < 0.5) return `${now}, steady.`;
            const direction = delta > 0 ? 'rising' : 'falling';
            return `${now}, ${direction} ${num(Math.abs(delta))} in three hours.`;
        }

        case 'anchor': {
            if (!snap.anchor || !snap.anchor.armed) return 'Anchor watch is off.';
            if (snap.anchor.dragging) return 'Dragging. Anchor alarm is sounding.';
            const { distanceM, radiusM } = snap.anchor;
            if (distanceM === null || radiusM === null) return 'Anchor watch is on. No distance yet.';
            return `Holding. ${Math.round(distanceM)} metres out of ${Math.round(radiusM)}.`;
        }

        case 'time': {
            const hh = snap.now.getHours().toString().padStart(2, '0');
            const mm = snap.now.getMinutes().toString().padStart(2, '0');
            return `${hh} ${mm}.`;
        }
    }
}
