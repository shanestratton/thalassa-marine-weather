/**
 * "Malformed" must mean malformed.
 *
 * validateNmeaSentence returns null for two completely different situations —
 * a sentence this app does not USE, and a sentence that is actually corrupt —
 * and the listener counted both as "malformed/checksum-invalid". A perfectly
 * healthy gateway therefore produced an alarming, climbing reject count.
 *
 * Measured against Shane's live feed 2026-09-05: 126 of 275 sentences
 * "rejected", every checksum verified CORRECT by hand. They were GSV, VTG,
 * GLL, ZDA, ROT, DTM, HTD — satellites, course over ground, position, time,
 * rate of turn. Not faults; just types with no parser here.
 *
 * That false signal was read as evidence of a corrupt, possibly non-delimited
 * stream and cost a wrong diagnosis. A diagnostic that cries wolf is worse
 * than one that says nothing.
 */
import { describe, expect, it } from 'vitest';
import { classifyNmeaRejection, validateNmeaSentence } from '../services/nmea/nmeaSentence';

// Verbatim from the boat's Signal K output, checksums confirmed by hand.
const REAL_UNSUPPORTED = [
    '$YDGLL,2711.7056,S,15306.3337,E,225126.00,A,A*7A',
    '$YDZDA,225126.12,04,09,2026,,*64',
    '$YDHTD,V,,,M,N,,,,,,,,,A,,,*7D',
    '$YDDTM,W84,,0000.0000,N,00000.0000,E,0.00,W84*65',
    '$YDGSV,4,1,16,01,10,131,37,06,26,015,31,07,08,044,32,14,42,130,39*77',
];

describe('why a sentence was not accepted', () => {
    it('a valid sentence of an unsupported type is NOT called malformed', () => {
        for (const s of REAL_UNSUPPORTED) {
            expect(validateNmeaSentence(s), `${s} should be unparsed`).toBeNull();
            expect(classifyNmeaRejection(s), s).toBe('unsupported-type');
        }
    });

    it('a genuinely wrong checksum is still reported as such', () => {
        expect(classifyNmeaRejection('$YDZDA,225126.12,04,09,2026,,*00')).toBe('bad-checksum');
    });

    it('real corruption is still malformed', () => {
        expect(classifyNmeaRejection('$YDZDA,225126.12*ZZ')).toBe('malformed');
        expect(classifyNmeaRejection('garbage')).toBe('malformed');
        expect(classifyNmeaRejection('$YDZDA*12*34')).toBe('malformed');
    });

    it('the listener counts and words the two differently', () => {
        const src = readFileSync('services/NmeaListenerService.ts', 'utf8');
        expect(src).toMatch(/_nmeaUnsupportedTypes\+\+/);
        expect(src).toMatch(/ignored \$\{_nmeaUnsupportedTypes\} NMEA sentence\(s\) of types this app does not parse/);
        expect(src).toMatch(/dropped \$\{_nmeaSentenceRejects\} NMEA sentence\(s\) — \$\{why\}/);
    });
});

import { readFileSync } from 'node:fs';
