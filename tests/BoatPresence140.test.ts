import { describe, expect, it, vi } from 'vitest';
import {
    BoatPresenceController,
    parsePresenceConfig,
    parsePresencePoints,
    type PresenceContext,
} from '../services/presence/BoatPresenceController';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function setup() {
    let wall = Date.parse('2026-10-17T01:00:00Z'),
        mono = 1000,
        fixAt = wall;
    let context: PresenceContext = { key: 'a|boat', identity: 'a', userId: id(1), vesselId: id(2), allowed: true };
    let config = {
        vesselId: id(2),
        vesselName: 'Fictional yacht',
        tier: 'off',
        revision: id(3),
        sequence: 1,
        readerRevision: id(4),
        publisherRevision: id(5),
        publisherActive: false,
        serverTime: new Date(wall).toISOString(),
    };
    const point = () => ({
        id: 'a'.repeat(64),
        label: 'Thalassa boat',
        tier: 'nearby',
        latitude: -27.125,
        longitude: 153.175,
        bucketAt: new Date(wall - 360000).toISOString(),
        validUntil: new Date(wall + 30000).toISOString(),
    });
    let blocked: ((action: string, input: Record<string, unknown>) => Promise<unknown> | undefined) | undefined;
    const request = vi.fn(async (action: string, input: Record<string, unknown>) => {
        const other = blocked?.(action, input);
        if (other) return other;
        if (action === 'configure')
            config = {
                ...config,
                tier: String(input.tier),
                revision: id(30),
                sequence: 2,
                readerRevision: id(40),
                publisherRevision: id(50),
            };
        if (action === 'begin')
            config = {
                ...config,
                ...(input.kind === 'reader'
                    ? { readerRevision: id(41) }
                    : { publisherRevision: id(51), publisherActive: true }),
            };
        if (action === 'nearby')
            return {
                points: [point()],
                serverTime: new Date(wall).toISOString(),
                validUntil: new Date(wall + 30000).toISOString(),
            };
        if (action === 'friends') return { friends: [] };
        return { ...config, serverTime: new Date(wall).toISOString() };
    });
    const fix = vi.fn(() => ({ latitude: -27.12, longitude: 153.15, timestamp: fixAt }));
    const controller = new BoatPresenceController({
        context: () => ({ ...context }),
        request,
        fix,
        uuid: () => id(60),
        wall: () => wall,
        monotonic: () => mono,
    });
    return {
        controller,
        request,
        fix,
        point,
        config: () => config,
        setConfig: (v: Partial<typeof config>) => {
            config = { ...config, ...v };
        },
        setContext: (c: Partial<PresenceContext>) => {
            context = { ...context, ...c };
            controller.retire('Context changed');
        },
        advance: (ms: number, fresh = true) => {
            wall += ms;
            mono += ms;
            if (fresh) fixAt = wall;
        },
        block: (fn: typeof blocked) => {
            blocked = fn;
        },
        setFixAt: (x: number) => {
            fixAt = x;
        },
        wall: () => wall,
    };
}
describe('presence foreground/session privacy', () => {
    it('starts OFF without transport or GPS, and load does not publish', async () => {
        const h = setup();
        expect(h.request).not.toHaveBeenCalled();
        expect(h.fix).not.toHaveBeenCalled();
        await h.controller.load();
        expect(h.request.mock.calls.map((x) => x[0])).toEqual(['state']);
        expect(h.controller.snapshot().publishing).toBe(false);
    });
    it('saving an audience never starts a session', async () => {
        const h = setup();
        await h.controller.load();
        await h.controller.configure('nearby');
        expect(h.request.mock.calls.map((x) => x[0])).toEqual(['state', 'configure']);
        expect(h.controller.snapshot()).toMatchObject({ viewing: false, publishing: false, points: [] });
    });
    it('viewing when consent is OFF records only the original private GPS context', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        const fix = h.request.mock.calls.find((x) => x[0] === 'fix')![1];
        expect(fix).toEqual({
            revision: id(3),
            readerNonce: id(60),
            latitude: -27.12,
            longitude: 153.15,
            observedAt: new Date(h.wall()).toISOString(),
        });
        expect(h.controller.snapshot()).toMatchObject({ viewing: true, publishing: false });
        expect(h.controller.snapshot().points).toHaveLength(1);
    });
    it('requires foreground and explicit saved audience before publication', async () => {
        const h = setup();
        await expect(h.controller.setSession('publisher', true)).rejects.toThrow('Open Obs');
        h.controller.setForeground(true);
        await expect(h.controller.setSession('publisher', true)).rejects.toThrow('audience');
        expect(h.request.mock.calls.some((x) => x[0] === 'begin')).toBe(false);
    });
    it('never resends one cached GPS timestamp to extend a lease', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.advance(20000, false);
        await h.controller.tick();
        expect(h.request.mock.calls.filter((x) => x[0] === 'fix')).toHaveLength(1);
        h.advance(25000, false);
        h.controller.expire();
        expect(h.controller.snapshot()).toMatchObject({ viewing: false, points: [] });
    });
    it('fresh original fixes extend a foreground lease', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.advance(20000);
        await h.controller.tick();
        h.advance(26000, false);
        h.controller.expire();
        expect(h.controller.snapshot().viewing).toBe(true);
        expect(h.request.mock.calls.filter((x) => x[0] === 'fix')).toHaveLength(2);
    });
    it.each([-31000, 6000])('does not send stale/future source clocks %d', async (delta) => {
        const h = setup();
        h.setFixAt(h.wall() + delta);
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        expect(h.request.mock.calls.some((x) => x[0] === 'fix')).toBe(false);
        expect(h.controller.snapshot().points).toEqual([]);
    });
    it('does not automatically resume after foreground returns', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.controller.setForeground(false);
        const count = h.request.mock.calls.length;
        h.controller.setForeground(true);
        h.advance(20000);
        await h.controller.tick();
        expect(h.request).toHaveBeenCalledTimes(count);
        expect(h.controller.snapshot()).toMatchObject({ viewing: false, publishing: false, points: [] });
    });
    it('immediately retires points/friends/config on account A-B-A', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.setContext({ userId: id(9), identity: 'b', key: 'b|boat' });
        expect(h.controller.snapshot()).toMatchObject({
            config: null,
            points: [],
            friends: [],
            viewing: false,
            publishing: false,
        });
        h.setContext({ userId: id(1), identity: 'a2', key: 'a2|boat' });
        await h.controller.tick();
        expect(h.controller.snapshot().points).toEqual([]);
        expect(h.request.mock.calls.filter((x) => x[0] === 'end')).toHaveLength(0);
    });
    it('stops old boat session with its captured revision, never new geometry', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.setContext({ key: 'a|otherboat', vesselId: id(99) });
        expect(h.request.mock.calls.find((x) => x[0] === 'end')?.[1]).toEqual({
            revision: id(3),
            sessionRevision: id(4),
            kind: 'reader',
            nonce: id(60),
        });
    });
    it('offline retirement has no deferred network queue', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.setContext({ allowed: false });
        const count = h.request.mock.calls.length;
        h.setContext({ allowed: true });
        h.advance(20000);
        await h.controller.tick();
        expect(h.request).toHaveBeenCalledTimes(count);
        expect(h.controller.snapshot().viewing).toBe(false);
    });
    it('withdrawal overtakes an in-flight begin using its known nonce', async () => {
        const h = setup();
        await h.controller.load();
        h.controller.setForeground(true);
        let resolve!: (v: unknown) => void;
        h.block((a) =>
            a === 'begin'
                ? new Promise((r) => {
                      resolve = r;
                  })
                : undefined,
        );
        const starting = h.controller.setSession('reader', true);
        await Promise.resolve();
        await h.controller.setSession('reader', false);
        expect(h.request.mock.calls.find((x) => x[0] === 'end')?.[1]).toMatchObject({
            nonce: id(60),
            sessionRevision: id(4),
        });
        resolve(h.config());
        await starting;
        expect(h.controller.snapshot()).toMatchObject({ points: [], viewing: false });
        expect(h.request.mock.calls.some((x) => x[0] === 'fix')).toBe(false);
    });
    it('late list response cannot repopulate after consent withdrawal', async () => {
        const h = setup();
        h.controller.setForeground(true);
        let resolve!: (v: unknown) => void;
        h.block((a) =>
            a === 'nearby'
                ? new Promise((r) => {
                      resolve = r;
                  })
                : undefined,
        );
        const start = h.controller.setSession('reader', true);
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        h.controller.retire();
        resolve({
            points: [h.point()],
            serverTime: new Date(h.wall()).toISOString(),
            validUntil: new Date(h.wall() + 30000).toISOString(),
        });
        await expect(start).rejects.toThrow('context');
        expect(h.controller.snapshot().points).toEqual([]);
    });
    it('removes snapshots after30 seconds without a clock rollback extending them', async () => {
        const h = setup();
        h.controller.setForeground(true);
        await h.controller.setSession('reader', true);
        h.advance(30001, false);
        h.controller.expire();
        expect(h.controller.snapshot().viewing).toBe(true);
        expect(h.controller.snapshot().points).toEqual([]);
    });
    it('subtracts slow request latency from every response lease', async () => {
        const h = setup();
        h.controller.setForeground(true);
        h.block((a) => {
            if (a !== 'nearby') return;
            const raw = {
                points: [h.point()],
                serverTime: new Date(h.wall()).toISOString(),
                validUntil: new Date(h.wall() + 30000).toISOString(),
            };
            h.advance(31000, false);
            return Promise.resolve(raw);
        });
        await h.controller.setSession('reader', true);
        expect(h.controller.snapshot().points).toEqual([]);
    });
    it('does not adopt a server active vessel different from local intent', async () => {
        const h = setup();
        h.setConfig({ vesselId: id(99) });
        await expect(h.controller.load()).rejects.toThrow('syncing');
        expect(h.controller.snapshot().config).toBe(null);
    });
});
describe('bounded delayed response contract', () => {
    it('strips unknown server fields rather than spreading raw identities', () => {
        const h = setup();
        const v = {
            points: [{ ...h.point(), ownerId: id(1), sourceLatitude: -27.123456 }],
            serverTime: new Date(h.wall()).toISOString(),
            validUntil: new Date(h.wall() + 30000).toISOString(),
        };
        expect(Object.keys(parsePresencePoints(v).points[0]).sort()).toEqual(
            ['id', 'label', 'tier', 'latitude', 'longitude', 'bucketAt', 'validUntil'].sort(),
        );
    });
    it.each([
        { latitude: -27.123456 },
        { longitude: 153.123456 },
        { latitude: NaN },
        { longitude: 181 },
        { tier: 'off' },
        { id: id(1) },
        { label: 'x'.repeat(121) },
        { bucketAt: 'not-a-clock' },
        { bucketAt: '2026-10-17T00:59:59Z' },
        { validUntil: '2026-10-17T01:00:31Z' },
    ])('rejects unsafe point %j', (patch) => {
        const h = setup();
        expect(() =>
            parsePresencePoints({
                points: [{ ...h.point(), ...patch }],
                serverTime: new Date(h.wall()).toISOString(),
                validUntil: new Date(h.wall() + 30000).toISOString(),
            }),
        ).toThrow();
    });
    it('refuses100+points and duplicate handles', () => {
        const h = setup(),
            base = {
                serverTime: new Date(h.wall()).toISOString(),
                validUntil: new Date(h.wall() + 30000).toISOString(),
            };
        expect(() => parsePresencePoints({ ...base, points: Array(101).fill(h.point()) })).toThrow();
        expect(() => parsePresencePoints({ ...base, points: [h.point(), h.point()] })).toThrow();
    });
    it('refuses oversized response leases and unsafe sequence numbers', () => {
        const h = setup();
        expect(() =>
            parsePresencePoints({
                points: [],
                serverTime: new Date(h.wall()).toISOString(),
                validUntil: new Date(h.wall() + 30001).toISOString(),
            }),
        ).toThrow();
        expect(() => parsePresenceConfig({ ...h.config(), sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    });
});
