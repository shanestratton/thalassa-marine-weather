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

function piPicture(
    contact: ReturnType<RadarPictureStore['getSnapshot']>['contacts'][number],
    isCurrent = () => true,
    servedAt = at,
) {
    const feedId = 'pi:' + 'a'.repeat(32);
    return {
        configured: true,
        connected: true,
        overloaded: false,
        feedId,
        servedAt,
        lastFrameAt: at,
        lastTargetAt: at,
        ownship: { feedId, position: null, heading: null, motion: null },
        contacts: [
            {
                ...contact,
                position: contact.position ? { ...contact.position } : null,
                feedId,
                contactKey: `radar:${feedId}:RA:1`,
            },
        ],
        isCurrent,
    };
}
describe('independent paired Pi radar picture ownership', () => {
    it('retiring either source leaves the other source intact', () => {
        const h = harness(),
            gateway = h.store.openGateway()!;
        h.store.ingest(gateway, tll, at);
        const picture = piPicture(h.store.getSnapshot().contacts[0]);
        const pi = h.store.acceptPi(picture)!;
        expect(h.store.getSnapshot().contacts).toHaveLength(2);
        h.store.retire(gateway);
        expect(h.store.getSnapshot().contacts).toHaveLength(1);
        expect(h.store.getSnapshot().feeds[0].source).toBe('pi');
        const replacement = h.store.openGateway()!;
        h.store.ingest(replacement, tll, at);
        h.store.retirePi(pi);
        expect(h.store.getSnapshot().contacts).toHaveLength(1);
        expect(h.store.getSnapshot().feeds[0].source).toBe('gateway');
        h.store.dispose();
    });
    it('hides only old-pair data synchronously and ages without poll-clock restamping', () => {
        const h = harness(),
            gateway = h.store.openGateway()!;
        h.store.ingest(gateway, tll, at);
        let current = true;
        const picture = piPicture(h.store.getSnapshot().contacts[0], () => current);
        h.store.acceptPi(picture);
        const both = h.store.getSnapshot();
        picture.contacts[0].position!.lat = 89;
        expect(both.contacts[1].position!.lat).toBe(50.5);
        h.time(at + 16000);
        h.store.tick();
        expect(h.store.getSnapshot().contacts[1]).toMatchObject({ at, receivedAt: at, fresh: false });
        current = false;
        const remaining = h.store.getSnapshot();
        expect(remaining.contacts).toHaveLength(1);
        expect(remaining.feeds[0].source).toBe('gateway');
        expect(h.store.getSnapshot()).toBe(remaining);
        h.store.dispose();
    });
    it('rejects out-of-order cache packets and old retirement tokens after source rebind', () => {
        const h = harness(),
            g = h.store.openGateway()!;
        h.store.ingest(g, tll, at);
        const first = piPicture(h.store.getSnapshot().contacts[0]);
        const old = h.store.acceptPi(first)!;
        const next = { ...first, feedId: 'pi:' + 'b'.repeat(32), servedAt: at + 1 };
        next.contacts = first.contacts.map((c) => ({
            ...c,
            feedId: next.feedId,
            contactKey: `radar:${next.feedId}:RA:1`,
        }));
        next.ownship = { ...first.ownship, feedId: next.feedId };
        const replacement = h.store.acceptPi(next)!;
        expect(h.store.acceptPi(first)).toBeNull();
        h.store.retirePi(old);
        expect(h.store.getSnapshot().feeds.some((f) => f.feedId === replacement.feedId)).toBe(true);
        h.store.retirePi(replacement);
        expect(h.store.getSnapshot().feeds).toHaveLength(1);
        h.store.dispose();
    });
});
