import { describe, expect, it } from 'vitest';
import { RadarEncounters, RADAR_ENCOUNTER_CAP } from '../utils/radarEncounters';
import { RadarFeed } from '../utils/radarFeed';
import { gradeRadarContact, type RadarCollisionCandidate } from '../utils/radarCollision';
const T = Date.UTC(2026, 0, 2, 12),
    epoch = 'a'.repeat(32);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function danger(): RadarCollisionCandidate {
    const f = new RadarFeed('pi:' + 'b'.repeat(32));
    for (const body of [
        'GPRMC,120000,A,0000.000,N,00000.000,E,5,0,020126,,,A',
        'HEHDT,0,T',
        'RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A',
    ])
        f.ingest(frame(body), T, T);
    return gradeRadarContact(f.contacts(T)[0], f.ownshipSnapshot(), T)!;
}
const fresh = (c: RadarCollisionCandidate, now: number) => ({
    ...c,
    sourceAt: now,
    contact: { ...c.contact, at: now, receivedAt: now },
});
const opening = (c: RadarCollisionCandidate, now: number) => ({
    ...fresh(c, now),
    assessment: { ...c.assessment, alarm: false, closeQuarters: false, risk: 'SAFE' as const, tcpaMin: -1, rangeNm: 1 },
    opening: true,
    settled: false,
});
describe('bounded source-specific radar collision episodes', () => {
    it('uses actual qualified125 danger and source+episode+severity scoped acknowledgement', () => {
        const m = new RadarEncounters(epoch),
            c = danger();
        expect(c.assessment.alarm).toBe(true);
        m.update([c], () => 'moving', T);
        const card = m.cards(T)[0];
        expect(card.episodeId).toBe(epoch + ':1');
        expect(card.sourceAt).toBe(T);
        expect('mmsi' in card).toBe(false);
        expect(m.acknowledge({ contactKey: '123456789', episodeId: card.episodeId, kind: 'radar-collision' }, T)).toBe(
            false,
        );
        expect(
            m.acknowledge({ contactKey: card.contactKey, episodeId: epoch + ':2', kind: 'radar-collision' }, T),
        ).toBe(false);
        expect(m.acknowledge({ ...card, kind: 'radar-collision' }, T)).toBe(true);
        expect(m.sounding(T + 1)).toHaveLength(0);
        expect(m.sounding(T + 30 * 60000 + 1)).toHaveLength(1);
    });
    it('an old danger ack cannot silence a close-quarters escalation of that same contact', () => {
        const m = new RadarEncounters(epoch),
            c = danger();
        m.update([c], () => 'moving', T);
        const old = m.cards(T)[0];
        m.acknowledge({ ...old, kind: 'radar-collision' }, T);
        const close = { ...fresh(c, T + 1000), assessment: { ...c.assessment, closeQuarters: true } };
        m.update([close], () => 'moving', T + 1000);
        expect(m.cards(T + 1000)[0]).toMatchObject({
            episodeId: old.episodeId,
            raisedAt: T + 1000,
            closeQuarters: true,
        });
        expect(m.acknowledge({ ...old, kind: 'radar-collision' }, T + 1000)).toBe(false);
        expect(m.sounding(T + 1000)).toHaveLength(1);
        expect(m.acknowledge({ ...old, kind: 'radar-close-quarters' }, T + 1000)).toBe(true);
        m.update([fresh(c, T + 2000)], () => 'moving', T + 2000);
        expect(m.sounding(T + 2000)).toHaveLength(0);
    });
    it('requires fresh held clear evidence, and reapproach receives a different episode', () => {
        const m = new RadarEncounters(epoch),
            c = danger();
        m.update([c], () => 'moving', T);
        const old = m.cards(T)[0];
        for (const offset of [1000, 16000, 31000]) m.update([opening(c, T + offset)], () => 'moving', T + offset);
        expect(m.size).toBe(0);
        expect(m.cards(T + 31000)[0].cleared).toBe('passed');
        m.update([fresh(c, T + 32000)], () => 'moving', T + 32000);
        expect(m.cards(T + 32000)).toHaveLength(1);
        expect(m.cards(T + 32000)[0].episodeId).not.toBe(old.episodeId);
        expect(m.acknowledge({ ...old, kind: 'radar-collision' }, T + 32000)).toBe(false);
    });
    it('fresh report with expired original dependencies cannot fire or clear an encounter', () => {
        const m = new RadarEncounters(epoch),
            c = danger();
        m.update([{ ...c, sourceAt: T - 15001 }], () => 'moving', T);
        expect(m.size).toBe(0);
        m.update([c], () => 'moving', T);
        for (const offset of [1000, 16000, 31000])
            m.update([{ ...opening(c, T + offset), sourceAt: T - 15001 }], () => 'moving', T + offset);
        expect(m.size).toBe(1);
        expect(m.cards(T + 31000)[0]).toMatchObject({ sourceAt: T, lost: { reason: 'target-motion-unknown' } });
    });
    it('loss holds an unresolved alarm through the common CPA grace period and never says passed', () => {
        const m = new RadarEncounters(epoch),
            c = danger();
        m.update([c], () => 'moving', T);
        m.update([], () => 'no-fix', T + 16000);
        expect(m.sounding(T + 16000)[0].lost!.reason).toBe('no-fix');
        m.update([], () => 'no-fix', T + 16 * 60000 + 1);
        expect(m.sounding(T + 16 * 60000 + 1)).toHaveLength(0);
        expect(m.cards(T + 16 * 60000 + 1)[0]).toMatchObject({ cleared: 'lost', lost: { reason: 'no-fix' } });
    });
    it('caps held identities without evicting danger, and exposes acknowledged-but-unresolved overflow', () => {
        const m = new RadarEncounters(epoch),
            base = danger();
        const candidates = Array.from({ length: RADAR_ENCOUNTER_CAP + 1 }, (_, n) => {
            const contactKey = base.contactKey.replace(/:1$/, ':' + n);
            return { ...base, contactKey, contact: { ...base.contact, contactKey, targetNumber: n } };
        });
        m.update(candidates, () => 'moving', T);
        expect(m.size).toBe(RADAR_ENCOUNTER_CAP);
        expect(m.sounding(T)).toHaveLength(RADAR_ENCOUNTER_CAP);
        expect(m.capacity()).toEqual({ sourceAt: T, acknowledged: false });
        expect(m.acknowledgeCapacity(T + 1)).toBe(false);
        expect(m.acknowledgeCapacity(T)).toBe(true);
        expect(m.capacity()!.acknowledged).toBe(true);
        m.update([fresh(candidates.at(-1)!, T + 1000)], () => 'moving', T + 1000);
        expect(m.size).toBe(RADAR_ENCOUNTER_CAP);
        expect(m.capacity()).toEqual({ sourceAt: T + 1000, acknowledged: false });
    });
});
