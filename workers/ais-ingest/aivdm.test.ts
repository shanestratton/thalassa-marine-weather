/**
 * The AIVDM decoder, tested against independently-generated sentences.
 *
 * Every vector below was bit-packed by a separate Python encoder (not this
 * decoder's own maths) with checksums computed over the exact sentence body,
 * so a mirrored misunderstanding of the spec cannot pass. Faithfulness to
 * the app's battle-tested decoder is pinned separately in the main suite
 * (tests/AisBridgeDecoderParity.test.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetFragmentsForTest, aivdoToAivdm, decodeAisSentence, nmeaChecksumOk } from './aivdm.js';

// MMSI 503101240 at 27.2085°S 153.0875°E, sog 6.5, cog 123.4, hdg 124, nav 0
const T1 = '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D';
// Same position, every sentinel: sog 102.3, cog 360.0, heading 511, nav 15
const T1_SENTINELS = '!AIVDM,1,1,,B,17Ojo>?0?wbtinahKV5>4?wp0000,0*12';
// Null Island
const T1_NULL_ISLAND = '!AIVDM,1,1,,B,17Ojo>0000P0000000000?wp0000,0*3F';
// Own-ship Class B position: sog 5.2, cog 200.0, hdg 199
const T18_AIVDO = '!AIVDO,1,1,,B,B7Ojo>00=:g<MbL6qQAu1Sv00000,0*1F';
// Class B static Part A: name WHISKERS
const T24A = '!AIVDM,1,1,,B,H7Ojo>1LPU<dE9<000000000000,0*4E';
// Class B static Part B: type 36 (sailing), callsign VJN4567, dims 8/4/2/2
const T24B = '!AIVDM,1,1,,B,H7Ojo>4T0000000F:>lmno104220,0*39';
// Class A static across two fragments: IMO 9074729, callsign 3FOF8,
// name EVER DIADEM, type 70, destination NEWPORT
const T5_F1 = '!AIVDM,2,1,7,A,57Ojo>02:N2W<HtKP00EHE:0@T4@Dl000000,0*66';
const T5_F2 = '!AIVDM,2,2,7,A,0016L961O400003QEl3lU00000000000000,2*5C';

beforeEach(() => __resetFragmentsForTest());

// Fictional, generated bit fixtures; no boat recordings or provider downloads.
function generatedSentence(
    length: number,
    fields: readonly [number, number, number][],
    texts: readonly [number, string][] = [],
): string {
    const bits = Array<number>(length).fill(0);
    for (const [start, width, value] of fields)
        for (let bit = 0; bit < width; bit++) bits[start + bit] = Math.floor(value / 2 ** (width - 1 - bit)) % 2;
    for (const [start, text] of texts)
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i) & 63;
            for (let b = 0; b < 6; b++) bits[start + i * 6 + b] = (code >> (5 - b)) & 1;
        }
    const fill = (6 - (length % 6)) % 6;
    bits.push(...Array<number>(fill).fill(0));
    let payload = '';
    for (let i = 0; i < bits.length; i += 6) {
        const code = bits.slice(i, i + 6).reduce((a, b) => a * 2 + b, 0);
        payload += String.fromCharCode(code + (code < 40 ? 48 : 56));
    }
    const body = `AIVDM,1,1,,A,${payload},${fill}`;
    let checksum = 0;
    for (const char of body) checksum ^= char.charCodeAt(0);
    return `!${body}*${checksum.toString(16).padStart(2, '0')}`;
}

describe('bounded relayed message14 and static fields', () => {
    it.each([970111111, 972111111, 974111111])(
        'preserves text and receipt age without inventing position for %s',
        (mmsi) => {
            const receivedAt = Date.parse('2026-10-16T00:00:00Z');
            const text = 'TEST BEACON';
            const sentence = generatedSentence(
                40 + 6 * text.length,
                [
                    [0, 6, 14],
                    [8, 30, mmsi],
                ],
                [[40, text]],
            );
            expect(decodeAisSentence(sentence, receivedAt)).toEqual({
                mmsi,
                safety_text: text,
                safety_text_at: new Date(receivedAt).toISOString(),
                data_source: 'receiver',
            });
        },
    );
    it('decodes draught and yearless ETA from a generated classA static report', () => {
        const sentence = generatedSentence(
            424,
            [
                [0, 6, 5],
                [8, 30, 123456789],
                [274, 4, 12],
                [278, 5, 31],
                [283, 5, 23],
                [288, 6, 59],
                [294, 8, 72],
            ],
            [[112, 'FICTIONAL SHIP']],
        );
        expect(decodeAisSentence(sentence)).toMatchObject({ mmsi: 123456789, draught_m: 7.2, eta: '12-31 23:59' });
        const unknown = generatedSentence(
            424,
            [
                [0, 6, 5],
                [8, 30, 123456789],
                [283, 5, 24],
                [288, 6, 60],
            ],
            [[112, 'FICTIONAL SHIP']],
        );
        expect(decodeAisSentence(unknown)?.eta).toBeUndefined();
        expect(decodeAisSentence(unknown)?.draught_m).toBeUndefined();
    });
    it('rejects truncated position/static packets and oversized text before zero-padding can invent fields', () => {
        expect(
            decodeAisSentence(
                generatedSentence(38, [
                    [0, 6, 1],
                    [8, 30, 123456789],
                ]),
            ),
        ).toBeNull();
        expect(
            decodeAisSentence(
                generatedSentence(
                    120,
                    [
                        [0, 6, 5],
                        [8, 30, 123456789],
                    ],
                    [[70, 'FAKE']],
                ),
            ),
        ).toBeNull();
        expect(
            decodeAisSentence(
                generatedSentence(
                    40 + 6 * 162,
                    [
                        [0, 6, 14],
                        [8, 30, 970111111],
                    ],
                    [[40, 'A'.repeat(162)]],
                ),
            ),
        ).toBeNull();
    });
});

describe('checksum', () => {
    it('accepts a correct checksum and rejects a corrupted body', () => {
        expect(nmeaChecksumOk(T1)).toBe(true);
        expect(nmeaChecksumOk(T1.replace('17Ojo', '17Ojp'))).toBe(false);
        expect(nmeaChecksumOk('!AIVDM,no,star')).toBe(false);
    });
});

describe('Class A position (type 1)', () => {
    it('decodes position, motion and status', () => {
        const r = decodeAisSentence(T1);
        expect(r).toMatchObject({ mmsi: 503101240, cog: 123.4, sog: 6.5, heading: 124, nav_status: 0 });
        expect(r!.lat).toBeCloseTo(-27.2085, 4);
        expect(r!.lon).toBeCloseTo(153.0875, 4);
    });

    it('omits every sentinel value rather than storing fake motion', () => {
        const r = decodeAisSentence(T1_SENTINELS);
        expect(r).not.toBeNull();
        expect(r!.cog).toBeUndefined(); // 360.0
        expect(r!.sog).toBeUndefined(); // 102.3
        expect(r!.heading).toBeUndefined(); // 511
        expect(r!.nav_status).toBe(15);
    });

    it('rejects Null Island', () => {
        expect(decodeAisSentence(T1_NULL_ISLAND)).toBeNull();
    });
});

describe('Class B (types 18 and 24)', () => {
    it('decodes own-ship AIVDO — the whole point of the bridge', () => {
        const r = decodeAisSentence(T18_AIVDO);
        expect(r).toMatchObject({ mmsi: 503101240, sog: 5.2, cog: 200.0, heading: 199, nav_status: 15 });
    });

    it('Part A carries the yacht name', () => {
        expect(decodeAisSentence(T24A)).toEqual({ mmsi: 503101240, name: 'WHISKERS', data_source: 'receiver' });
    });

    it('Part B carries type, call sign', () => {
        const r = decodeAisSentence(T24B);
        expect(r).toMatchObject({ mmsi: 503101240, ship_type: 36, call_sign: 'VJN4567' });
    });
});

describe('multi-fragment assembly (type 5)', () => {
    it('assembles two fragments into one static record', () => {
        expect(decodeAisSentence(T5_F1)).toBeNull(); // buffered
        const r = decodeAisSentence(T5_F2);
        expect(r).toMatchObject({
            mmsi: 503101240,
            name: 'EVER DIADEM',
            call_sign: '3FOF8',
            ship_type: 70,
            destination: 'NEWPORT',
            imo_number: 9074729,
        });
    });

    it('assembles out-of-order arrival too', () => {
        expect(decodeAisSentence(T5_F2)).toBeNull();
        expect(decodeAisSentence(T5_F1)).toMatchObject({ name: 'EVER DIADEM' });
    });

    it('evicts a stale half instead of cross-assembling with a later message', () => {
        const t0 = Date.now();
        expect(decodeAisSentence(T5_F1, t0)).toBeNull();
        // 31 s later the other half arrives — too late, the pair is dead.
        expect(decodeAisSentence(T5_F2, t0 + 31_000)).toBeNull();
    });
});

describe('AIVDO → AIVDM rewrite for the AISHub forward', () => {
    it('rewrites the talker and recomputes the checksum', () => {
        const out = aivdoToAivdm(T18_AIVDO);
        expect(out).not.toBeNull();
        expect(out!.startsWith('!AIVDM,')).toBe(true);
        expect(nmeaChecksumOk(out!)).toBe(true);
        // Payload untouched — only the talker and checksum change.
        expect(out!.split(',')[5]).toBe(T18_AIVDO.split(',')[5]);
    });

    it('refuses non-AIVDO and corrupt input', () => {
        expect(aivdoToAivdm(T1)).toBeNull();
        expect(aivdoToAivdm(T18_AIVDO.replace('B7', 'B8'))).toBeNull();
    });
});

describe('fragment isolation between sources (the fleet-feed dimension)', () => {
    it('two sources sharing a sequence id cannot cross-assemble', () => {
        // Boat A sends fragment 1 of a type 5; boat B sends fragment 2 of a
        // DIFFERENT type 5 with the same seq id and channel. Without the
        // source key these would merge into a chimera vessel.
        expect(decodeAisSentence(T5_F1, Date.now(), 'user-a')).toBeNull();
        expect(decodeAisSentence(T5_F2, Date.now(), 'user-b')).toBeNull();
        // Each source completing its OWN pair still works.
        expect(decodeAisSentence(T5_F2, Date.now(), 'user-a')).toMatchObject({ name: 'EVER DIADEM' });
        expect(decodeAisSentence(T5_F1, Date.now(), 'user-b')).toMatchObject({ name: 'EVER DIADEM' });
    });
});
