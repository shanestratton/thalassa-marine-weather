import type { NmeaDepthReference, NmeaDepthSource } from '../../types/navigation';

const SUPPORTED_INSTRUMENT_SENTENCES = new Set([
    'MWV',
    'RSA',
    // MWD carries true wind DIRECTION as a compass bearing. Without it the app
    // only ever knew the wind's angle off the bow, which cannot be drawn on a
    // compass card. Serene Summer's YDWG-02 has been broadcasting
    // `$YDMWD,128.1,T,117.1,M,5.7,N,2.9,M` the whole time; it was rejected here
    // before it ever reached a parser (2026-08-08).
    'MWD',
    'VHW',
    'HDT',
    'HDG',
    'HDM',
    'RPM',
    'XDR',
    'DBT',
    'DPT',
    'RMC',
    'GGA',
    'MTW',
]);

export interface ValidatedNmeaSentence {
    /** Sentence body with any checksum suffix removed. */
    raw: string;
    type: string;
    kind: 'instrument' | 'ais';
    hasChecksum: boolean;
}

export interface ParsedNmeaDepth {
    /** Depth at the declared reference, after applying a DPT offset once. */
    depthM: number;
    /** Unadjusted sounder depth below its transducer. */
    rawDepthM: number;
    source: NmeaDepthSource;
    reference: NmeaDepthReference;
    /** DPT transducer offset. Null for DBT or an omitted DPT offset. */
    offsetM: number | null;
}

/**
 * Validate the framing and checksum boundary of a sentence this app supports.
 *
 * Compatibility policy:
 * - A structurally valid, supported `$` instrument sentence may omit `*hh`.
 *   NMEA 0183 permits the checksum to be optional and older sounders do omit it.
 * - If `*` is present, exactly two terminal hexadecimal digits are mandatory
 *   and must match the XOR checksum. A malformed checksum is never treated as
 *   though it were absent.
 * - AIS `!AIVDM` / `!AIVDO` is safety-relevant target data and must carry a
 *   valid checksum. The app does not accept checksum-less AIS compatibility.
 */
export function validateNmeaSentence(sentence: unknown): ValidatedNmeaSentence | null {
    if (typeof sentence !== 'string' || sentence.length === 0 || sentence !== sentence.trim()) return null;
    for (let i = 0; i < sentence.length; i++) {
        const code = sentence.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return null;
    }

    const first = sentence[0];
    if (first !== '$' && first !== '!') return null;

    const firstStar = sentence.indexOf('*');
    const hasChecksum = firstStar >= 0;
    if (hasChecksum && (firstStar !== sentence.lastIndexOf('*') || firstStar !== sentence.length - 3)) return null;

    const raw = hasChecksum ? sentence.slice(0, firstStar) : sentence;
    const instrumentMatch = /^\$[A-Z0-9]{2}([A-Z0-9]{3})(?:,|$)/.exec(raw);
    const aisMatch = /^!AI(VDM|VDO)(?:,|$)/.exec(raw);

    let kind: ValidatedNmeaSentence['kind'];
    let type: string;
    if (instrumentMatch && SUPPORTED_INSTRUMENT_SENTENCES.has(instrumentMatch[1])) {
        kind = 'instrument';
        type = instrumentMatch[1];
    } else if (aisMatch) {
        kind = 'ais';
        type = aisMatch[1];
    } else {
        return null;
    }

    if (!hasChecksum) {
        return kind === 'instrument' ? { raw, type, kind, hasChecksum: false } : null;
    }

    const expected = sentence.slice(firstStar + 1);
    if (!/^[0-9A-Fa-f]{2}$/.test(expected)) return null;

    let checksum = 0;
    for (let i = 1; i < firstStar; i++) checksum ^= sentence.charCodeAt(i);
    if (checksum !== Number.parseInt(expected, 16)) return null;

    return { raw, type, kind, hasChecksum: true };
}

/** Parse one complete DBT/DPT body without guessing or mixing its datum. */
export function parseNmeaDepth(raw: string, type: 'DBT' | 'DPT'): ParsedNmeaDepth | null {
    const parts = raw.split(',');

    if (type === 'DBT') {
        // DBT is explicitly depth below transducer. Prefer the metres field,
        // but accept either of the standard alternate unit fields when metres
        // is omitted by an older device.
        const metres = parts[4] === 'M' ? parseNmeaNumber(parts[3]) : null;
        const feet = parts[2] === 'f' ? parseNmeaNumber(parts[1]) : null;
        const fathoms = parts[6] === 'F' ? parseNmeaNumber(parts[5]) : null;
        const rawDepthM = metres ?? (feet !== null ? feet * 0.3048 : fathoms !== null ? fathoms * 1.8288 : null);
        if (rawDepthM === null || rawDepthM < 0) return null;
        return {
            depthM: rawDepthM,
            rawDepthM,
            source: 'DBT',
            reference: 'below-transducer',
            offsetM: null,
        };
    }

    // DPT: water depth relative to the transducer plus an optional signed
    // transducer offset. Positive reaches the waterline; negative reaches the
    // keel. Applying it here means every downstream consumer sees one value
    // and one honest reference instead of silently calling raw DPT "keel".
    const rawDepthM = parseNmeaNumber(parts[1]);
    if (rawDepthM === null || rawDepthM < 0) return null;
    const offsetField = parts[2] ?? '';
    const offsetM = offsetField === '' ? null : parseNmeaNumber(offsetField);
    if (offsetField !== '' && offsetM === null) return null;

    const effectiveOffset = offsetM ?? 0;
    const reference: NmeaDepthReference =
        effectiveOffset > 0 ? 'below-waterline' : effectiveOffset < 0 ? 'below-keel' : 'below-transducer';

    return {
        depthM: rawDepthM + effectiveOffset,
        rawDepthM,
        source: 'DPT',
        reference,
        offsetM,
    };
}

export function nmeaDepthReferenceLabel(reference: NmeaDepthReference | null | undefined): string {
    if (reference === 'below-keel') return 'Below keel';
    if (reference === 'below-waterline') return 'Below waterline';
    return 'Below transducer';
}

export function parseNmeaNumber(value: string | undefined): number | null {
    if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
