import { describe, expect, it } from 'vitest';
import { SignalKReadState, signalKReadPath } from '../utils/signalkProtocol';
const now = Date.parse('2026-10-16T00:00:00Z'),
    self = 'urn:mrn:imo:mmsi:000000001';
const delta = (path: string, value: unknown, at = now, source = 'test.1') => ({
    context: `vessels.${self}`,
    updates: [{ $source: source, timestamp: new Date(at).toISOString(), values: [{ path, value }] }],
});
describe('bounded self Signal K read protocol', () => {
    it('builds own engine branches even when a legitimate identifier names an inherited object method', () => {
        const state = new SignalKReadState(self);
        state.ingestDelta(delta('propulsion.toString.revolutions', 20), now);
        expect(state.document()).toMatchObject({ propulsion: { toString: { revolutions: { value: 20 } } } });
        expect(Object.prototype.toString).not.toHaveProperty('revolutions');
    });
    it('keeps original clocks across unrelated updates and clones values', () => {
        const state = new SignalKReadState(self);
        state.ingestDelta(delta('navigation.headingTrue', Math.PI, now - 5000), now);
        state.ingestDelta(delta('navigation.position', { latitude: 0, longitude: 0 }), now);
        const doc = state.document();
        expect(doc).toMatchObject({
            navigation: {
                headingTrue: { value: Math.PI, timestamp: new Date(now - 5000).toISOString() },
                position: { value: { latitude: 0, longitude: 0 } },
            },
        });
        (doc.navigation as Record<string, unknown>).headingTrue = null;
        expect(state.document()).toMatchObject({ navigation: { headingTrue: { value: Math.PI } } });
    });
    it('refuses foreign context, undated/future/older leaves, wrong units and impossible values', () => {
        const state = new SignalKReadState(self);
        const foreign = delta('navigation.speedOverGround', 3);
        foreign.context = 'vessels.urn:other:boat';
        expect(state.ingestDelta(foreign, now).changed).toBe(false);
        expect(state.ingestDelta(delta('navigation.speedOverGround', 999), now).changed).toBe(false);
        expect(state.ingestDelta(delta('navigation.speedOverGround', 2, now + 2000), now).changed).toBe(false);
        expect(
            state.ingestDelta(
                {
                    context: `vessels.${self}`,
                    updates: [{ values: [{ path: 'navigation.speedOverGround', value: 2 }] }],
                },
                now,
            ).changed,
        ).toBe(false);
        expect(
            state.ingestSelfDocument(
                {
                    uuid: self,
                    navigation: {
                        speedOverGround: {
                            value: 3,
                            timestamp: new Date(now).toISOString(),
                            $source: 'test',
                            meta: { units: 'kn' },
                        },
                    },
                },
                now,
            ),
        ).toBe(false);
        state.ingestDelta(delta('navigation.speedOverGround', 3), now);
        state.ingestDelta(delta('navigation.speedOverGround', 2, now - 1), now);
        expect(state.document()).toMatchObject({ navigation: { speedOverGround: { value: 3 } } });
    });
    it('retains source-dated null clearing and ignores repeated timestamps', () => {
        const state = new SignalKReadState(self);
        state.ingestDelta(delta('navigation.headingTrue', 1, now - 1), now);
        state.ingestDelta(delta('navigation.headingTrue', null), now);
        state.ingestDelta(delta('navigation.headingTrue', 3), now);
        expect(state.document()).toMatchObject({ navigation: { headingTrue: { value: null } } });
    });
    it('never walks command paths/prototypes or admits more than eight engines', () => {
        const state = new SignalKReadState(self);
        for (const p of [
            'steering.autopilot.state',
            'navigation.courseGreatCircle.nextPoint',
            'propulsion.__proto__.revolutions',
            'propulsion.constructor.revolutions',
        ])
            expect(signalKReadPath(p)).toBe(false);
        for (let i = 0; i < 9; i++) state.ingestDelta(delta(`propulsion.engine${i}.revolutions`, 20), now);
        expect(Object.keys(state.document().propulsion as object)).toHaveLength(8);
        expect({}).not.toHaveProperty('revolutions');
    });
    it('requires exact self identity and explicit leaf clocks in REST bootstrap', () => {
        const state = new SignalKReadState(self);
        const d = {
            uuid: self,
            navigation: { timestamp: new Date(now).toISOString(), speedOverGround: { value: 3, $source: 'test' } },
        };
        expect(state.ingestSelfDocument(d, now)).toBe(false);
        expect(state.ingestSelfDocument({ ...d, uuid: 'urn:other:boat' }, now)).toBe(false);
        expect(state.document()).toEqual({ uuid: self });
    });
    it('separates notification providers, dates clears, deduplicates replay and bounds messages', () => {
        const state = new SignalKReadState(self, now),
            notice = { message: 'Alarm', state: 'alarm', method: ['visual', 'sound'] };
        const first = state.ingestDelta(delta('notifications.depth', notice), now);
        expect(first.notices[0].fresh).toBe(false); // initial snapshot is never a new siren
        expect(state.ingestDelta(delta('notifications.depth', notice), now).notices).toHaveLength(0);
        expect(state.ingestDelta(delta('notifications.depth', notice, now + 1), now + 1).notices[0].fresh).toBe(true);
        state.ingestDelta(delta('notifications.depth', notice, now, 'second'), now);
        state.ingestDelta(delta('notifications.depth', null, now + 2), now + 2);
        expect(state.notifications(now + 2)).toHaveLength(1);
        expect(state.notifications(now + 2)[0].source).toBe('second');
        state.ingestDelta(delta('notifications.depth', null, now - 1, 'second'), now);
        expect(state.notifications(now)).toHaveLength(1);
        state.ingestDelta(delta('notifications.long', { ...notice, message: 'A'.repeat(300) }), now);
        expect(state.notifications(now).find((n) => n.path.endsWith('long'))!.message).toHaveLength(160);
    });
    it('caps notification source/path clocks including cleared tombstones; clear retires everything', () => {
        const state = new SignalKReadState(self);
        for (let i = 0; i < 80; i++)
            state.ingestDelta(delta(`notifications.n${i}`, { message: 'test', state: 'alert' }), now);
        expect(state.notifications(now)).toHaveLength(64);
        state.clear();
        expect(state.notifications(now)).toEqual([]);
        expect(state.document()).toEqual({ uuid: self });
    });
});
