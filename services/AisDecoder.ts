/**
 * AisDecoder — Pure-function AIS NMEA sentence decoder.
 *
 * Decodes !AIVDM / !AIVDO sentences into partial AisTarget objects.
 * Handles multi-part message assembly (e.g., message type 5 spans 2 fragments).
 *
 * Supported message types:
 *   1, 2, 3  — Class A position report (MMSI, lat, lon, SOG, COG, heading, nav status)
 *   5        — Class A static/voyage data (name, ship type, call sign, destination)
 *   18       — Class B position report
 *   19       — Class B extended position report (includes name)
 *   24       — Class B static data (parts A & B)
 *
 * References: ITU-R M.1371-5, https://gpsd.gitlab.io/gpsd/AIVDM.html
 */
import type { AisTarget } from '../types/navigation';

// ── Fragment buffer for multi-part messages ──
interface Fragment {
    parts: string[];
    expected: number;
    received: number;
    timestamp: number;
}

const fragmentBuffer = new Map<string, Fragment>();
const FRAGMENT_TIMEOUT_MS = 10_000; // Discard incomplete fragments after 10s

// ── 6-bit ASCII payload decoding ──

/** Convert a single AIS armour character to its 6-bit value */
function charTo6bit(c: number): number {
    // AIS uses characters 0x30-0x77, mapped to 0-39 (with a gap at 0x58-0x5F)
    let v = c - 48;
    if (v > 40) v -= 8;
    return v & 0x3f;
}

/** Decode the AIS payload string into a bit array (as a Uint8Array of 0/1) */
function payloadToBits(payload: string): Uint8Array {
    const bits = new Uint8Array(payload.length * 6);
    for (let i = 0; i < payload.length; i++) {
        const v = charTo6bit(payload.charCodeAt(i));
        for (let b = 5; b >= 0; b--) {
            bits[i * 6 + (5 - b)] = (v >> b) & 1;
        }
    }
    return bits;
}

/** Extract an unsigned integer from bits[start..start+len-1] */
function getUint(bits: Uint8Array, start: number, len: number): number {
    let val = 0;
    for (let i = 0; i < len; i++) {
        val = (val << 1) | (bits[start + i] ?? 0);
    }
    return val;
}

/** Extract a signed integer (two's complement) from bits[start..start+len-1] */
function getInt(bits: Uint8Array, start: number, len: number): number {
    let val = getUint(bits, start, len);
    // If MSB is set, it's negative
    if (bits[start] === 1) {
        val -= 1 << len;
    }
    return val;
}

/** AIS 6-bit ASCII character set — extract a text string */
function getString(bits: Uint8Array, start: number, len: number): string {
    const chars: string[] = [];
    for (let i = 0; i < len; i += 6) {
        let c = getUint(bits, start + i, 6);
        if (c < 32) c += 64; // Map 0-31 to @A-Z[\]^_
        chars.push(String.fromCharCode(c));
    }
    return chars.join('').replace(/@+$/, '').trim();
}

// ── Message decoders ──

/** Decode message types 1, 2, 3 — Class A Position Report */
function decodePositionReport(bits: Uint8Array): Partial<AisTarget> | null {
    const mmsi = getUint(bits, 8, 30);
    const navStatus = getUint(bits, 38, 4);
    const sog = getUint(bits, 50, 10) / 10; // 1/10 knot
    const lon = getInt(bits, 61, 28) / 600000; // 1/10000 min → degrees
    const lat = getInt(bits, 89, 27) / 600000;
    const cog = getUint(bits, 116, 12) / 10; // 1/10 degree
    const heading = getUint(bits, 128, 9); // degrees, 511 = unavailable

    // Validate position (181° = unavailable longitude, 91° = unavailable latitude)
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    if (lon === 0 && lat === 0) return null; // Null Island = likely invalid

    return { mmsi, navStatus, sog, lon, lat, cog, heading, lastUpdated: Date.now() };
}

/** Decode message type 5 — Class A Static and Voyage Data */
function decodeStaticVoyage(bits: Uint8Array): Partial<AisTarget> | null {
    const mmsi = getUint(bits, 8, 30);
    const callSign = getString(bits, 70, 42);
    const name = getString(bits, 112, 120);
    const shipType = getUint(bits, 232, 8);
    const destination = getString(bits, 302, 120);

    return { mmsi, callSign, name, shipType, destination, lastUpdated: Date.now() };
}

