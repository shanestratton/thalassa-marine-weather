/**
 * The trickle and the skipper claim (build 125, 125-12): a forgotten device
 * stops holding the boat's public page.
 *
 * Shane 2026-10-09, recording and following a route at the marina: "Live share
 * is on, but iPhone/iPad · 7e1a holds the skipper claim (active 32 days ago)".
 * That device no longer existed, nothing ever refreshed its claim, and the
 * only way out was a button on another page. Now:
 *  - the holder heartbeats lastSeenAt while it actually publishes (piggy-backed
 *    on a successful upload, at most once per 30 min, never a write loop);
 *  - a device that is tracking with live share ON takes over a claim whose
 *    holder has shown no sign of life for 6 h, and says so once;
 *  - a holder seen recently keeps it (a live second device is a real conflict);
 *  - a displaced device still finds out and never takes the page back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
    user: { id: 'user-1' } as { id: string } | null,
    settings: { liveTrackShare: true } as Record<string, unknown>,
    queue: [] as Record<string, unknown>[],
    prefs: new Map<string, string>(),
    upserts: [] as Record<string, unknown>[][],
    failUpsert: false,
    /** The account's newest live_track row, as RLS lets the owner read it. */
    newestLive: null as null | { timestamp: string; created_at: string },
    failLiveRead: false,
    liveReads: 0,
    claimWrites: [] as Array<{ expected: unknown; next: Record<string, unknown> }>,
    claimWriteResult: 'written' as 'written' | 'changed' | 'failed',
    /** What the cloud holds when a guarded write finds it changed. */
    cloudClaimOnChange: undefined as unknown,
    onClaimRefresh: undefined as undefined | (() => void),
    toasts: [] as string[],
    dismissed: [] as number[],
}));

vi.mock('../services/supabase', () => {
    const liveBuilder = () => {
        const builder: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'order', 'limit', 'gte']) builder[method] = () => builder;
        builder.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
            mockState.liveReads += 1;
            const result = mockState.failLiveRead
                ? { data: null, error: { message: 'no signal' } }
                : { data: mockState.newestLive ? [mockState.newestLive] : [], error: null };
            return Promise.resolve(result).then(resolve, reject);
        };
        return builder;
    };
    return {
        supabase: {
            from: (table: string) => ({
                upsert: async (rows: Record<string, unknown>[]) => {
                    if (mockState.failUpsert) return { error: { message: 'no signal' } };
                    mockState.upserts.push(rows);
                    return { error: null };
                },
                select: (...args: unknown[]) => {
                    if (table !== 'live_track') throw new Error(`unexpected select on ${table}`);
                    return (liveBuilder().select as (...a: unknown[]) => unknown)(...args);
                },
                delete: () => ({
                    eq: () => ({
                        lt: async () => ({ error: null }),
                        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
                    }),
                }),
            }),
        },
        getCurrentUser: async () => mockState.user,
    };
});

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: mockState.settings }) },
    refreshSkipperClaim: vi.fn(async () => {
        mockState.onClaimRefresh?.();
    }),
    // The guarded cloud write the trickle uses for both the heartbeat and the
    // automatic handover; its real semantics are pinned in
    // tests/stores/settingsStore.skipperClaimWrite.test.ts.
    writeSkipperClaimIfUnchanged: vi.fn(async (expected: unknown, next: Record<string, unknown>) => {
        mockState.claimWrites.push({ expected, next });
        if (mockState.claimWriteResult === 'written') {
            mockState.settings = { ...mockState.settings, skipperDevice: next };
        } else if (mockState.claimWriteResult === 'changed') {
            mockState.settings = { ...mockState.settings, skipperDevice: mockState.cloudClaimOnChange };
        }
        return mockState.claimWriteResult;
    }),
}));

vi.mock('../components/Toast', () => ({
    toast: {
        info: vi.fn((message: string) => {
            mockState.toasts.push(message);
            return 1;
        }),
        dismiss: vi.fn((id: number) => {
            mockState.dismissed.push(id);
        }),
    },
}));

