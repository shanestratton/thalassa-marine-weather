/**
 * Actisense NGT-1 ASCII line parser.
 *
 * The Actisense NGT-1 (USB N2K gateway) and the Yacht Devices YDWG-N2K
 * (WiFi N2K gateway, when configured for ASCII output) emit one CAN
 * frame per line in roughly this format:
 *
 *   2025-05-02-14:30:15.123 R 09F8027F C0 1B 31 17 00 0E 00 00
 *
 * Field breakdown:
 *   - timestamp (host-side, optional)
 *   - direction: `R` received, `T` transmitted (we ignore T frames —
 *     that's our own outbound traffic echoed back)
 *   - 29-bit CAN ID in 8-hex-digit form (high bits may be set if the
 *     adapter flags extended frames; decodeCanId masks them off)
 *   - 1-8 hex bytes of payload, space-separated
 *
 * Some adapters omit the timestamp; some put a `+` or `-` prefix on the
 * direction. The parser is forgiving — it locates the direction +
 * CAN-ID columns by scanning for hex tokens rather than requiring a
 * fixed format.
 *
 * Also accepts the canboat "PCDIN" / "MXPGN" wrapped formats since the
 * YDWG-02 in 0183 mode uses those for N2K bridging:
 *
 *   $PCDIN,01F119,000C72EA,0F,2AAF00D1067414FF*5C
 *
 * (PCDIN wraps the PGN, source, and payload directly — no need for CAN
 * ID decoding. We re-emit a synthetic CAN ID for downstream consistency.)
 */

import { decodeCanId } from './canId';

export interface ParsedFrame {
    /** Resolved PGN. */
    pgn: number;
    /** Source address. */
    source: number;
    /** Destination address (for peer-to-peer PGNs); null for broadcast. */
    destination: number | null;
    /** Priority 0-7. */
    priority: number;
    /** Frame payload (1-8 bytes for raw CAN; up to 8 for PCDIN-wrapped). */
    data: Uint8Array;
    /** Original source line — useful for debug logs. */
    raw: string;
}

const HEX_BYTE = /^[0-9a-fA-F]{2}$/;
const HEX_CAN_ID = /^[0-9a-fA-F]{6,8}$/;

/**
 * Parse one Actisense / canboat ASCII line into a ParsedFrame, or null
 * if the line is empty / not a frame / a transmitted frame we should
 * ignore.
 *
 * Throws nothing — malformed lines return null. The transport layer
 * decides whether to log + drop or escalate.
 */
export function parseAscii(line: string): ParsedFrame | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('#')) return null; // comment

    if (trimmed.startsWith('$PCDIN')) {
        return parsePcdin(trimmed);
    }
    if (trimmed.startsWith('!PDGY') || trimmed.startsWith('$MXPGN')) {
        // Yacht Devices proprietary wrappers — close enough to PCDIN
        // structure for our purposes; surface as null until we have
        // real frames to reverse-engineer against.
        return null;
    }

    return parseRawFrame(trimmed);
}

/**
 * Parse a stream of bytes (e.g. arriving from a USB serial transport)
 * into ParsedFrames. Handles partial lines: feed a `Buffer.toString()`
 * chunk and we accumulate until newlines arrive.
 *
 * Returns the frames extracted from this chunk; any trailing partial
 * line is buffered internally for the next call.
 */
export class AsciiFrameStream {
    private buffer = '';

    feed(chunk: string): ParsedFrame[] {
        this.buffer += chunk;
        const out: ParsedFrame[] = [];
        let nl: number;
        // Both \n and \r\n endings — some serial adapters use \r only.
        while ((nl = this.findLineBreak(this.buffer)) !== -1) {
            const line = this.buffer.slice(0, nl);
            // Skip past the line break (1 or 2 chars).
            this.buffer = this.buffer.slice(nl + (this.buffer[nl] === '\r' && this.buffer[nl + 1] === '\n' ? 2 : 1));
            const frame = parseAscii(line);
            if (frame) out.push(frame);
        }
        return out;
    }

