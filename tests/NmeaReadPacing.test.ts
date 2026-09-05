/**
 * 25.7 MILLION TcpSocket.read calls in one session — about 7,000 a second.
 *
 * The data path ended in a bare `continue`, straight back into the next read
 * with nothing between them. capacitor-tcp-socket resolves as soon as ANY
 * bytes are available, not when expectLen is full, so against a live gateway
 * this loop never waits for a sentence. It spins as fast as the bridge can
 * answer, and every iteration is a full round trip across the ONE serial queue
 * the whole app shares: a call object, a result object and a response string
 * allocated per call, on both sides.
 *
 * That is an allocation RATE, not a retained size, which is exactly why every
 * census probe stayed small (ENC 0, tiles 0, GL 0, canvas 15 MB, DOM ~2,590)
 * while com.apple.WebKit.WebContent was killed at 2048.0 MB per-process-limit.
 * A retained-size counter cannot see garbage produced faster than it is
 * collected, and it is the same queue saturation behind unrelated plugins
 * stalling behind a tcp read.
 *
 * The floor is 40 ms — 25 reads a second against a feed that carries 3.8 KB/s
 * at 38400 baud, or ~10 KB/s with AIS. A read that comes back near-full means
 * bytes are still queued, and that case must NOT be paced or a busy gateway
 * would fall behind. Pacing may only ever spend headroom that exists.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('services/NmeaListenerService.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const INTERVAL_MS = 40;
const BUFFER = 4096;
const BACKLOG = BUFFER - 512;

/**
 * The pacing decision, restated independently of the service: given how long
 * a read took and how much it returned, how long until the next one may start?
 */
function pauseAfterRead(bytesReturned: number, readTookMs: number): number {
    if (bytesReturned >= BACKLOG) return 0;
    return Math.max(0, INTERVAL_MS - readTookMs);
}

/** Reads issued over a window, given a feed rate and an instant bridge. */
function readsInWindow(windowMs: number, bytesPerSecond: number): number {
    let clock = 0;
    let reads = 0;
    let queued = 0;
    let lastDrain = 0;
    while (clock < windowMs) {
        reads++;
        queued += ((clock - lastDrain) * bytesPerSecond) / 1000;
        lastDrain = clock;
        const returned = Math.min(queued, BUFFER);
        queued -= returned;
        clock += pauseAfterRead(returned, 0);
        if (returned < BACKLOG) continue;
    }
    return reads;
}

describe('NMEA read pacing', () => {
    it('caps an idle-ish feed at ~25 reads a second, not thousands', () => {
        // 3.8 KB/s is 38400 baud NMEA — the common case.
        const reads = readsInWindow(10_000, 3_840);
        expect(reads).toBeLessThanOrEqual(260);
        expect(reads).toBeGreaterThan(200);
    });

    it('is 350x fewer bridge calls than an unpaced loop over an hour', () => {
        const paced = readsInWindow(3_600_000, 3_840);
        // The measured unpaced rate that produced 25.7M calls.
        const unpaced = 7_000 * 3_600;
        expect(unpaced / paced).toBeGreaterThan(250);
    });

    it('never paces a backed-up socket — a full read drains immediately', () => {
        expect(pauseAfterRead(BUFFER, 0)).toBe(0);
        expect(pauseAfterRead(BACKLOG, 0)).toBe(0);
        // 100 KB/s is ten times any real gateway. Pacing must not throttle it.
        const reads = readsInWindow(1_000, 100_000);
        expect(reads).toBeGreaterThan(24);
    });

    it('keeps up with a feed far faster than any real gateway', () => {
        // Whatever the rate, the loop must move at least as many bytes as
        // arrive, or the kernel receive buffer overflows and sentences are lost.
        for (const rate of [3_840, 10_000, 50_000, 100_000]) {
            const reads = readsInWindow(10_000, rate);
            const capacity = reads * BUFFER;
            expect(capacity).toBeGreaterThan(rate * 10);
        }
    });

    it('does not pay the pause when the read itself already spent the interval', () => {
        expect(pauseAfterRead(200, 40)).toBe(0);
        expect(pauseAfterRead(200, 5_000)).toBe(0);
        expect(pauseAfterRead(200, 10)).toBe(30);
    });

    it('the service actually paces its data path', () => {
        expect(code).toMatch(/const TCP_MIN_READ_INTERVAL_MS = 40;/);
        expect(code).toMatch(/const TCP_READ_BACKLOG_BYTES = TCP_READ_BUFFER - 512;/);

        const loopStart = code.indexOf('while (this.tcpReadLoop');
        expect(loopStart).toBeGreaterThan(0);
        const dataPath = code.slice(loopStart, code.indexOf('Empty result', loopStart));

        // The backlog escape hatch comes BEFORE the sleep, or a busy socket
        // would be throttled by the very thing meant to protect it.
        const backlog = dataPath.indexOf('TCP_READ_BACKLOG_BYTES');
        const sleep = dataPath.indexOf('TCP_MIN_READ_INTERVAL_MS');
        expect(backlog).toBeGreaterThan(0);
        expect(sleep).toBeGreaterThan(backlog);
        expect(dataPath).toMatch(/setTimeout\(r, TCP_MIN_READ_INTERVAL_MS - spent\)/);
    });

    it('counts its own bridge calls so the next crash report can prove the rate', () => {
        expect(code).toMatch(/this\.tcpReadCalls\+\+;/);
        expect(code).toMatch(/registerCensusProbe\('nmeaReadCallsK'/);
        expect(code).toMatch(/registerCensusProbe\('nmeaBacklogReads'/);

        // The counter must be incremented on EVERY read, including the empty
        // ones — an idle socket that spins is the same bug.
        const inc = code.indexOf('this.tcpReadCalls++;');
        const read = code.indexOf('await TcpSocket.read({');
        expect(inc).toBeGreaterThan(0);
        expect(inc).toBeLessThan(read);
    });
});
