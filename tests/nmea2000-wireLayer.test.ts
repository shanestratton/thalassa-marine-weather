/**
 * Tests for the N2K wire layer — CAN ID decoder, Fast Packet
 * reassembly, and the Actisense / canboat ASCII frame parser.
 */
import { describe, expect, it } from 'vitest';
import { decodeCanId, encodeCanId, isFastPacketPgn } from '../services/nmea2000/canId';
import { FastPacketReassembler } from '../services/nmea2000/fastPacket';
import { AsciiFrameStream, parseAscii } from '../services/nmea2000/actisenseAscii';

// ── canId ───────────────────────────────────────────────────────────

describe('decodeCanId — broadcast PGN (PF >= 240)', () => {
    it('decodes PGN 130306 (Wind Data) with priority 2 from source 35', () => {
        // Construct: priority 2, PGN 130306 = 0x1FD06, source 35
        const pgn = 130306;
        const id = encodeCanId({ priority: 2, pgn, source: 35, destination: null });
        const out = decodeCanId(id);
        expect(out.pgn).toBe(pgn);
        expect(out.priority).toBe(2);
        expect(out.source).toBe(35);
        expect(out.destination).toBeNull();
    });

    it('decodes PGN 129025 (Position Rapid) — high-cadence broadcast', () => {
        const pgn = 129025;
        const id = encodeCanId({ priority: 2, pgn, source: 0, destination: null });
        expect(decodeCanId(id).pgn).toBe(pgn);
    });

    it('decodes PGN 127250 (Vessel Heading)', () => {
        const id = encodeCanId({ priority: 2, pgn: 127250, source: 35, destination: null });
        expect(decodeCanId(id).pgn).toBe(127250);
    });

    it('masks high bits (defensive against extended-frame flags)', () => {
        const id = encodeCanId({ priority: 2, pgn: 130306, source: 35, destination: null });
        // Set bit 31 (extended frame flag some adapters surface)
        const flagged = (id | 0x80000000) >>> 0;
        expect(decodeCanId(flagged).pgn).toBe(130306);
    });
});

describe('decodeCanId — peer-to-peer PGN (PF < 240)', () => {
    it('decodes PGN 65282 (proprietary, 65282 = 0xFF02 — wait, that is broadcast)', () => {
        // Use a real peer-to-peer PGN: 60928 = 0xEE00 (ISO Address Claim).
        const pgn = 60928;
        const id = encodeCanId({ priority: 6, pgn, source: 35, destination: 255 });
        const out = decodeCanId(id);
        expect(out.pgn).toBe(pgn);
        expect(out.destination).toBe(255);
    });

    it('round-trips a random destination address', () => {
        const id = encodeCanId({ priority: 3, pgn: 59904, source: 17, destination: 42 });
        const out = decodeCanId(id);
        expect(out.pgn).toBe(59904);
        expect(out.destination).toBe(42);
        expect(out.source).toBe(17);
    });
});

describe('isFastPacketPgn', () => {
    it('flags engine dynamic + GNSS as Fast Packet', () => {
        expect(isFastPacketPgn(127489)).toBe(true);
        expect(isFastPacketPgn(129029)).toBe(true);
    });

    it('returns false for single-frame PGNs', () => {
        expect(isFastPacketPgn(127250)).toBe(false); // Heading
        expect(isFastPacketPgn(129025)).toBe(false); // Position Rapid
        expect(isFastPacketPgn(130306)).toBe(false); // Wind Data
    });
});

// ── Fast Packet reassembly ──────────────────────────────────────────