    /** Drop any buffered partial line. Useful on disconnect. */
    reset(): void {
        this.buffer = '';
    }

    private findLineBreak(s: string): number {
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '\n' || c === '\r') return i;
        }
        return -1;
    }
}

// ── Internal parsers ─────────────────────────────────────────────────

function parseRawFrame(line: string): ParsedFrame | null {
    // Tokenise on whitespace, find the direction marker, then take the
    // CAN ID + remaining bytes from the right of it.
    const tokens = line.split(/\s+/);

    // Locate the direction marker. Single char R/T (sometimes prefixed
    // by + or -). If absent (some firmware drops it), assume the first
    // 8-hex token is the CAN ID.
    let dirIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i].replace(/^[+-]/, '');
        if (t === 'R' || t === 'T') {
            dirIdx = i;
            break;
        }
    }

    let canIdToken: string | undefined;
    let payloadStartIdx: number;
    if (dirIdx !== -1) {
        if (tokens[dirIdx].endsWith('T')) return null; // ignore our own outbound frames
        canIdToken = tokens[dirIdx + 1];
        payloadStartIdx = dirIdx + 2;
    } else {
        // No direction marker — find the first token that looks like a
        // 29-bit CAN ID and treat it as the start of the frame.
        const candidate = tokens.findIndex((t) => HEX_CAN_ID.test(t));
        if (candidate === -1) return null;
        canIdToken = tokens[candidate];
        payloadStartIdx = candidate + 1;
    }

    if (!canIdToken || !HEX_CAN_ID.test(canIdToken)) return null;
    const canId = parseInt(canIdToken, 16);
    if (Number.isNaN(canId)) return null;

    const dataBytes: number[] = [];
    for (let i = payloadStartIdx; i < tokens.length && dataBytes.length < 8; i++) {
        const t = tokens[i];
        if (!HEX_BYTE.test(t)) break; // stop at non-hex tokens (timestamps etc.)
        dataBytes.push(parseInt(t, 16));
    }
    if (dataBytes.length === 0) return null;

    const decoded = decodeCanId(canId);
    return {
        pgn: decoded.pgn,
        source: decoded.source,
        destination: decoded.destination,
        priority: decoded.priority,
        data: new Uint8Array(dataBytes),
        raw: line,
    };
}

/**
 * Parse a `$PCDIN` sentence — a hex-encoded N2K message wrapped in an
 * NMEA 0183-style envelope, used by Yacht Devices YDWG-02 in 0183 mode.
 *
 *   $PCDIN,01F119,000C72EA,0F,2AAF00D1067414FF*5C
 *           ^^^^^^^ PGN (24-bit, 6 hex)
 *                  ^^^^^^^^ timestamp (often the device tick, usable as
 *                            a clock for ordering but not wall-clock)
 *                           ^^ source address (8-bit, 2 hex)
 *                              ^^^^^^^^^^^^^^^^ payload bytes
 */
function parsePcdin(line: string): ParsedFrame | null {
    // Strip the optional checksum.
    const stripped = line.split('*')[0];
    const parts = stripped.split(',');
    if (parts.length < 5 || parts[0] !== '$PCDIN') return null;

    const pgn = parseInt(parts[1], 16);
    const source = parseInt(parts[3], 16);
    if (Number.isNaN(pgn) || Number.isNaN(source)) return null;

    const hex = parts[4];
    if (hex.length === 0 || hex.length % 2 !== 0) return null;
    const data = new Uint8Array(hex.length / 2);
    for (let i = 0; i < data.length; i++) {
        const byte = parseInt(hex.substr(i * 2, 2), 16);
        if (Number.isNaN(byte)) return null;
        data[i] = byte;
    }

    return {
        pgn,
        source,
        destination: null,
        priority: 6, // PCDIN doesn't carry priority; assume default-ish
        data,
        raw: line,
    };
}
