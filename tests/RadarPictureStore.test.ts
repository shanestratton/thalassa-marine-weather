import { describe, expect, it, vi } from 'vitest';
import { RadarPictureStore } from '../services/radar/radarStore';
import type { AuthIdentityScope } from '../services/authIdentityScope';
const at = Date.UTC(2026, 0, 2, 0, 0, 5, 123);
const frame = (body: string) =>
    '$' +
    body +
    '*' +
    [...body]
        .reduce((n, c) => n ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0');
const tll = frame('RATLL,01,5030.000,N,00115.000,W,Generated echo,000005.123,T,');
function harness() {
    let owner: AuthIdentityScope = { key: 'user:one', userId: 'one', generation: 1 };
    let now = at;
    let serial = 0;
    let change: () => void = () => undefined;
    const cancel = vi.fn();
    const store = new RadarPictureStore({
        scope: () => owner,
        current: (s) => s.key === owner.key && s.generation === owner.generation,
        identityChanged: (fn) => {
            change = fn;
            return () => undefined;
        },
        now: () => now,
        id: () => String(++serial).padStart(32, '0'),
        schedule: () => cancel,
    });
    return {
        store,
        cancel,
        time: (n: number) => {
            now = n;
        },
        switch: (notify = true) => {
            owner = { key: 'user:two', userId: 'two', generation: 2 };
            if (notify) change();
        },
    };
}
describe('private radar gateway picture', () => {
    it('keeps stable immutable snapshots and original observation times without persistence', () => {
        const h = harness(),
            s = h.store.openGateway()!;
        expect(h.store.ingest(s, tll, at)).toBe(true);
        const snapshot = h.store.getSnapshot();
        expect(h.store.getSnapshot()).toBe(snapshot);
        expect(snapshot.contacts[0]).toMatchObject({
            at,
            receivedAt: at,
            source: 'radar',
            position: { lat: 50.5, lon: -1.25 },
            motion: null,
        });
        expect(Object.isFrozen(snapshot.contacts[0].position)).toBe(true);
        h.time(at + 16_000);
        h.store.tick();
        expect(h.store.getSnapshot().contacts[0]).toMatchObject({ at, receivedAt: at, fresh: false, motion: null });
        expect(h.store.getSnapshot().feeds[0].lastTargetAt).toBe(at);
        h.store.dispose();
    });
    it('retires old async source tokens without letting them overwrite or retire a replacement', () => {
        const h = harness(),
            old = h.store.openGateway()!,
            next = h.store.openGateway()!;
        expect(next.feedId).not.toBe(old.feedId);
        expect(h.store.ingest(old, tll, at)).toBe(false);
        expect(h.store.ingest(next, tll, at)).toBe(true);
        h.store.retire(old);
        expect(h.store.getSnapshot().contacts).toHaveLength(1);
        h.store.retire(next);
        expect(h.store.getSnapshot().contacts).toHaveLength(0);
        expect(h.cancel).toHaveBeenCalled();
        h.store.dispose();
    });
    it('synchronously hides prior account data and rejects every delayed old-session frame', () => {
        const h = harness(),
            s = h.store.openGateway()!;
        h.store.ingest(s, tll, at);
        h.switch();
        expect(h.store.getSnapshot().contacts).toEqual([]);
        expect(h.store.ingest(s, tll, at)).toBe(false);
        const next = h.store.openGateway()!;
        expect(h.store.ingest(next, tll, at)).toBe(true);
        h.store.dispose();
    });
    it('fails closed even before its account-transition listener is delivered', () => {
        const h = harness(),
            session = h.store.openGateway()!;
        h.store.ingest(session, tll, at);
        h.switch(false);
        expect(h.store.getSnapshot().contacts).toEqual([]);
        expect(h.store.ingest(session, tll, at)).toBe(false);
        h.store.tick();
        expect(h.store.getSnapshot().feeds).toEqual([]);
        h.store.dispose();
    });
    it('does not restamp stale or malformed input as a live radar observation', () => {
        const h = harness(),
            s = h.store.openGateway()!;
        h.time(at + 16_000);
        expect(h.store.ingest(s, tll, at)).toBe(false);
        expect(h.store.ingest(s, '$RATLL,unqualified', at + 16_000)).toBe(false);
        expect(h.store.getSnapshot().feeds[0].lastTargetAt).toBeNull();
        h.store.dispose();
    });
    it('drops expired picture geometry while leaving alarm resolution to the alarm owner', () => {
        const h = harness(),
            s = h.store.openGateway()!;
        h.store.ingest(s, tll, at);
        h.time(at + 121_000);
        h.store.tick();
        expect(h.store.getSnapshot().contacts).toEqual([]);
        h.store.dispose();
    });
});
