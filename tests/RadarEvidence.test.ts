import { describe, expect, it } from 'vitest';
import { RadarFeed, restoreRadarObservation, decodeRadarOwnship } from '../utils/radarFeed';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
const make = () => {
    const f = new RadarFeed('pi:generated');
    f.ingest(frame('GPRMC,120000,A,0000.000,N,17959.940,E,5,0,020126,,,A'), T, T);
    f.ingest(frame('HEHDT,0,T'), T, T);
    f.ingest(frame('RATTM,1,1,0,R,10,180,R,0.2,6,N,Generated,T,,120000,A'), T, T);
    return f;
};
describe('paired radar original evidence', () => {
    it('reconstructs exact original geometry and velocity after later navigation changes', () => {
        const f = make(),
            original = f.contacts(T)[0];
        f.ingest(frame('HEHDT,90,T'), T + 1000, T + 1000);
        const wire = JSON.parse(JSON.stringify(f.evidence(T + 1000)));
        expect(restoreRadarObservation(wire[0], f.feedId, T + 1000)).toEqual(original);
        expect(f.ownshipSnapshot().heading!.trueDeg).toBe(90);
        wire[0].ownship.position.lat = 89;
        expect(f.evidence(T + 1000)[0].ownship.position!.lat).toBe(0);
    });
    it('cannot renew clocks or motion by polling an old response', () => {
        const f = make(),
            evidence = f.evidence(T)[0];
        const stale = restoreRadarObservation(evidence, f.feedId, T + 16000)!;
        expect(stale.at).toBe(T);
        expect(stale.receivedAt).toBe(T);
        expect(stale.fresh).toBe(false);
        expect(stale.motion).toBeNull();
        expect(stale.position).toEqual(f.contacts(T)[0].position);
        expect(restoreRadarObservation(evidence, f.feedId, T + 120001)).toBeNull();
    });
    it('rejects changed feed, malformed dependencies, future evaluation and corrupt sentences', () => {
        const f = make(),
            e = f.evidence(T)[0];
        expect(restoreRadarObservation(e, 'pi:other', T)).toBeNull();
        for (const patch of [
            { evaluatedAt: T + 1001 },
            { receivedAt: T + 1001 },
            { sentence: e.sentence + 'x' },
            { ownship: { ...e.ownship, heading: { trueDeg: NaN, at: T } } },
            { ownship: { ...e.ownship, motion: { sogKn: 5, sogAt: T, cogTrueDeg: 0, cogAt: null } } },
        ])
            expect(restoreRadarObservation({ ...e, ...patch }, f.feedId, T)).toBeNull();
        expect(decodeRadarOwnship({ ...e.ownship, position: undefined }, f.feedId)).toBeNull();
    });
    it('retains original processing time for delayed batched ingress, without using poll time', () => {
        const f = new RadarFeed('gateway:delayed');
        f.ingest(frame('GPRMC,120002,A,0000.000,N,00000.000,E,5,0,020126,,,A'), T + 2000, T + 3000);
        f.ingest(frame('HEHDT,0,T'), T + 2000, T + 3000);
        f.ingest(frame('RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A'), T, T + 3000);
        expect(f.contacts(T + 3000)[0].motion).not.toBeNull();
        expect(restoreRadarObservation(f.evidence(T + 4000)[0], f.feedId, T + 4000)).toEqual(f.contacts(T + 4000)[0]);
        expect(restoreRadarObservation(f.evidence(T + 4000)[0], f.feedId, T + 17000)!.motion).toBeNull();
    });
});
