/**
 * aivdm.ts — raw NMEA AIS (!AIVDM/!AIVDO) → VesselRecord.
 *
 * The boat-bridge feed (bridge.ts) reads the YDWG-02's NMEA stream, which is
 * armoured AIVDM text, not aisstream's pre-decoded JSON — so this package
 * needs its own 6-bit decoder. The decode core is a deliberate VENDORED COPY
 * of the app's services/AisDecoder.ts (bit offsets, scaling, string
 * handling), which has been decoding this exact gateway's sentences aboard
 * since 2026-08-12. It cannot be imported here because the Railway Docker
 * build copies only this directory. Drift protection lives in the MAIN test
 * suite: tests/AisBridgeDecoderParity.test.ts decodes reference sentences
 * through BOTH decoders and requires identical answers.
 *
 * Output conventions match parser.ts exactly (one VesselDB, one behaviour):
 * AIS sentinel values — COG 360, SOG 102.3, heading 511, lat 91, lon 181 —
 * are OMITTED, never stored as real movement; Null Island is rejected;
 * Class B nav_status is pinned to 15.
 */
import type { VesselRecord } from './parser.js';

// ── NMEA framing ─────────────────────────────────────────────────────

/**
 * `*hh` checksum over everything between `!`/`$` and `*`. STRICT framing:
 * the sentence must END at the two hex digits, and no control character may
 * appear in the body. Without both, a punter could append bytes after the
 * checksum (a second `\r`-separated NMEA line) and smuggle arbitrary text
 * to AISHub through the verbatim forward — a station-ban-grade injection the
 * app's own validateNmeaSentence already blocks, and which this must match
 * because the fleet-feed endpoint is reachable outside the app (review,
 * 2026-08-21).
 */
export function nmeaChecksumOk(sentence: string): boolean {
    const star = sentence.lastIndexOf('*');
    // The checksum's two hex digits must be the FINAL two characters.
    if (star < 0 || star !== sentence.length - 3) return false;
    if (!/^[0-9A-Fa-f]{2}$/.test(sentence.slice(star + 1))) return false;
    const stated = Number.parseInt(sentence.slice(star + 1), 16);
    let sum = 0;
    for (let i = 1; i < star; i++) {
        const code = sentence.charCodeAt(i);
        // No control characters in the body — a stray CR/LF is an injection.
        if (code <= 0x1f || code === 0x7f) return false;
        sum ^= code;
    }
    return sum === stated;
}

// ── 6-bit ASCII payload decoding (vendored from services/AisDecoder.ts) ──

function charTo6bit(c: number): number {
    let v = c - 48;
    if (v > 40) v -= 8;
    return v & 0x3f;
}

export function payloadToBits(payload: string): Uint8Array {
    const bits = new Uint8Array(payload.length * 6);
    for (let i = 0; i < payload.length; i++) {
        const v = charTo6bit(payload.charCodeAt(i));
        for (let b = 5; b >= 0; b--) {
            bits[i * 6 + (5 - b)] = (v >> b) & 1;
        }
    }
    return bits;
}

export function getUint(bits: Uint8Array, start: number, len: number): number {
    let val = 0;
    for (let i = 0; i < len; i++) {
        val = (val << 1) | (bits[start + i] ?? 0);
    }
    return val;
}

export function getInt(bits: Uint8Array, start: number, len: number): number {
    let val = getUint(bits, start, len);
    if (bits[start] === 1) val -= 1 << len;
    return val;
}

export function getString(bits: Uint8Array, start: number, len: number): string {
    const chars: string[] = [];
    for (let i = 0; i < len; i += 6) {
        let c = getUint(bits, start + i, 6);
        if (c < 32) c += 64;
        chars.push(String.fromCharCode(c));
    }
    return chars.join('').replace(/@+$/, '').trim();
}

// ── Field conventions (mirror parser.ts) ─────────────────────────────

function validMmsi(mmsi: number): boolean {
    return Number.isInteger(mmsi) && mmsi >= 100_000_000 && mmsi <= 999_999_999;
}