vi.mock('../services/shiplog/OfflineQueue', () => ({
    getOfflineEntries: async () => mockState.queue.slice(),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: mockState.prefs.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            mockState.prefs.set(key, value);
        },
    },
}));

import { noteLiveTrickleHeartbeat, startLiveTrickle, stopLiveTrickle } from '../services/shiplog/LiveTrickle';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getDeviceId,
    hasBeenDisplaced,
    noteDisplacedNotice,
    takeDisplacedNotice,
    type SkipperClaim,
} from '../services/skipperDevice';

const NOW = Date.parse('2026-10-09T06:15:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let pointSeq = 0;
/** A vetted GPS fix one second after the previous one, at the current clock. */
const point = () => {
    pointSeq += 1;
    return {
        id: `p${pointSeq}`,
        voyageId: 'voyage-1',
        timestamp: new Date(Date.now() - 60_000 + pointSeq * 1000).toISOString(),
        latitude: 47.6 + pointSeq * 1e-5, // fictional, far from any one country's waters
        longitude: -122.4,
        speedKts: 5.1,
        courseDeg: 90,
        entryType: 'auto',
        owner_user_id: 'user-1',
    };
};

const flush = async (pred?: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (pred?.()) return;
    }
};
/** Let a tick that is expected to do nothing finish doing it. */
const settle = () => flush(() => false).then(() => undefined);

// Fictional devices (the repo is public).
const deadHolder = (): SkipperClaim => ({
    deviceId: 'dev-fictional-old-install-7e1a',
    deviceName: 'iPhone/iPad · 7e1a',
    claimedAt: ago(32 * DAY),
});
const mine = (extra: Partial<SkipperClaim> = {}): SkipperClaim => ({
    deviceId: getDeviceId(),
    deviceName: 'iPhone · 9f3a',
    claimedAt: ago(3 * DAY),
    ...extra,
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    setAuthIdentityScope('user-1');
    mockState.user = { id: 'user-1' };
    mockState.settings = { liveTrackShare: true };
    mockState.queue = [point()];
    mockState.prefs.clear();
    mockState.upserts = [];
    mockState.failUpsert = false;
    mockState.newestLive = null;
    mockState.failLiveRead = false;
    mockState.liveReads = 0;
    mockState.claimWrites = [];
    mockState.claimWriteResult = 'written';
    mockState.cloudClaimOnChange = undefined;
    mockState.onClaimRefresh = undefined;
    mockState.toasts = [];
    mockState.dismissed = [];
    takeDisplacedNotice();
});

afterEach(async () => {
    await stopLiveTrickle(false);
    vi.useRealTimers();
});

