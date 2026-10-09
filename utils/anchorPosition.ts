/**
 * The Move anchor sheet's Position field (build 126, 126-07b): a position
 * typed the way a skipper copies it from the plotter, a guide or a text
 * message, and the readback that shows how it was read.
 *
 * parseAnchorPosition takes everything parseCoordinateString does (signed
 * decimal; hemisphere letters before or after; DMM and DMS, with or without
 * symbols; any case) and the decimal comma half the world writes:
 *
 *   -16,78 179,335          16,78 S 179,335 E          S 16,78; E 179,335
 *   16 46,8 S 179 20,1 E    (decimal-comma minutes, as a European plotter shows them)
 *
 * Only where a comma cannot be mistaken. A comma between two digits is a
 * decimal comma; a comma beside a hemisphere letter (spaces allowed) ends that
 * half of the position, so it separates them ("16 46,8 S, 179 20,1 E"). Any
 * other comma in a text with a decimal comma leaves it in doubt, and it is
 * refused: "-16,78, 179,335", "48,85,2,35", "38,31,02 N".
 *
 * Never handed to parseCoordinateString as it was typed when it has a decimal
 * comma: that parser treats every comma as a space, so "16 46,8 S" would be
 * 16° 46′ 08″, about 300 m from 16° 46.8′, and "38 31,02 N, 028 37,03 W" a
 * plausible point 38 m from the one typed. The one exception is a comma
 * between two numbers of which one already has a decimal point
 * ("-43.6083,172.7167"): a number cannot take both, so it is a separator.
 * "48,85" (two whole numbers, or one with a decimal comma) is refused.
 *
 * Its own module, not utils/coordParse.ts: the comma is this field's alone,
 * so parseCoordinateString (MapHub, the voyage form, geocoding) is untouched,
 * and the code loads with the sheet, not with the app.
 */
import { parseCoordinateString, type ParsedCoords } from './coordParse';
import { formatLatDegMin, formatLonDegMin } from './formatDegMin';

/** A decimal comma: a comma between two digits. */
const DECIMAL_COMMA = /\d,\d/;
/** Two numbers and a comma between them, one with a decimal point: "-43.6083,172.7167". */
const POINT_PAIR = /^\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*$/;

/**
 * The text with each decimal comma read as a point, and each comma beside a
 * hemisphere letter as a space; null if any other comma is left.
 */
function withDecimalCommas(text: string): string | null {
    const read = text
        .replace(/([NSEW])\s*,/gi, '$1 ')
        .replace(/,(\s*[NSEW])/gi, ' $1')
        // Consuming both numbers, so a run ("48,85,2,35") leaves a comma.
        .replace(/(\d+),(\d+)/g, '$1.$2');
    return read.includes(',') ? null : read;
}

/** A typed position, or null when it is not (unambiguously) one. */
export function parseAnchorPosition(text: string): ParsedCoords | null {
    if (typeof text !== 'string') return null;
    if (!DECIMAL_COMMA.test(text)) return parseCoordinateString(text);
    const commas = withDecimalCommas(text);
    const read = commas === null ? null : parseCoordinateString(commas);
    if (read) return read;
    return POINT_PAIR.test(text) && text.includes('.') ? parseCoordinateString(text) : null;
}

/**
 * The readback, e.g. "16°46.800′S 179°59.990′W": degrees and minutes to
 * 0.001′ (about 2 m), the way a plotter or a DSC set writes them. A dragged
 * point is written into the field in this form, so what is sent is within a
 * metre of where the anchor was let go (0.01′ is 18 m, enough to swing a point
 * across the edge of the circle).
 */
export function formatDmm(lat: number, lon: number): string {
    return `${formatLatDegMin(lat, 3)} ${formatLonDegMin(lon, 3)}`;
}
