import { parseNmeaNumber, validateNmeaSentence } from './nmeaSentence';
import { decodePgn } from '../nmea2000/pgnDecoder';
import { PGN, type N2KMessage } from '../nmea2000/types';

export interface NmeaPressure {
    hpa: number;
    /** These sentences do not declare a sea-level correction. */
    reference: 'sensor';
    source: string;
}
export interface NmeaDistanceLog {
    totalNm: number | null;
    tripNm: number | null;
    reference: 'water';
}

const between = (value: number | null, low: number, high: number): number | null =>
    value !== null && value >= low && value <= high ? value : null;
export const measuredGnssMode = (mode: string | undefined): boolean =>
    !mode || ['A', 'D', 'P', 'R', 'F'].includes(mode);

/** DDMM.MMMM / DDDMM.MMMM. Neither blank nor minutes >=60 is a position. */
export function parseNmeaCoordinate(
    raw: string | undefined,
    hemisphere: string | undefined,
    latitude: boolean,
): number | null {
    if (!raw || !new RegExp(latitude ? '^\\d{4}(?:\\.\\d+)?$' : '^\\d{5}(?:\\.\\d+)?$').test(raw)) return null;
    if (!(latitude ? ['N', 'S'] : ['E', 'W']).includes(hemisphere ?? '')) return null;
    const encoded = Number(raw),
        degrees = Math.floor(encoded / 100),
        minutes = encoded - degrees * 100;
    const value = degrees + minutes / 60;
    if (minutes >= 60 || value > (latitude ? 90 : 180)) return null;
    return (hemisphere === 'S' || hemisphere === 'W' ? -1 : 1) * value;
}

export function parseGll(parts: string[]): { lat: number; lon: number } | null {
    if (parts[6] !== 'A' || !measuredGnssMode(parts[7])) return null;
    const lat = parseNmeaCoordinate(parts[1], parts[2], true),
        lon = parseNmeaCoordinate(parts[3], parts[4], false);
    return lat === null || lon === null ? null : { lat, lon };
}

export function parseVtg(parts: string[]): { sogKts: number | null; cogTrue: number | null } | null {
    if (!measuredGnssMode(parts[9])) return null;
    const knots = parts[6] === 'N' ? between(parseNmeaNumber(parts[5]), 0, 200) : null;
    const kmh = parts[8] === 'K' ? between(parseNmeaNumber(parts[7]), 0, 370.4) : null;
    // Reject inconsistent duplicate units rather than selecting the nicer value.
    if (knots !== null && kmh !== null && Math.abs(knots - kmh / 1.852) > 0.1) return null;
    const course = parts[2] === 'T' ? between(parseNmeaNumber(parts[1]), 0, 360) : null;
    const result = {
        sogKts: knots ?? (kmh === null ? null : kmh / 1.852),
        cogTrue: course === null ? null : course % 360,
    };
    return result.sogKts === null && result.cogTrue === null ? null : result;
}

export function parseVlw(parts: string[]): NmeaDistanceLog | null {
    const totalNm = parts[2] === 'N' ? between(parseNmeaNumber(parts[1]), 0, 100_000_000) : null;
    const tripNm = parts[4] === 'N' ? between(parseNmeaNumber(parts[3]), 0, 100_000_000) : null;
    return totalNm === null && tripNm === null ? null : { totalNm, tripNm, reference: 'water' };
}

export function parseMdaPressure(parts: string[]): NmeaPressure | null {
    const inches = parts[2] === 'I' ? parseNmeaNumber(parts[1]) : null;
    const bars = parts[4] === 'B' ? parseNmeaNumber(parts[3]) : null;
    if (inches !== null && bars !== null && Math.abs(inches * 33.8638866667 - bars * 1000) > 2) return null;
    const hpa = between(bars !== null ? bars * 1000 : inches !== null ? inches * 33.8638866667 : null, 800, 1100);
    return hpa === null ? null : { hpa, reference: 'sensor', source: `${parts[0]} pressure` };
}

export function parseXdrPressure(parts: string[]): NmeaPressure | null {
    for (let i = 1; i + 3 < parts.length; i += 4) {
        // XDR pressure also carries engine/fuel/coolant pressure. Names are vendor
        // configured; an unknown name is not evidence of an atmospheric sensor.
        const name = parts[i + 3];
        if (
            parts[i] !== 'P' ||
            !/^(?:baro(?:meter)?|air|airpressure|atmospheric(?:pressure)?|env_outside_p|usb-bar20-n)$/i.test(name)
        )
            continue;
        const value = parseNmeaNumber(parts[i + 1]);
        const hpa = between(
            value === null ? null : parts[i + 2] === 'B' ? value * 1000 : parts[i + 2] === 'P' ? value / 100 : null,
            800,
            1100,
        );
        if (hpa !== null) return { hpa, reference: 'sensor', source: `${parts[0]} ${name}` };
    }
    return null;
}

/** Fully assembled SeaSmart data only. Commands and control PGNs never enter this lane. */
const PCDIN_LENGTHS: ReadonlyMap<number, readonly number[]> = new Map([
    [PGN.VESSEL_HEADING, [8]],
    [PGN.ATTITUDE, [7, 8]],
    [PGN.ENGINE_PARAMETERS_RAPID, [8]],
    [PGN.ENGINE_PARAMETERS_DYNAMIC, [26]],
    [PGN.SPEED_THROUGH_WATER, [6, 8]],
    [PGN.WATER_DEPTH, [8]],
    [PGN.POSITION_RAPID, [8]],
    [PGN.COG_SOG, [8]],
    [PGN.WIND_DATA, [8]],
]);
export interface SeaSmartMeasurement {
    message: N2KMessage;
    sourceAddress: number;
    deviceTick: string;
}
export function parsePcdin(sentence: string): SeaSmartMeasurement | null {
    const validated = validateNmeaSentence(sentence);
    if (!validated || validated.type !== 'PCDIN' || !validated.hasChecksum) return null;
    const fields = validated.raw.split(',');
    if (
        fields.length !== 5 ||
        !/^[0-9a-f]{6}$/i.test(fields[1]) ||
        !/^[0-9a-f]{8}$/i.test(fields[2]) ||
        !/^[0-9a-f]{2}$/i.test(fields[3]) ||
        !/^(?:[0-9a-f]{2}){1,43}$/i.test(fields[4])
    )
        return null;
    const pgn = Number.parseInt(fields[1], 16),
        lengths = PCDIN_LENGTHS.get(pgn);
    if (!lengths?.includes(fields[4].length / 2)) return null;
    const bytes = Uint8Array.from(fields[4].match(/../g)!, (pair) => Number.parseInt(pair, 16));
    const message = decodePgn(pgn, bytes);
    // The SeaSmart tick is an uptime counter, never a UTC measurement time.
    return message ? { message, sourceAddress: Number.parseInt(fields[3], 16), deviceTick: fields[2] } : null;
}