describe('automatic handover of a forgotten claim', () => {
    it('a 32-day-old claim with no heartbeat is taken over while tracking with live share on, said once, and the trickle publishes', async () => {
        const dead = deadHolder();
        mockState.settings = { liveTrackShare: true, skipperDevice: dead };

        startLiveTrickle('voyage-1');
        await flush(() => mockState.upserts.length >= 1);

        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.claimWrites[0].expected).toEqual(dead);
        expect(mockState.claimWrites[0].next).toMatchObject({ deviceId: getDeviceId() });
        expect(mockState.claimWrites[0].next.lastSeenAt).toBeUndefined();
        expect(mockState.upserts).toHaveLength(1);
        expect(mockState.toasts).toHaveLength(1);
        expect(mockState.toasts[0]).toMatch(
            /^Publishing from this \w+ now\. iPhone\/iPad · 7e1a hadn’t been seen for 32 days\.$/,
        );

        // Once: the next pushes publish without another handover or notice.
        vi.setSystemTime(NOW + 3 * MIN);
        mockState.queue.push(point());
        noteLiveTrickleHeartbeat();
        await flush(() => mockState.upserts.length >= 2);
        expect(mockState.upserts).toHaveLength(2);
        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.toasts).toHaveLength(1);
    });

    it('a holder whose heartbeat stopped 7 hours ago is handed over too', async () => {
        mockState.settings = {
            liveTrackShare: true,
            skipperDevice: {
                ...deadHolder(),
                deviceName: 'iPad · 77c1',
                claimedAt: ago(9 * DAY),
                lastSeenAt: ago(7 * HOUR),
            },
        };
        startLiveTrickle('voyage-1');
        await flush(() => mockState.upserts.length >= 1);
        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.toasts[0]).toMatch(/iPad · 77c1 hadn’t published for 7 hours\.$/);
    });

    it('measures the silence from the account’s newest live point when that is newer than the claim', async () => {
        // An older build published until 7 hours ago, under a 32-day-old claim.
        mockState.settings = { liveTrackShare: true, skipperDevice: deadHolder() };
        mockState.newestLive = { timestamp: ago(7 * HOUR), created_at: ago(7 * HOUR) };
        startLiveTrickle('voyage-1');
        await flush(() => mockState.upserts.length >= 1);
        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.toasts).toEqual([
            expect.stringMatching(/iPhone\/iPad · 7e1a hadn’t published for 7 hours\.$/),
        ]);
    });

    it('a holder seen 20 minutes ago keeps the page: no handover, no publish', async () => {
        mockState.settings = {
            liveTrackShare: true,
            skipperDevice: { ...deadHolder(), claimedAt: ago(40 * DAY), lastSeenAt: ago(20 * MIN) },
        };
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.claimWrites).toHaveLength(0);
        expect(mockState.upserts).toHaveLength(0);
        expect(mockState.toasts).toHaveLength(0);
        expect(mockState.liveReads).toBe(0);
    });

    it('leaves a stale-looking claim alone while the account’s live track is still moving (an older build publishing)', async () => {
        mockState.settings = { liveTrackShare: true, skipperDevice: deadHolder() };
        mockState.newestLive = { timestamp: ago(HOUR), created_at: ago(HOUR) };
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.liveReads).toBe(1);
        expect(mockState.claimWrites).toHaveLength(0);
        expect(mockState.upserts).toHaveLength(0);
    });

    it('does not guess when the live track cannot be read', async () => {
        mockState.settings = { liveTrackShare: true, skipperDevice: deadHolder() };
        mockState.failLiveRead = true;
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.claimWrites).toHaveLength(0);
        expect(mockState.upserts).toHaveLength(0);
    });

    it('stands down when the cloud claim changed under it (the holder came back)', async () => {
        mockState.settings = { liveTrackShare: true, skipperDevice: deadHolder() };
        mockState.claimWriteResult = 'changed';
        mockState.cloudClaimOnChange = { ...deadHolder(), lastSeenAt: ago(MIN) };
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.upserts).toHaveLength(0);
        expect(mockState.toasts).toHaveLength(0);
    });

    it('tries a failed handover no more than once per two minutes — never a write loop', async () => {
        mockState.settings = { liveTrackShare: true, skipperDevice: deadHolder() };
        mockState.claimWriteResult = 'failed';
        startLiveTrickle('voyage-1');
        await settle();
        for (let i = 0; i < 5; i++) {
            mockState.queue.push(point());
            noteLiveTrickleHeartbeat();
            await settle();
        }
        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.upserts).toHaveLength(0);

        vi.setSystemTime(NOW + 2 * MIN + 1);
        noteLiveTrickleHeartbeat();
        await settle();
        expect(mockState.claimWrites).toHaveLength(2);
    });

    it('does nothing with live share off — nothing was going to publish', async () => {
        mockState.settings = { liveTrackShare: false, skipperDevice: deadHolder() };
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.claimWrites).toHaveLength(0);
        expect(mockState.liveReads).toBe(0);
    });

    it('an unclaimed boat publishes as today and writes no claim', async () => {
        startLiveTrickle('voyage-1');
        await flush(() => mockState.upserts.length >= 1);
        await settle();
        expect(mockState.upserts).toHaveLength(1);
        expect(mockState.claimWrites).toHaveLength(0);
    });
});

