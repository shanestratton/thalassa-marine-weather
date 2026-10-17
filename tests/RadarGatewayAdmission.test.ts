import { describe, expect, it } from 'vitest';
import { validateNmeaSentence, classifyNmeaRejection } from '../services/nmea/nmeaSentence';
import { parseRadarSentence } from '../utils/radarTarget';
const at = Date.UTC(2026, 0, 2, 0, 0, 5, 123);
const frame = (body: string) =>
    '$' +
    body +
    '*' +
    [...body]
        .reduce((sum, c) => sum ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0');
const bodies = [
    'RATTM,01,1,0,R,10,180,R,0.2,6,N,Generated echo,T,,000005.123,A',
    'RATLL,01,5030.000,N,00115.000,W,Generated echo,000005.123,T,',
];
describe('physical gateway radar admission', () => {
    for (const body of bodies)
        it('admits checksum-qualified ' + body.slice(2, 5) + ' through the gateway and shared parser', () => {
            const raw = frame(body);
            expect(validateNmeaSentence(raw)).toMatchObject({
                kind: 'radar',
                hasChecksum: true,
                type: body.slice(2, 5),
            });
            expect(parseRadarSentence(raw, { feedId: 'gateway:generated', receivedAt: at, now: at })).toMatchObject({
                source: 'radar',
                at,
            });
            expect(validateNmeaSentence('$' + body)).toBeNull();
            expect(classifyNmeaRejection('$' + body)).toBe('malformed');
            expect(validateNmeaSentence(raw.slice(0, -2) + 'GG')).toBeNull();
            expect(validateNmeaSentence(raw + ' trailer')).toBeNull();
        });
    it('keeps legacy sounder compatibility and AIS checksum requirements unchanged', () => {
        expect(validateNmeaSentence('$SDDBT,8.1,f,2.4,M,1.3,F')).toMatchObject({
            kind: 'instrument',
            hasChecksum: false,
        });
        expect(validateNmeaSentence('!AIVDM,1,1,,A,15Mvq?0P00PD;88MD5MTDwwT0<0l,0')).toBeNull();
    });
    it('refuses oversized or non-ASCII radar frames even with valid checksums', () => {
        expect(validateNmeaSentence(frame('RATTM,' + 'x'.repeat(260)))).toBeNull();
        expect(validateNmeaSentence(frame(bodies[0].replace('Generated echo', 'Généré')))).toBeNull();
    });
});