/** Decode message type 18 — Class B Position Report */
function decodeClassBPosition(bits: Uint8Array): Partial<AisTarget> | null {
    const mmsi = getUint(bits, 8, 30);
    const sog = getUint(bits, 46, 10) / 10;
    const lon = getInt(bits, 57, 28) / 600000;
    const lat = getInt(bits, 85, 27) / 600000;
    const cog = getUint(bits, 112, 12) / 10;
    const heading = getUint(bits, 124, 9);

    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    if (lon === 0 && lat === 0) return null;

    return { mmsi, sog, lon, lat, cog, heading, navStatus: 15, lastUpdated: Date.now() };
}

/** Decode message type 19 — Class B Extended Position Report */
function decodeClassBExtended(bits: Uint8Array): Partial<AisTarget> | null {
    const mmsi = getUint(bits, 8, 30);
    const sog = getUint(bits, 46, 10) / 10;
    const lon = getInt(bits, 57, 28) / 600000;
    const lat = getInt(bits, 85, 27) / 600000;
    const cog = getUint(bits, 112, 12) / 10;
    const heading = getUint(bits, 124, 9);
    const name = getString(bits, 143, 120);
    const shipType = getUint(bits, 263, 8);

    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    if (lon === 0 && lat === 0) return null;

    return { mmsi, sog, lon, lat, cog, heading, name, shipType, navStatus: 15, lastUpdated: Date.now() };
}

/** Decode message type 24 — Class B Static Data */
function decodeClassBStatic(bits: Uint8Array): Partial<AisTarget> | null {
    const mmsi = getUint(bits, 8, 30);
    const partNumber = getUint(bits, 38, 2);

    if (partNumber === 0) {
        // Part A — vessel name
        const name = getString(bits, 40, 120);
        return { mmsi, name, lastUpdated: Date.now() };
    } else if (partNumber === 1) {
        // Part B — ship type, call sign
        const shipType = getUint(bits, 40, 8);
        const callSign = getString(bits, 90, 42);
        return { mmsi, shipType, callSign, lastUpdated: Date.now() };
    }
    return null;
}

// ── Public API ──

/**
 * Process a single AIS NMEA sentence (!AIVDM or !AIVDO).
 * Returns a partial AisTarget on successful decode, or null.
 *
 * Handles multi-fragment message assembly internally.
 */
export function processAisSentence(sentence: string): Partial<AisTarget> | null {
    // Strip checksum
    const raw = sentence.split('*')[0];
    const parts = raw.split(',');

    // !AIVDM,fragCount,fragNum,seqMsgId,channel,payload,fillBits
    if (parts.length < 7) return null;

    const fragCount = parseInt(parts[1], 10);
    const fragNum = parseInt(parts[2], 10);
    const seqMsgId = parts[3] || '';
    const payload = parts[5];

    if (!payload || isNaN(fragCount) || isNaN(fragNum)) return null;

    // ── Single-fragment message — decode immediately ──
    if (fragCount === 1) {
        return decodePayload(payload);
    }

    // ── Multi-fragment message — assemble ──
    const key = `${fragCount}-${seqMsgId}`;

    if (fragNum === 1) {
        // First fragment
        fragmentBuffer.set(key, {
            parts: [payload],
            expected: fragCount,
            received: 1,
            timestamp: Date.now(),
        });
        // Clean up old fragments
        pruneFragments();
        return null;
    }

    const frag = fragmentBuffer.get(key);
    if (!frag) return null;

    frag.parts[fragNum - 1] = payload;
    frag.received++;

    if (frag.received >= frag.expected) {
        // All fragments received — reassemble and decode
        const fullPayload = frag.parts.join('');
        fragmentBuffer.delete(key);
        return decodePayload(fullPayload);
    }

    return null;
}

/** Decode a complete (possibly reassembled) AIS payload */
function decodePayload(payload: string): Partial<AisTarget> | null {
    if (!payload || payload.length < 1) return null;

    const bits = payloadToBits(payload);
    const msgType = getUint(bits, 0, 6);

    switch (msgType) {
        case 1:
        case 2:
        case 3:
            return decodePositionReport(bits);
        case 5:
            return decodeStaticVoyage(bits);
        case 18:
            return decodeClassBPosition(bits);
        case 19:
            return decodeClassBExtended(bits);
        case 24:
            return decodeClassBStatic(bits);
        default:
            return null; // Unsupported message type
    }
}

/** Prune stale fragment entries */
function pruneFragments(): void {
    const now = Date.now();
    for (const [key, frag] of fragmentBuffer) {
        if (now - frag.timestamp > FRAGMENT_TIMEOUT_MS) {
            fragmentBuffer.delete(key);
        }
    }
}

// ── Test helpers (exported for unit tests) ──
export { payloadToBits, getUint, getInt, getString, decodePayload };
