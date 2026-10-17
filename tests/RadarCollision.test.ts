import { describe, expect, it } from 'vitest';
import { RadarFeed } from '../utils/radarFeed';
import { gradeRadarContact, radarCollisionOwnship, worstRadarCandidates } from '../utils/radarCollision';
import { matchRadarToAis, type RadarAisMatchEvidence } from '../utils/radarAisMatch';
import { assessCollision, collisionSourceCanAlarm } from '../utils/collisionRule';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function prepared() {
    const feed = new RadarFeed('gateway:generated');
    feed.ingest(frame('GPRMC,120000,A,0000.000,N,17959.940,E,5,0,020126,,,A'), T, T);
    feed.ingest(frame('HEHDT,0,T'), T, T);
    feed.ingest(frame('RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A'), T, T);
    return feed;
}
describe('same-input radar uses the single collision rule', () => {
    it('retains the earliest actual dependency so a newer report cannot renew an older vector', () => {
        const f = new RadarFeed('pi:generated');
        f.ingest(frame('GPRMC,120004,A,0000.000,N,00000.000,E,5,0,020126,,,A'), T + 4000, T + 4000);
        f.ingest(frame('HEHDT,0,T'), T + 4000, T + 4000);
        f.ingest(frame('RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120010,A'), T + 10000, T + 10000);
        f.ingest(frame('GPRMC,120010,A,0000.000,N,00000.000,E,5,0,020126,,,A'), T + 10000, T + 10000);
        const c = f.contacts(T + 10000)[0],
            own = f.ownshipSnapshot();
        expect(gradeRadarContact(c, own, T + 10000)).toMatchObject({
            sourceAt: T + 4000,
            contact: { at: T + 10000 },
            assessment: { alarm: true },
        });
        expect(
            gradeRadarContact(
                c,
                {
                    ...own,
                    position: { ...own.position!, at: T + 20000 },
                    motion: { ...own.motion!, sogAt: T + 20000, cogAt: T + 20000 },
                },
                T + 20000,
            ),
        ).toMatchObject({ sourceAt: null, assessment: { rangeOnly: true, alarm: false } });
    });
    it('grades actual qualified relative motion identically to125, without a fake MMSI', () => {
        const f = prepared(),
            c = f.contacts(T)[0],
            own = f.ownshipSnapshot();
        const result = gradeRadarContact(c, own, T)!;
        expect(result.assessment).toEqual(
            assessCollision(
                { ...own.position!, sogKn: 5, cogDeg: 0, atAnchor: false, pair: null },
                {
                    ...c.position!,
                    sogKn: c.motion!.sogKn,
                    cogDeg: c.motion!.cogTrueDeg,
                    source: 'radar',
                    reportAgeSec: 0,
                },
            ),
        );
        expect(result.assessment.alarm).toBe(true);
        expect(result.contactKey).toBe(c.contactKey);
        expect('mmsi' in result).toBe(false);
        expect(collisionSourceCanAlarm('radar')).toBe(true);
        expect(collisionSourceCanAlarm('app')).toBe(false);
    });
    it('cannot borrow another feed GPS or course, or qualify stale/incoherent leaves', () => {
        const f = prepared(),
            c = f.contacts(T)[0],
            own = f.ownshipSnapshot();
        expect(gradeRadarContact(c, { ...own, feedId: 'other' }, T)).toBeNull();
        expect(gradeRadarContact(c, { ...own, position: { ...own.position!, at: T - 15001 } }, T)).toBeNull();
        expect(
            gradeRadarContact(c, { ...own, motion: { ...own.motion!, sogAt: T - 6001 } }, T)!.assessment.rangeOnly,
        ).toBe(true);
        expect(gradeRadarContact(c, { ...own, motion: null }, T)!.assessment.alarm).toBe(false);
        expect(gradeRadarContact(c, own, T + 16000)).toBeNull();
        expect(
            radarCollisionOwnship({ ...own, motion: { ...own.motion!, cogAt: T + 1001 } }, c.feedId, T)!.cogDeg,
        ).toBeNull();
    });
    it('range-only TLL, reference, acquiring and ambiguous true motion never alarm or clear a dangerous TTM', () => {
        const f = prepared(),
            own = f.ownshipSnapshot(),
            danger = gradeRadarContact(f.contacts(T)[0], own, T)!;
        for (const body of [
            'RATLL,1,0001.000,N,17959.940,E,Generated,120001,T,',
            'RATTM,1,1,0,R,10,180,T,0,6,N,Generated,T,,120001,A',
            'RATTM,1,1,0,R,10,180,R,0,6,N,Generated,Q,,120001,A',
        ]) {
            const another = prepared();
            another.ingest(frame(body), T + 1000, T + 1000);
            const unknown = another
                .contacts(T + 1000)
                .map((c) => gradeRadarContact(c, own, T + 1000)!)
                .filter(Boolean);
            expect(unknown.some((c) => c.assessment.rangeOnly)).toBe(true);
            for (const c of unknown.filter((c) => c.assessment.rangeOnly)) {
                expect(c.assessment.alarm).toBe(false);
                expect(c.opening).toBe(false);
                expect(c.settled).toBe(false);
            }
            expect(worstRadarCandidates([danger, ...unknown])[0].assessment.alarm).toBe(true);
        }
    });
    it('unknown evidence outranks a safe opening observation for clearing purposes', () => {
        const f = prepared(),
            base = gradeRadarContact(f.contacts(T)[0], f.ownshipSnapshot(), T)!;
        const safe = {
            ...base,
            assessment: { ...base.assessment, risk: 'SAFE' as const, alarm: false, closeQuarters: false },
            opening: true,
        };
        const unknown = {
            ...base,
            assessment: {
                ...base.assessment,
                risk: 'NONE' as const,
                alarm: false,
                closeQuarters: false,
                rangeOnly: true,
                cpaNm: null,
                tcpaMin: null,
            },
            opening: false,
        };
        expect(worstRadarCandidates([safe, unknown])[0].assessment.rangeOnly).toBe(true);
    });
});
describe('AIS/radar presentation association never invents identity', () => {
    const aisFor = (f: RadarFeed): RadarAisMatchEvidence => {
        const c = f.contacts(T)[0];
        return {
            mmsi: 123456789,
            ...c.position!,
            sogKn: c.motion!.sogKn,
            cogDeg: c.motion!.cogTrueDeg,
            at: T,
            source: 'local',
        };
    };
    it('groups only one unique coherent position and vector match, including dateline', () => {
        const f = prepared(),
            contacts = f.contacts(T),
            a = aisFor(f);
        expect(matchRadarToAis(contacts, [a], T).get(contacts[0].contactKey)).toBe(a.mmsi);
        expect(
            matchRadarToAis(
                [{ ...contacts[0], position: { ...contacts[0].position!, lon: 179.9999 } }],
                [{ ...a, lon: -179.9999 }],
                T,
            ).size,
        ).toBe(1);
        expect(contacts[0].source).toBe('radar');
        expect('mmsi' in contacts[0]).toBe(false);
    });
    it('refuses proximity/name alone, stale clocks, inconsistent vectors and app positions', () => {
        const f = prepared(),
            contacts = f.contacts(T),
            a = aisFor(f);
        for (const patch of [
            { sogKn: null },
            { cogDeg: 0 },
            { at: T - 6001 },
            { lat: a.lat + 1 },
            { source: 'app' as 'local' },
            { mmsi: 970123456 },
        ])
            expect(matchRadarToAis(contacts, [{ ...a, ...patch }], T).size).toBe(0);
        expect(matchRadarToAis([{ ...contacts[0], motion: null }], [a], T).size).toBe(0);
        expect(matchRadarToAis(contacts, [a], T + 16000).size).toBe(0);
    });
    it('leaves both sides separate when either direction of the association is ambiguous', () => {
        const f = prepared(),
            contacts = f.contacts(T),
            a = aisFor(f);
        expect(matchRadarToAis(contacts, [a, { ...a, mmsi: 234567890 }], T).size).toBe(0);
        expect(
            matchRadarToAis([...contacts, { ...contacts[0], contactKey: contacts[0].contactKey + 'other' }], [a], T)
                .size,
        ).toBe(0);
    });
    it('does not merge conflicting independent plotted positions into an AIS vessel', () => {
        const f = prepared(),
            contacts = f.contacts(T),
            a = aisFor(f);
        expect(
            matchRadarToAis([...contacts, { ...contacts[0], motion: null, position: { lat: 1, lon: 0 } }], [a], T).size,
        ).toBe(0);
    });
});
