/**
 * THE 2GB LEAK. An NMEA feed with no line delimiter grew a JS string forever.
 *
 *     this.tcpLineBuffer += result;
 *     const lines = this.tcpLineBuffer.split(/\r?\n/);
 *     this.tcpLineBuffer = lines.pop() || '';
 *
 * Handing the trailing PARTIAL line back is correct — a sentence split across
 * two reads must survive. But if the stream carries no newline at all, split
 * returns one element, pop() returns the whole thing, and the buffer grows for
 * as long as the feed runs. Nothing reset it between connect and disconnect.
 *
 * That is a plain JavaScript string, which is why it was invisible: every
 * memory census before this read ENC 0, tiles 0, GL 0, DOM 2,590 — all tiny —
 * while com.apple.WebKit.WebContent was killed at exactly 2048.0 MB with
 * reason "per-process-limit".
 *
 * Shane's Web Inspector settled it (2026-09-05): a live feed logging "dropped
 * 2,251 malformed/checksum-invalid sentence(s)" and climbing, across 25.7
 * MILLION TcpSocket.read calls in one session. A stream failing its checksums
 * is exactly the stream that may carry no newline.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('services/NmeaListenerService.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The accumulate-and-cap logic, restated independently of the service. */
function accumulate(chunks: string[], max = 64 * 1024, tail = 512) {
    let buffer = '';
    let discarded = 0;
    for (const chunk of chunks) {
        buffer += chunk;
        if (buffer.length > max) {
            discarded += buffer.length - tail;
            buffer = buffer.slice(-tail);
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
    }
    return { buffer, discarded };
}

describe('the NMEA line buffer is bounded', () => {
    it('a delimiter-free feed can no longer grow without limit', () => {
        // 4MB of garbage with not one newline — the shape that reached 2GB.
        const chunks = Array.from({ length: 4096 }, () => 'x'.repeat(1024));
        const { buffer, discarded } = accumulate(chunks);
        expect(buffer.length).toBeLessThanOrEqual(64 * 1024);
        expect(discarded).toBeGreaterThan(3_000_000);
    });

    it('a sentence split across two reads still survives', () => {
        // The whole reason the partial line is kept. This must not regress.
        const { buffer } = accumulate(['$GPGGA,123519,4807.', '038,N*47\r\n$GPRMC,rest']);
        expect(buffer).toBe('$GPRMC,rest');
    });

    it('a sentence straddling a discard can still complete', () => {
        // The tail is kept precisely so the cut does not eat a live sentence.
        const { buffer } = accumulate(['y'.repeat(70_000) + '$GPGGA,partial']);
        expect(buffer.endsWith('$GPGGA,partial')).toBe(true);
    });

    it('the service caps the buffer and says so out loud', () => {
        expect(code).toMatch(/const TCP_LINE_BUFFER_MAX = 64 \* 1024;/);
        expect(code).toMatch(/if \(this\.tcpLineBuffer\.length > TCP_LINE_BUFFER_MAX\)/);
        expect(code).toMatch(/this\.tcpLineBuffer = this\.tcpLineBuffer\.slice\(-TCP_LINE_BUFFER_TAIL\)/);
        // Silently discarding vessel data would be its own bug.
        expect(code).toMatch(/log\.warn\(/);
    });

    it('the buffer is now COUNTABLE, so this class of leak cannot hide again', () => {
        expect(code).toMatch(/registerCensusProbe\('nmeaBufferKB'/);
        expect(code).toMatch(/registerCensusProbe\('nmeaDiscardedKB'/);
    });
});
