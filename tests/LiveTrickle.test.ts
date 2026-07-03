/**
 * LiveTrickle — live position sharing for the public Voyage Log.
 *
 * The trickle is a read-only shadow of the offline queue: throttled,
 * decimated, idempotent (upsert on user_id+timestamp), gated on the
 * liveTrackShare setting, and it must never advance its high-water mark
 * when the upsert fails (so signal gaps retry in full).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mutable mocks ───────────────────────────────────────────────────
// `supabase` is a STABLE object delegating to a swappable impl — static
// import bindings snapshot the export, so a getter-over-mutable-holder
// isn't reliably re-read.
const mockState: {
    impl: { from: (table: string) => unknown } | null;
    user: { id: string } | null;
    settings: Record<string, unknown>;
    queue: Record<string, unknown>[];
    prefs: Map<string, string>;
} = {
    impl: null,
    user: { id: 'user-1' },
    settings: { liveTrackShare: true },
    queue: [],
    prefs: new Map(),
};

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => {
            if (!mockState.impl) throw new Error('no supabase impl installed for this test');
            return mockState.impl.from(table);
        },
    },
    getCurrentUser: async () => mockState.user,
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: mockState.settings }),
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

import { startLiveTrickle, stopLiveTrickle, noteLiveTrickleHeartbeat } from '../services/shiplog/LiveTrickle';

// ── Helpers ─────────────────────────────────────────────────────────
const T0 = Date.parse('2026-07-04T00:00:00.000Z');
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const point = (offsetSec: number, extra: Record<string, unknown> = {}) => ({
    id: `p${offsetSec}`,
    voyageId: 'voyage-1',
    timestamp: iso(offsetSec),
    latitude: -27.2 + offsetSec * 1e-5,
    longitude: 153.09,
    speedKts: 6.2,
    courseDeg: 180,
    entryType: 'auto',
    ...extra,
});

/** supabase impl capturing upserted rows; failNext makes one upsert fail. */
function installSupabase() {
    const calls: { rows: Record<string, unknown>[]; opts: unknown }[] = [];
    const deletes: string[] = [];
    const ctl = { failNext: false };
    mockState.impl = {
        from: (table: string) => ({
            upsert: async (rows: Record<string, unknown>[], opts: unknown) => {
                if (ctl.failNext) {
                    ctl.failNext = false;
                    return { error: { message: 'no signal' } };
                }
                calls.push({ rows, opts });
                return { error: null };
            },
            delete: () => ({
                eq: () => ({
                    lt: async (_c: string, cutoff: string) => {
                        deletes.push(`${table}<${cutoff}`);
                        return { error: null };
                    },
                }),
            }),
        }),
    };
    return { calls, deletes, ctl };
}

// The first armed tick pays one-off dynamic-import latency (settings store),
// so waits must be condition-driven, not fixed-length.
const flush = async (pred?: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (pred?.()) return;
    }
};

beforeEach(() => {
    mockState.user = { id: 'user-1' };
    mockState.settings = { liveTrackShare: true };
    mockState.queue = [];
    mockState.prefs.clear();
});

afterEach(async () => {
    await stopLiveTrickle(false);
    mockState.impl = null;
});

describe('LiveTrickle', () => {
    it('does nothing when not armed', async () => {
        const { calls } = installSupabase();
        mockState.queue = [point(0)];
        noteLiveTrickleHeartbeat();
        await flush();
        expect(calls).toHaveLength(0);
    });

    it('publishes decimated points and advances the mark', async () => {
        const { calls } = installSupabase();
        // 0s, 10s, 20s, 40s, 70s → 30s decimation keeps 0, 40, 70
        mockState.queue = [point(0), point(10), point(20), point(40), point(70)];
        startLiveTrickle('voyage-1');
        noteLiveTrickleHeartbeat();
        await flush(() => calls.length >= 1 && mockState.prefs.has('live_trickle_mark_v1'));

        expect(calls).toHaveLength(1);
        const rows = calls[0].rows;
        expect(rows.map((r) => r.timestamp)).toEqual([iso(0), iso(40), iso(70)]);
        expect(rows[0]).toMatchObject({
            user_id: 'user-1',
            voyage_id: 'voyage-1',
            latitude: -27.2,
            speed_kts: 6.2,
            course_deg: 180,
            source: 'device',
        });
        expect(calls[0].opts).toMatchObject({ onConflict: 'user_id,timestamp', ignoreDuplicates: true });
        expect(mockState.prefs.get('live_trickle_mark_v1')).toBe(iso(70));
    });

    it('throttles repeat heartbeats inside the interval', async () => {
        const { calls } = installSupabase();
        mockState.queue = [point(0)];
        startLiveTrickle('voyage-1');
        noteLiveTrickleHeartbeat();
        await flush(() => calls.length >= 1);
        mockState.queue.push(point(120));
        noteLiveTrickleHeartbeat(); // < 2 min since last attempt → no-op
        await new Promise((r) => setTimeout(r, 30));
        expect(calls).toHaveLength(1);
    });

    it('only sends points newer than the mark on the next flush', async () => {
        const { calls } = installSupabase();
        mockState.queue = [point(0), point(40)];
        startLiveTrickle('voyage-1');
        noteLiveTrickleHeartbeat();
        await flush(() => calls.length >= 1);
        expect(calls).toHaveLength(1);

        mockState.queue.push(point(200));
        await stopLiveTrickle(true); // final flush ignores the throttle
        expect(calls).toHaveLength(2);
        expect(calls[1].rows.map((r) => r.timestamp)).toEqual([iso(200)]);
    });

    it('keeps the mark on upsert failure so the gap retries in full', async () => {
        const { calls, ctl } = installSupabase();
        mockState.queue = [point(0), point(40)];
        startLiveTrickle('voyage-1');
        ctl.failNext = true;
        noteLiveTrickleHeartbeat();
        await flush(() => !ctl.failNext); // mock consumes the flag on the attempt
        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toHaveLength(0);
        expect(mockState.prefs.get('live_trickle_mark_v1')).toBeUndefined();

        await stopLiveTrickle(true); // retry — same points go up
        expect(calls).toHaveLength(1);
        expect(calls[0].rows.map((r) => r.timestamp)).toEqual([iso(0), iso(40)]);
    });

    it('is gated on the liveTrackShare setting', async () => {
        const { calls } = installSupabase();
        mockState.settings = { liveTrackShare: false };
        mockState.queue = [point(0)];
        startLiveTrickle('voyage-1');
        noteLiveTrickleHeartbeat();
        await flush();
        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toHaveLength(0);
    });

    it('filters manual entries and COG turn pins', async () => {
        const { calls } = installSupabase();
        mockState.queue = [
            point(0),
            point(40, { entryType: 'manual' }),
            point(80, { waypointName: 'COG 120°' }),
            point(120, { notes: 'Auto: COG change' }),
            point(160),
        ];
        startLiveTrickle('voyage-1');
        noteLiveTrickleHeartbeat();
        await flush(() => calls.length >= 1);
        expect(calls[0].rows.map((r) => r.timestamp)).toEqual([iso(0), iso(160)]);
    });
});