function positionOf(bits: Uint8Array, lonStart: number, latStart: number): { lat: number; lon: number } | null {
    const lon = getInt(bits, lonStart, 28) / 600000;
    const lat = getInt(bits, latStart, 27) / 600000;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null; // 181/91 = N/A
    if (lon === 0 && lat === 0) return null; // Null Island
    return { lat, lon };
}

function inRange(value: number, min: number, max: number): number | undefined {
    return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function textOrUndefined(value: string, maxLength: number): string | undefined {
    const cleaned = value.slice(0, maxLength);
    return cleaned || undefined;
}

// ── Message decoders → VesselRecord ──────────────────────────────────

function classAPosition(bits: Uint8Array): VesselRecord | null {
    const mmsi = getUint(bits, 8, 30);
    if (!validMmsi(mmsi)) return null;
    const position = positionOf(bits, 61, 89);
    if (!position) return null;
    return {
        mmsi,
        ...position,
        cog: inRange(getUint(bits, 116, 12) / 10, 0, 359.9),
        sog: inRange(getUint(bits, 50, 10) / 10, 0, 102.2),
        heading: inRange(getUint(bits, 128, 9), 0, 359),
        nav_status: inRange(getUint(bits, 38, 4), 0, 15),
    };
}

function classAStatic(bits: Uint8Array): VesselRecord | null {
    const mmsi = getUint(bits, 8, 30);
    if (!validMmsi(mmsi)) return null;
    const record: VesselRecord = { mmsi };
    const name = textOrUndefined(getString(bits, 112, 120), 20);
    if (name !== undefined) record.name = name;
    const callSign = textOrUndefined(getString(bits, 70, 42), 7);
    if (callSign !== undefined) record.call_sign = callSign;
    const shipType = inRange(getUint(bits, 232, 8), 0, 99);
    if (shipType !== undefined) record.ship_type = shipType;
    const destination = textOrUndefined(getString(bits, 302, 120), 20);
    if (destination !== undefined) record.destination = destination;
    const imo = getUint(bits, 40, 30);
    if (imo >= 1_000_000 && imo <= 9_999_999) record.imo_number = imo;
    return Object.keys(record).length > 1 ? record : null;
}

function classBPosition(bits: Uint8Array): VesselRecord | null {
    const mmsi = getUint(bits, 8, 30);
    if (!validMmsi(mmsi)) return null;
    const position = positionOf(bits, 57, 85);
    if (!position) return null;
    return {
        mmsi,
        ...position,
        cog: inRange(getUint(bits, 112, 12) / 10, 0, 359.9),
        sog: inRange(getUint(bits, 46, 10) / 10, 0, 102.2),
        heading: inRange(getUint(bits, 124, 9), 0, 359),
        nav_status: 15,
    };
}

function classBExtended(bits: Uint8Array): VesselRecord | null {
    const base = classBPosition(bits);
    if (!base) return null;
    const name = textOrUndefined(getString(bits, 143, 120), 20);
    if (name !== undefined) base.name = name;
    const shipType = inRange(getUint(bits, 263, 8), 0, 99);
    if (shipType !== undefined) base.ship_type = shipType;
    return base;
}

function classBStatic(bits: Uint8Array): VesselRecord | null {
    const mmsi = getUint(bits, 8, 30);
    if (!validMmsi(mmsi)) return null;
    const partNumber = getUint(bits, 38, 2);
    const record: VesselRecord = { mmsi };
    if (partNumber === 0) {
        const name = textOrUndefined(getString(bits, 40, 120), 20);
        if (name !== undefined) record.name = name;
    } else if (partNumber === 1) {
        const shipType = inRange(getUint(bits, 40, 8), 0, 99);
        if (shipType !== undefined) record.ship_type = shipType;
        const callSign = textOrUndefined(getString(bits, 90, 42), 7);
        if (callSign !== undefined) record.call_sign = callSign;
    } else {
        return null;
    }
    return Object.keys(record).length > 1 ? record : null;
}

export function decodeAisPayload(payload: string): VesselRecord | null {
    if (!payload) return null;
    const bits = payloadToBits(payload);
    const type = getUint(bits, 0, 6);
    switch (type) {
        case 1:
        case 2:
        case 3:
            return classAPosition(bits);
        case 5:
            return classAStatic(bits);
        case 18:
            return classBPosition(bits);
        case 19:
            return classBExtended(bits);
        case 24:
            return classBStatic(bits);
        default:
            return null;
    }
}

// ── Sentence-level API with multi-fragment assembly ──────────────────

interface Fragment {
    parts: (string | undefined)[];
    total: number;
    at: number;
}

/** Half-assembled multi-sentence messages (type 5 spans two frames). */
const fragments = new Map<string, Fragment>();
const FRAGMENT_TTL_MS = 30_000;
const MAX_PENDING_FRAGMENTS = 64;

/** Test seam. */
export function __resetFragmentsForTest(): void {
    fragments.clear();
}

/**
 * Decode one `!AIVDM`/`!AIVDO` sentence. Returns a VesselRecord when the
 * sentence completes a message, null otherwise (fragment buffered, checksum
 * bad, unsupported type). Own-ship AIVDO decodes identically — the bridge
 * is the one place ownship SHOULD land in the shared table.
 */
export function decodeAisSentence(sentence: string, now = Date.now(), source = ''): VesselRecord | null {
    const trimmed = sentence.trim();
    if (!trimmed.startsWith('!AIVDM') && !trimmed.startsWith('!AIVDO')) return null;
    if (!nmeaChecksumOk(trimmed)) return null;

    const star = trimmed.lastIndexOf('*');
    const parts = trimmed.slice(0, star).split(',');
    // !AIVDM,fragCount,fragNum,seqMsgId,channel,payload,fillBits
    if (parts.length < 7) return null;
    const fragCount = Number.parseInt(parts[1], 10);
    const fragNum = Number.parseInt(parts[2], 10);
    const payload = parts[5];
    if (!payload || !Number.isInteger(fragCount) || !Number.isInteger(fragNum)) return null;
    if (fragCount < 1 || fragCount > 9 || fragNum < 1 || fragNum > fragCount) return null;

    if (fragCount === 1) return decodeAisPayload(payload);

    // Multi-fragment: key by SOURCE + sequence id + channel + talker so
    // interleaved streams cannot cross-assemble. The source dimension is
    // load-bearing for the fleet feed: without it, two different boats'
    // type-5 fragments sharing a sequence id and channel would merge into a
    // chimera vessel (recon, 2026-08-21). Single-source callers (the pi
    // bridge) use the default ''. Stale halves are evicted by time and by
    // count — an unpaired fragment must never pin memory.
    const key = `${source}:${parts[0]}:${parts[3]}:${parts[4]}:${fragCount}`;
    let frag = fragments.get(key);
    if (!frag || now - frag.at > FRAGMENT_TTL_MS) {
        // .fill(undefined) is load-bearing: new Array(n) creates HOLES, and
        // Array.prototype.every SKIPS holes — one fragment then vacuously
        // passed the "all present" check and decoded alone (caught by the
        // two-fragment tests before it could ship).
        frag = { parts: new Array<string | undefined>(fragCount).fill(undefined), total: fragCount, at: now };
        fragments.set(key, frag);
    }
    frag.parts[fragNum - 1] = payload;
    frag.at = now;

    if (frag.parts.every((p) => p !== undefined)) {
        fragments.delete(key);
        return decodeAisPayload(frag.parts.join(''));
    }

    if (fragments.size > MAX_PENDING_FRAGMENTS) {
        // Evict oldest.
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, f] of fragments) {
            if (f.at < oldestAt) {
                oldestAt = f.at;
                oldestKey = k;
            }
        }
        if (oldestKey) fragments.delete(oldestKey);
    }
    return null;
}

/**
 * Rewrite an own-ship `!AIVDO` as `!AIVDM` (with a fresh checksum) for the
 * AISHub forward: aggregators expect station RECEIPTS, and the boat's own
 * transmission is exactly the receipt a shore station near it would report.
 */
export function aivdoToAivdm(sentence: string): string | null {
    const trimmed = sentence.trim();
    if (!trimmed.startsWith('!AIVDO')) return null;
    if (!nmeaChecksumOk(trimmed)) return null;
    const star = trimmed.lastIndexOf('*');
    const body = 'AIVDM' + trimmed.slice(6, star);
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
    return `!${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}