describe('FastPacketReassembler', () => {
    function frameZero(seqId: number, totalLen: number, dataBytes: number[]): Uint8Array {
        const buf = new Uint8Array(8);
        buf[0] = (seqId & 0x07) << 5; // counter = 0
        buf[1] = totalLen;
        for (let i = 0; i < dataBytes.length && i < 6; i++) buf[2 + i] = dataBytes[i];
        return buf;
    }

    function frameN(seqId: number, counter: number, dataBytes: number[]): Uint8Array {
        const buf = new Uint8Array(8);
        buf[0] = ((seqId & 0x07) << 5) | (counter & 0x1f);
        for (let i = 0; i < dataBytes.length && i < 7; i++) buf[1 + i] = dataBytes[i];
        return buf;
    }

    it('reassembles a 13-byte payload across 2 frames', () => {
        const re = new FastPacketReassembler();
        const expected = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
        // Frame 0: 6 data bytes
        const f0 = frameZero(1, 13, expected.slice(0, 6));
        // Frame 1: remaining 7 data bytes
        const f1 = frameN(1, 1, expected.slice(6, 13));
        expect(re.feed(35, 127489, f0)).toBeNull();
        const out = re.feed(35, 127489, f1);
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual(expected);
    });

    it('reassembles a 26-byte payload across 4 frames (engine dynamic shape)', () => {
        const re = new FastPacketReassembler();
        const expected: number[] = [];
        for (let i = 0; i < 26; i++) expected.push(i);

        let result: Uint8Array | null = null;
        result = re.feed(35, 127489, frameZero(2, 26, expected.slice(0, 6)));
        expect(result).toBeNull();
        result = re.feed(35, 127489, frameN(2, 1, expected.slice(6, 13)));
        expect(result).toBeNull();
        result = re.feed(35, 127489, frameN(2, 2, expected.slice(13, 20)));
        expect(result).toBeNull();
        result = re.feed(35, 127489, frameN(2, 3, expected.slice(20, 26)));
        expect(result).not.toBeNull();
        expect(Array.from(result!)).toEqual(expected);
    });

    it('keeps two devices broadcasting the same PGN separate by source', () => {
        const re = new FastPacketReassembler();
        const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
        const b = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113];

        re.feed(35, 127489, frameZero(0, 13, a.slice(0, 6)));
        re.feed(36, 127489, frameZero(0, 13, b.slice(0, 6)));
        const outA = re.feed(35, 127489, frameN(0, 1, a.slice(6, 13)));
        const outB = re.feed(36, 127489, frameN(0, 1, b.slice(6, 13)));
        expect(Array.from(outA!)).toEqual(a);
        expect(Array.from(outB!)).toEqual(b);
    });

    it('drops in-flight when sequence ID changes mid-flight', () => {
        const re = new FastPacketReassembler();
        re.feed(35, 127489, frameZero(0, 13, [1, 2, 3, 4, 5, 6]));
        // Sender bumped sequence ID — likely dropped a frame and started over.
        // This NEW frame 0 abandons the old sequence and starts fresh.
        const newSeqStart = re.feed(35, 127489, frameZero(1, 13, [10, 11, 12, 13, 14, 15]));
        expect(newSeqStart).toBeNull(); // first frame of new run; not yet complete
        // Send the old sequence's frame 1 — should be dropped (we're now
        // tracking sequence 1, not 0).
        const wrong = re.feed(35, 127489, frameN(0, 1, [7, 8, 9, 10, 11, 12, 13]));
        expect(wrong).toBeNull();
        // In-flight count should still be 1 (the new sequence we abandoned by mismatch).
        expect(re.inFlightCount).toBe(0);
    });

    it('drops in-flight when counter is out of order', () => {
        const re = new FastPacketReassembler();
        re.feed(35, 127489, frameZero(0, 26, [1, 2, 3, 4, 5, 6]));
        // Skip frame 1, send frame 2 directly → reassembler abandons.
        const out = re.feed(35, 127489, frameN(0, 2, [14, 15, 16, 17, 18, 19, 20]));
        expect(out).toBeNull();
        expect(re.inFlightCount).toBe(0);
    });

    it('rejects malformed first frames (totalLength out of range)', () => {
        const re = new FastPacketReassembler();
        // totalLength=0 — invalid
        const f0 = frameZero(0, 0, []);
        expect(re.feed(35, 127489, f0)).toBeNull();
    });

    it('completes immediately when totalLength <= 6 (fits in one frame)', () => {
        const re = new FastPacketReassembler();
        const out = re.feed(35, 127489, frameZero(0, 4, [10, 20, 30, 40]));
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual([10, 20, 30, 40]);
    });

    it('reset() clears all in-flight sequences', () => {
        const re = new FastPacketReassembler();
        re.feed(35, 127489, frameZero(0, 26, [1, 2, 3, 4, 5, 6]));
        re.feed(36, 129029, frameZero(0, 43, [1, 2, 3, 4, 5, 6]));
        expect(re.inFlightCount).toBe(2);
        re.reset();
        expect(re.inFlightCount).toBe(0);
    });
});

// ── ASCII frame parsing ─────────────────────────────────────────────