describe('the holder’s heartbeat', () => {
    it('stamps lastSeenAt after a successful upload, at most once per 30 minutes', async () => {
        const claim = mine();
        mockState.settings = { liveTrackShare: true, skipperDevice: claim };

        startLiveTrickle('voyage-1');
        await flush(() => mockState.claimWrites.length >= 1);
        expect(mockState.upserts).toHaveLength(1);
        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.claimWrites[0].expected).toEqual(claim);
        expect(mockState.claimWrites[0].next).toMatchObject({
            deviceId: claim.deviceId,
            claimedAt: claim.claimedAt,
            lastSeenAt: new Date(NOW).toISOString(),
        });

        // Five minutes on: another upload, no second write.
        vi.setSystemTime(NOW + 5 * MIN);
        mockState.queue.push(point());
        noteLiveTrickleHeartbeat();
        await flush(() => mockState.upserts.length >= 2);
        await settle();
        expect(mockState.upserts).toHaveLength(2);
        expect(mockState.claimWrites).toHaveLength(1);

        // Thirty-one minutes after the first beat: the next upload beats again.
        vi.setSystemTime(NOW + 31 * MIN);
        mockState.queue.push(point());
        noteLiveTrickleHeartbeat();
        await flush(() => mockState.claimWrites.length >= 2);
        expect(mockState.upserts).toHaveLength(3);
        expect(mockState.claimWrites).toHaveLength(2);
        expect(mockState.claimWrites[1].next.lastSeenAt).toBe(new Date(NOW + 31 * MIN).toISOString());
    });

    it('never beats after a failed upload', async () => {
        mockState.settings = { liveTrackShare: true, skipperDevice: mine() };
        mockState.failUpsert = true;
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.upserts).toHaveLength(0);
        expect(mockState.claimWrites).toHaveLength(0);
    });

    it('does not beat for a claim made minutes ago — the claim is its own sign of life', async () => {
        mockState.settings = { liveTrackShare: true, skipperDevice: mine({ claimedAt: ago(5 * MIN) }) };
        startLiveTrickle('voyage-1');
        await flush(() => mockState.upserts.length >= 1);
        await settle();
        expect(mockState.claimWrites).toHaveLength(0);
    });
});

describe('the displaced device', () => {
    it('back and tracking, it takes a forgotten claim back with ONE message: the displaced toast is withdrawn', async () => {
        // App raised "no longer the skipper: iPhone · 9f3a took over" when the
        // refresh landed the other phone's claim, which has since gone 8 hours
        // without a sign of life.
        noteDisplacedNotice(41);
        mockState.settings = {
            liveTrackShare: true,
            skipperDevice: {
                deviceId: 'dev-fictional-other-phone',
                deviceName: 'iPhone · 9f3a',
                claimedAt: ago(2 * DAY),
                lastSeenAt: ago(8 * HOUR),
            },
        };
        startLiveTrickle('voyage-1');
        await flush(() => mockState.upserts.length >= 1);

        expect(mockState.claimWrites).toHaveLength(1);
        expect(mockState.dismissed).toEqual([41]);
        expect(mockState.toasts).toEqual([
            expect.stringMatching(/^Publishing from this \w+ now\. iPhone · 9f3a hadn’t published for 8 hours\.$/),
        ]);
        // Withdrawn once; a later handover has nothing left to withdraw.
        expect(takeDisplacedNotice()).toBeNull();
    });

    it('a handover that does not happen leaves the displaced toast standing', async () => {
        noteDisplacedNotice(42);
        mockState.settings = {
            liveTrackShare: true,
            skipperDevice: { ...deadHolder(), lastSeenAt: ago(20 * MIN) },
        };
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.dismissed).toEqual([]);
        expect(takeDisplacedNotice()).toBe(42);
    });

    it('finds out it lost the claim and never takes a fresh one back', async () => {
        const held = mine();
        mockState.settings = { liveTrackShare: true, skipperDevice: held };
        const takenBy: SkipperClaim = {
            deviceId: 'dev-fictional-other-phone',
            deviceName: 'iPhone · 4be2',
            claimedAt: ago(MIN),
        };
        mockState.onClaimRefresh = () => {
            mockState.settings = { ...mockState.settings, skipperDevice: takenBy };
        };
        startLiveTrickle('voyage-1');
        await settle();
        expect(mockState.upserts).toHaveLength(0);
        expect(mockState.claimWrites).toHaveLength(0);
        expect(hasBeenDisplaced(mockState.settings.skipperDevice as SkipperClaim, true)).toBe(true);
    });
});
