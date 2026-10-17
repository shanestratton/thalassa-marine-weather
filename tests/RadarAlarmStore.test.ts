import { describe, expect, it } from 'vitest';
import { RadarAlarmState } from '../services/radar/radarAlarmStore';
import type { AuthIdentityScope } from '../services/authIdentityScope';
import { RadarFeed } from '../utils/radarFeed';
import { gradeRadarContact } from '../utils/radarCollision';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function setup() {
    let owner: AuthIdentityScope = { key: 'user:generated', userId: 'generated', generation: 1 },
        now = T;
    let identity = () => {};
    const state = new RadarAlarmState({
        scope: () => owner,
        current: (o) => o === owner,
        now: () => now,
        epoch: () => 'a'.repeat(32),
        identityChanged: (fn) => {
            identity = fn;
            return () => {};
        },
    });
    const feed = new RadarFeed('gateway:generated');
    for (const body of [
        'GPRMC,120000,A,0000.000,N,00000.000,E,5,0,020126,,,A',
        'HEHDT,0,T',
        'RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A',
    ])
        feed.ingest(frame(body), T, T);
    const candidate = gradeRadarContact(feed.contacts(T)[0], feed.ownshipSnapshot(), T)!;
    return {
        state,
        candidate,
        advance: (at: number) => {
            now = at;
        },
        switchWithoutCallback: () => {
            owner = { key: 'user:other', userId: 'other', generation: 2 };
        },
        signalIdentity: () => identity(),
    };
}
describe('private radar alarm state', () => {
    it('starts disabled, requires explicit arming, and exact source/episode/severity acknowledgement', () => {
        const s = setup();
        const pass = () => s.state.update([s.candidate], () => 'moving', { feeds: 1, qualifiedFeeds: 1 }, T);
        pass();
        expect(s.state.get().cards).toHaveLength(0);
        s.state.setArmed(true);
        pass();
        const card = s.state.get().cards[0];
        expect(card.assessment.alarm).toBe(true);
        expect(s.state.acknowledge({ ...card, kind: 'radar-close-quarters' })).toBe(false);
        expect(s.state.acknowledge({ ...card, kind: 'radar-collision' })).toBe(true);
        expect(s.state.get().cards).toHaveLength(0);
        s.advance(T + 30 * 60000 + 1);
        s.state.update([], () => 'no-fix', { feeds: 0, qualifiedFeeds: 0 });
        expect(s.state.get().cards[0]).toMatchObject({ cleared: 'lost' });
        s.state.setArmed(false);
        expect(s.state.get()).toMatchObject({ armed: false, cards: [] });
        s.state.dispose();
    });
    it('hides prior-owner cards before asynchronous identity callbacks and rejects their actions', () => {
        const s = setup();
        s.state.setArmed(true);
        s.state.update([s.candidate], () => 'moving', { feeds: 1, qualifiedFeeds: 1 });
        const old = s.state.get().cards[0];
        s.switchWithoutCallback();
        expect(s.state.get()).toMatchObject({ armed: false, cards: [] });
        expect(s.state.acknowledge({ ...old, kind: 'radar-collision' })).toBe(false);
        s.signalIdentity();
        s.state.setArmed(true);
        expect(s.state.get().cards).toHaveLength(0);
        s.state.dispose();
    });
    it('keeps an unresolved original-clock card after its physical feed disappears', () => {
        const s = setup();
        s.state.setArmed(true);
        s.state.update([s.candidate], () => 'moving', { feeds: 1, qualifiedFeeds: 1 });
        s.advance(T + 16000);
        s.state.update([], () => 'no-fix', { feeds: 0, qualifiedFeeds: 0 });
        expect(s.state.get().cards[0]).toMatchObject({ sourceAt: T, reportAt: T, lost: { reason: 'no-fix' } });
        expect(s.state.get().cards[0].cleared).toBeUndefined();
        expect(Object.isFrozen(s.state.get().cards[0].assessment)).toBe(true);
        s.state.dispose();
    });
});