describe('parseAscii — Actisense / canboat raw frame', () => {
    it('parses a typical received-frame line', () => {
        // PGN 130306 (Wind Data), source 35, priority 2.
        const id = encodeCanId({ priority: 2, pgn: 130306, source: 35, destination: null });
        const idHex = id.toString(16).padStart(8, '0');
        const line = `2025-05-02-14:30:15.123 R ${idHex} 00 7C 0D 5A 0F 02 FF FF`;
        const frame = parseAscii(line);
        expect(frame).not.toBeNull();
        expect(frame!.pgn).toBe(130306);
        expect(frame!.source).toBe(35);
        expect(frame!.priority).toBe(2);
        expect(frame!.data).toHaveLength(8);
        expect(frame!.data[0]).toBe(0x00);
        expect(frame!.data[7]).toBe(0xff);
    });

    it('ignores transmitted (T) frames', () => {
        const id = encodeCanId({ priority: 2, pgn: 130306, source: 35, destination: null });
        const idHex = id.toString(16).padStart(8, '0');
        const line = `2025-05-02-14:30:15.123 T ${idHex} 00 7C 0D 5A 0F 02 FF FF`;
        expect(parseAscii(line)).toBeNull();
    });

    it('parses lines without the timestamp prefix', () => {
        const id = encodeCanId({ priority: 2, pgn: 127250, source: 35, destination: null });
        const idHex = id.toString(16).padStart(8, '0');
        const line = `R ${idHex} 12 00 00 00 00 00 00 FE`;
        const frame = parseAscii(line);
        expect(frame!.pgn).toBe(127250);
    });

    it('skips comments and empty lines', () => {
        expect(parseAscii('')).toBeNull();
        expect(parseAscii('   ')).toBeNull();
        expect(parseAscii('# this is a comment')).toBeNull();
    });

    it('returns null for malformed frames', () => {
        expect(parseAscii('R XYZ 00 11 22')).toBeNull();
        expect(parseAscii('R 09F8027F')).toBeNull(); // no payload
    });
});

describe('parseAscii — $PCDIN wrapped frame (YDWG-02 0183 mode)', () => {
    it('parses a wind-data PCDIN sentence', () => {
        // PGN 130306, source 0x0F (= 15), payload 8 bytes
        const line = '$PCDIN,01FD06,000C72EA,0F,007C0D5A0F02FFFF*5C';
        const frame = parseAscii(line);
        expect(frame).not.toBeNull();
        expect(frame!.pgn).toBe(0x1fd06);
        expect(frame!.source).toBe(0x0f);
        expect(frame!.data).toHaveLength(8);
        expect(frame!.data[0]).toBe(0x00);
        expect(frame!.data[2]).toBe(0x0d);
    });

    it('returns null for malformed PCDIN (odd hex length)', () => {
        expect(parseAscii('$PCDIN,01FD06,000C72EA,0F,007C0D5A0F02FFF*5C')).toBeNull();
    });
});

describe('AsciiFrameStream — partial-line accumulation', () => {
    it('emits frames only when full lines arrive', () => {
        const stream = new AsciiFrameStream();
        const id = encodeCanId({ priority: 2, pgn: 130306, source: 35, destination: null });
        const idHex = id.toString(16).padStart(8, '0');

        const half1 = `R ${idHex} 00 7C 0D 5A 0F 02 FF FF\nR ${idHex.substring(0, 4)}`;
        const half2 = `${idHex.substring(4)} 11 22 33 44 55 66 77 88\n`;

        const out1 = stream.feed(half1);
        expect(out1).toHaveLength(1);
        expect(out1[0].pgn).toBe(130306);

        // Buffered partial line completes on next feed.
        const out2 = stream.feed(half2);
        expect(out2).toHaveLength(1);
        expect(out2[0].data[0]).toBe(0x11);
    });

    it('handles \\r\\n and bare \\r line endings', () => {
        const stream = new AsciiFrameStream();
        const id = encodeCanId({ priority: 2, pgn: 130306, source: 35, destination: null });
        const idHex = id.toString(16).padStart(8, '0');
        const out = stream.feed(`R ${idHex} 00 7C 0D 5A 0F 02 FF FF\r\nR ${idHex} 01 02 03 04 05 06 07 08\r`);
        expect(out).toHaveLength(2);
    });

    it('reset() clears the partial-line buffer', () => {
        const stream = new AsciiFrameStream();
        stream.feed('partial line, no newline');
        stream.reset();
        // Now feed a complete line — the partial garbage shouldn't taint it.
        const id = encodeCanId({ priority: 2, pgn: 130306, source: 35, destination: null });
        const idHex = id.toString(16).padStart(8, '0');
        const out = stream.feed(`R ${idHex} 00 7C 0D 5A 0F 02 FF FF\n`);
        expect(out).toHaveLength(1);
    });
});
