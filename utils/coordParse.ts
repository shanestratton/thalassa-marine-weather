/**
 * Coordinate-string parsing — the "type your own GPS position" lane.
 *
 * parseCoordinateString accepts the formats a sailor actually types or
 * pastes (chartplotter readout, cruising guide, a mate's text message):
 *
 *   -27.4698, 153.0251            signed decimal degrees (lat, lon)
 *   27.4698S 153.0251E            hemisphere-suffixed decimal
 *   S27.4698 E153.0251            hemisphere-prefixed decimal
 *   27°28.2'S 153°01.5'E          degrees + decimal minutes (DMM)
 *   27°28'12"S 153°01'30"E        degrees minutes seconds (DMS)
 *   27 28.2 S 153 01.5 E          the same without any symbols
 *
 * Rules that matter:
 *  - CASE-INSENSITIVE: formatLocationInput title-cases the planner's
 *    inputs before geocoding ever sees them, turning 'S into 's.
 *  - WHOLE-STRING ANCHORED: a berth name containing two numbers must
 *    NOT parse. The old inline regex in geocoding.ts matched anywhere
 *    and silently routed "Berth 2, 153 Marina" to the open ocean.
 *  - RANGE-VALIDATED: ±90 / ±180, minutes and seconds < 60.
 *  - AXIS BY LETTER: with hemisphere letters present, N/S names the
 *    latitude and E/W the longitude whichever order they're typed in.
 *  - null ON DOUBT: anything ambiguous falls through to the normal
 *    geocoding chain rather than guessing a pin.
 *
 * The planner's own canonical "Name (lat, lon)" strings are NOT this
 * module's job — utils/savedLocations.extractCoords owns that suffix.
 */

export interface ParsedCoords {
    lat: number;
    lon: number;
}

/**
 * Normalise the typographic zoo: unicode minus, degree/prime variants,
 * colons-as-separators (some chartplotters), NBSP. Uppercased so the
 * hemisphere letters survive whatever casing the formatter applied.
 */
function normalise(input: string): string {
    return input
        .toUpperCase()
        .replace(/\u2212/g, '-') // unicode minus from copied web pages
        .replace(/[\u00BA\u00B0]/g, '\u00B0') // masculine ordinal masquerading as degree
        .replace(/[\u2032\u2019`]/g, "'") // prime / curly quote -> minute mark
        .replace(/[\u2033\u201D]/g, '"') // double prime / curly quote -> second mark
        .replace(/[:\u00A0]/g, ' ') // chartplotter colons + NBSP -> plain space
        .trim();
}

/**
 * Parse one axis chunk — "27°28.2'", "153 01.5", "27.4698", '27°28\'12"'.
 * Returns unsigned decimal degrees, or null when the chunk isn't a
 * clean degrees[/minutes[/seconds]] reading.
 */
function parseAxisValue(raw: string): number | null {
    const cleaned = raw.replace(/[,;]/g, ' ').trim();
    const m = cleaned.match(
        /^(\d{1,3}(?:\.\d+)?)\s*(?:°\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:'\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"\s*)?)?)?$/,
    );
    if (!m) return null;
    const deg = parseFloat(m[1]);
    const min = m[2] !== undefined ? parseFloat(m[2]) : 0;
    const sec = m[3] !== undefined ? parseFloat(m[3]) : 0;
    // Fractional degrees can't take minutes, fractional minutes can't
    // take seconds — "27.5 30 S" is a typo, not a position.
    if (m[2] !== undefined && m[1].includes('.')) return null;
    if (m[3] !== undefined && m[2] !== undefined && m[2].includes('.')) return null;
    if (min >= 60 || sec >= 60) return null;
    return deg + min / 60 + sec / 3600;
}

function inRange(lat: number, lon: number): boolean {
    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** Signed decimal pair: "-27.4698, 153.0251" / "-27.4698 153.0251". */
function parseDecimalPair(up: string): ParsedCoords | null {
    const m = up.match(/^([+-]?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d{1,3}(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!inRange(lat, lon)) return null;
    return { lat, lon };
}

/**
 * Hemisphere-lettered pair, decimal/DMM/DMS, letters prefixed or
 * suffixed, either axis order.
 */
function parseLetteredPair(up: string): ParsedCoords | null {
    // Only coordinate characters allowed — one stray word ("MARINA")
    // and this is a place name, not a position.
    if (!/^[NSEW\d\s°'".,;+-]+$/.test(up)) return null;
    const letters = [...up.matchAll(/[NSEW]/g)];
    if (letters.length !== 2) return null;
    const [l1, l2] = letters;
    const i1 = l1.index ?? 0;
    const i2 = l2.index ?? 0;

    let chunk1: string;
    let chunk2: string;
    if (/^[NSEW]/.test(up)) {
        // Prefixed: "S27.4698 E153.0251" — letters lead their numbers.
        chunk1 = up.slice(i1 + 1, i2);
        chunk2 = up.slice(i2 + 1);
    } else {
        // Suffixed: "27.4698S, 153.0251E" — letters trail their numbers.
        if (up.slice(i2 + 1).trim() !== '') return null;
        chunk1 = up.slice(0, i1);
        chunk2 = up.slice(i1 + 1, i2);
    }

    const v1 = parseAxisValue(chunk1);
    const v2 = parseAxisValue(chunk2);
    if (v1 === null || v2 === null) return null;

    let lat: number | null = null;
    let lon: number | null = null;
    for (const [hemi, value] of [
        [l1[0], v1],
        [l2[0], v2],
    ] as Array<[string, number]>) {
        if (hemi === 'N' || hemi === 'S') {
            if (lat !== null) return null; // two latitudes — nonsense
            lat = hemi === 'S' ? -value : value;
        } else {
            if (lon !== null) return null; // two longitudes — nonsense
            lon = hemi === 'W' ? -value : value;
        }
    }
    if (lat === null || lon === null) return null;
    if (!inRange(lat, lon)) return null;
    return { lat, lon };
}

/**
 * Parse a free-typed coordinate string in any supported mariner format.
 * Returns null when the string isn't (unambiguously) a coordinate pair —
 * callers fall through to their normal geocoding.
 */
export function parseCoordinateString(input: string): ParsedCoords | null {
    if (!input || typeof input !== 'string') return null;
    const up = normalise(input);
    if (up.length === 0 || !/\d/.test(up)) return null;
    return parseDecimalPair(up) ?? parseLetteredPair(up);
}
