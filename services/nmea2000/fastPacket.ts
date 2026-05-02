/**
 * NMEA 2000 Fast Packet reassembly.
 *
 * Fast Packet PGNs carry up to 223 bytes split across multiple CAN
 * frames. Wire format:
 *
 *   FRAME 0 (first frame of a sequence):
 *     byte 0:  upper 3 bits = sequence ID (0-7, rolls over)
 *              lower 5 bits = frame counter = 0
 *     byte 1:  total payload length in bytes
 *     bytes 2-7: first 6 payload bytes
 *
 *   FRAME N (N=1..31):
 *     byte 0:  upper 3 bits = same sequence ID as frame 0
 *              lower 5 bits = frame counter = N
 *     bytes 1-7: next 7 payload bytes
 *
 * Reassembly is per-(source address, PGN) — two devices broadcasting the
 * same PGN simultaneously must not corrupt each other's reassembly. The
 * sequence ID guards against frame loss: if we see a frame with a
 * different sequence ID than the in-flight one, we abandon the in-flight
 * payload and start over.
 *
 * If a sequence stalls (we see frame 0 of a new sequence before the old
 * one completes), the old payload is dropped silently. CAN buses don't
 * guarantee delivery so this is normal.
 */

const SEQUENCE_BITS_MASK = 0xe0; // upper 3 bits
const COUNTER_BITS_MASK = 0x1f; // lower 5 bits
const FIRST_FRAME_DATA_BYTES = 6;
const SUBSEQUENT_FRAME_DATA_BYTES = 7;
const MAX_PAYLOAD_BYTES = 223;

interface InFlight {
    /** Sequence ID we're tracking (upper 3 bits of byte 0). */
    sequenceId: number;
    /** Total payload length (from frame 0 byte 1). */
    totalLength: number;
    /** Buffer being assembled. Sized to totalLength on frame 0. */
    payload: Uint8Array;
    /** Bytes filled so far. */
    written: number;
    /** Next expected frame counter (0 = frame 0, 1 = frame 1, …). */
    expectedCounter: number;
}

/**
 * Per-(source, PGN) reassembly buffer. Single instance owned by the
 * top-level N2K transport; feed every Fast Packet frame through `feed`
 * and consume completed payloads via the returned tuple.
 */
export class FastPacketReassembler {
    private inFlight = new Map<string, InFlight>();

    /**
     * Feed a single CAN frame for a Fast Packet PGN. Returns a fully
     * reassembled payload `Uint8Array` once the last frame arrives,
     * otherwise null.
     *
     * @param source - source address (0-255)
     * @param pgn    - PGN number
     * @param data   - the 8-byte CAN frame payload
     */
    feed(source: number, pgn: number, data: Uint8Array): Uint8Array | null {
        if (data.length < 1) return null;
        const key = `${source}:${pgn}`;
        const sequenceId = data[0] & SEQUENCE_BITS_MASK;
        const counter = data[0] & COUNTER_BITS_MASK;

        if (counter === 0) {
            // First frame of a new sequence. Discard any in-flight for
            // this (source, pgn) — either it stalled or the sender
            // recycled the sequence ID. Either way the new frame wins.
            if (data.length < 2) return null;
            const totalLength = data[1];
            if (totalLength < 1 || totalLength > MAX_PAYLOAD_BYTES) return null;

            const payload = new Uint8Array(totalLength);
            const firstChunk = Math.min(FIRST_FRAME_DATA_BYTES, totalLength, data.length - 2);
            payload.set(data.subarray(2, 2 + firstChunk), 0);

            // Edge case: totalLength <= 6 means a "Fast Packet" PGN that
            // happens to fit in a single frame's first-frame payload area.
            // Complete immediately.
            if (firstChunk >= totalLength) {
                this.inFlight.delete(key);
                return payload;
            }

            this.inFlight.set(key, {
                sequenceId,
                totalLength,
                payload,
                written: firstChunk,
                expectedCounter: 1,
            });
            return null;
        }

        // Subsequent frame — must match an in-flight sequence.
        const inFlight = this.inFlight.get(key);
        if (!inFlight) return null;
        if (inFlight.sequenceId !== sequenceId) {
            // Different sequence ID for the same (source, pgn). Drop —
            // the sender either cancelled and started over, or we missed
            // frame 0 of a new run. Wait for the next frame-0.
            this.inFlight.delete(key);
            return null;
        }
        if (counter !== inFlight.expectedCounter) {
            // Out-of-order or skipped frame. Abandon — N2K doesn't
            // retransmit and we don't try to repair.
            this.inFlight.delete(key);
            return null;
        }

        const remaining = inFlight.totalLength - inFlight.written;
        const chunk = Math.min(SUBSEQUENT_FRAME_DATA_BYTES, remaining, data.length - 1);
        inFlight.payload.set(data.subarray(1, 1 + chunk), inFlight.written);
        inFlight.written += chunk;
        inFlight.expectedCounter += 1;

        if (inFlight.written >= inFlight.totalLength) {
            this.inFlight.delete(key);
            return inFlight.payload;
        }
        return null;
    }

    /** Drop all in-flight reassemblies. Useful on transport reset. */
    reset(): void {
        this.inFlight.clear();
    }

    /** Diagnostic: how many sequences are currently mid-flight. */
    get inFlightCount(): number {
        return this.inFlight.size;
    }
}
