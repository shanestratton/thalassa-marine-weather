/**
 * NMEA 2000 29-bit CAN identifier decoder.
 *
 * Every N2K CAN frame carries a 29-bit identifier that encodes:
 *
 *   bits 26-28: priority (0-7, lower = higher priority)
 *   bits 25:    EDP / extended data page (0 for ISO 11783-3 N2K)
 *   bits 24:    DP  / data page
 *   bits 16-23: PF  / PDU format (the "high byte" of the PGN)
 *   bits 8-15:  PS  / PDU specific:
 *               - if PF >= 240 (0xF0): PGN-low byte → PGN = (DP<<16)|(PF<<8)|PS
 *               - if PF <  240        : destination address → PGN = (DP<<16)|(PF<<8)
 *   bits 0-7:   SA  / source address
 *
 * In other words PF >= 240 means a broadcast PGN where the PS field
 * encodes the low byte of the PGN, and PF < 240 means a peer-to-peer
 * PGN where the PS field is a destination address (the PGN's low byte
 * is implicitly 0).
 *
 * Reference: ISO 11783-3 §5.3.1, also documented in the canboat README.
 */

export interface CanIdDecoded {
    /** Priority — 0 (highest) to 7 (lowest). Most marine PGNs sit at 2-6. */
    priority: number;
    /** Resolved PGN number (the same number you'd cross-reference in the PGN catalog). */
    pgn: number;
    /** Source address (0-251 for devices, 252-255 reserved). */
    source: number;
    /**
     * Destination address. Only meaningful for PF < 240 (peer-to-peer PGNs).
     * For broadcast PGNs (PF >= 240) this is null.
     */
    destination: number | null;
}

/**
 * Decode a 29-bit CAN identifier into its N2K parts.
 *
 * Accepts any 32-bit integer; only the lower 29 bits are used. Higher
 * bits are masked off, so passing a value with extended-frame flags set
 * (some adapters set bit 31) is harmless.
 */
export function decodeCanId(canId29: number): CanIdDecoded {
    // Mask to 29 bits — defensive against extended-frame flag bits.
    const id = canId29 >>> 0; // force unsigned
    const sa = id & 0xff;
    const ps = (id >>> 8) & 0xff;
    const pf = (id >>> 16) & 0xff;
    const dp = (id >>> 24) & 0x01; // bit 24
    const priority = (id >>> 26) & 0x07;

    let pgn: number;
    let destination: number | null;
    if (pf >= 0xf0) {
        // Broadcast PGN: the PS byte is the PGN's low byte.
        pgn = (dp << 16) | (pf << 8) | ps;
        destination = null;
    } else {
        // Peer-to-peer PGN: PS is the destination address; PGN low byte is 0.
        pgn = (dp << 16) | (pf << 8);
        destination = ps;
    }

    return { priority, pgn, source: sa, destination };
}

/**
 * Encode the four N2K parts back into a 29-bit CAN identifier. Useful
 * for tests and for emitting frames from the host (reverse direction).
 *
 * `destination` is ignored for broadcast PGNs (PF >= 240); pass null or
 * any value, the function will use the PGN's low byte instead.
 */
export function encodeCanId(parts: CanIdDecoded): number {
    const { priority, pgn, source } = parts;
    const dp = (pgn >>> 16) & 0x01;
    const pf = (pgn >>> 8) & 0xff;
    let ps: number;
    if (pf >= 0xf0) {
        // Broadcast — PS is the PGN's low byte.
        ps = pgn & 0xff;
    } else {
        // Peer-to-peer — PS is the destination address.
        ps = (parts.destination ?? 0xff) & 0xff;
    }
    return (((priority & 0x07) << 26) | ((dp & 0x01) << 24) | (pf << 16) | (ps << 8) | (source & 0xff)) >>> 0;
}

/**
 * Quick check: is the PGN a Fast Packet protocol message?
 *
 * Single-frame PGNs are limited to ≤8 byte payloads. Fast Packet PGNs
 * (also called BAM in J1939 parlance) can carry up to 223 bytes
 * reassembled across multiple CAN frames.
 *
 * The N2K spec defines specific PGNs as Fast Packet by convention rather
 * than encoding it in the ID. The list below covers the common marine
 * PGNs in our decoder; expand as new PGNs land.
 */
export function isFastPacketPgn(pgn: number): boolean {
    return FAST_PACKET_PGNS.has(pgn);
}

const FAST_PACKET_PGNS = new Set<number>([
    126208, // NMEA — Request, Command, Acknowledge group function
    126464, // PGN List — transmit/receive
    126996, // Product Information
    126998, // Configuration Information
    127237, // Heading/Track Control
    127489, // Engine Parameters Dynamic   ← in our decoder
    127506, // DC Detailed Status
    127507, // Charger Status
    127513, // Battery Configuration Status
    128275, // Distance Log
    129029, // GNSS Position Data           ← in our decoder
    129038, // AIS Class A Position Report
    129039, // AIS Class B Position Report
    129040, // AIS Class B Extended Position Report
    129041, // AIS Aids to Navigation
    129044, // Datum
    129538, // GNSS Control Status
    129540, // GNSS Sats in View
    129793, // AIS UTC and Date Report
    129794, // AIS Class A Static and Voyage Related Data
    129798, // AIS SAR Aircraft Position Report
    129802, // AIS Safety Related Broadcast Message
    129809, // AIS Class B "CS" Static Data Report, Part A
    129810, // AIS Class B "CS" Static Data Report, Part B
    130312, // Temperature
    130577, // Direction Data
]);
