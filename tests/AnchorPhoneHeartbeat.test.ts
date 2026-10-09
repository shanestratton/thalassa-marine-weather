/**
 * The boat's phone checks in with the server while it keeps a shared anchor
 * watch (126-03b), so the server can tell the crew when it goes quiet.
 *
 * Fictional and global: two sessions, owners 'skipper-1' and 'crew-1', and a
 * boat at anchor off Cádiz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncState } from '../services/AnchorWatchSyncService';

const mocks = vi.hoisted(() => ({
    sync: null as unknown as SyncState,
    syncListeners: new Set<(state: SyncState) => void>(),
    watch: { state: 'idle' } as { state: string },
    watchListeners: new Set<(snapshot: { state: string }) => void>(),
    bgListeners: new Set<(event: unknown) => void>(),
    rpc: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        onStateChange: (listener: (state: SyncState) => void) => {
            mocks.syncListeners.add(listener);
            listener(mocks.sync);
            return () => mocks.syncListeners.delete(listener);
        },
        getState: () => mocks.sync,
    },
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: (listener: (snapshot: { state: string }) => void) => {
            mocks.watchListeners.add(listener);
            listener(mocks.watch);
            return () => mocks.watchListeners.delete(listener);
        },
        getSnapshot: () => mocks.watch,
    },
}));
vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        subscribeHeartbeat: (listener: (event: unknown) => void) => {
            mocks.bgListeners.add(listener);
            return () => mocks.bgListeners.delete(listener);
        },
    },
}));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

import { createAnchorPhoneHeartbeat } from '../services/anchorPhoneHeartbeat';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const SESSION = 'K7Q2M9X4P8R3';
const OTHER_SESSION = 'H4N8T2W6Z3B5';
// Off Cádiz (36.53, -6.30): only the state matters to the heartbeat, never the position.
const CADIZ = { latitude: 36.53, longitude: -6.3 };

function vesselSync(sessionCode: string | null = SESSION): SyncState {
    return {
        connected: true,
        role: 'vessel',
        sessionCode,
        peerConnected: false,
        lastPeerUpdate: null,
        peerDisconnectedAt: null,
    };
}
function setSync(patch: Partial<SyncState>) {
    mocks.sync = { ...mocks.sync, ...patch };
    mocks.syncListeners.forEach((listener) => listener(mocks.sync));
}
function setWatch(state: string) {
    mocks.watch = { state, ...(state === 'watching' ? { vesselPosition: CADIZ } : {}) } as { state: string };
    mocks.watchListeners.forEach((listener) => listener(mocks.watch));
}
function bgHeartbeat() {
    mocks.bgListeners.forEach((listener) => listener({ location: { coords: CADIZ } }));
}
/** p_state of every call, in order. */
const beats = () =>
    mocks.rpc.mock.calls.map((call) => {
        const [name, args] = call as [string, { p_session_code: string; p_state: string }];
        expect(name).toBe('record_anchor_watch_heartbeat');
        return `${args.p_state}:${args.p_session_code}`;
    });
const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

let heartbeat: ReturnType<typeof createAnchorPhoneHeartbeat> | null = null;
function startHeartbeat() {
    heartbeat = createAnchorPhoneHeartbeat();
    heartbeat.start();
    return heartbeat;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-10T02:00:00Z'));
    localStorage.clear();
    mocks.rpc.mockReset().mockResolvedValue({ data: { expires_at: '2026-10-11T01:00:00Z' }, error: null });
    mocks.warn.mockReset();
    mocks.syncListeners.clear();
    mocks.watchListeners.clear();
    mocks.bgListeners.clear();
    mocks.sync = vesselSync();
    mocks.watch = { state: 'idle' };
    setAuthIdentityScope('skipper-1');
});

afterEach(() => {
    heartbeat?.stop();
    heartbeat = null;
    setAuthIdentityScope(null);
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('the boat phone checks in while it keeps a shared watch', () => {
    it('beats at once, then every 60 s, while watching or alarming', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(beats()).toHaveLength(2);
        setWatch('alarm'); // a drag alarm is still a watch being kept
        await vi.advanceTimersByTimeAsync(60_000);
        expect(beats()).toEqual([`watching:${SESSION}`, `watching:${SESSION}`, `watching:${SESSION}`]);
    });

    it('beats at most once per 50 s however many fixes arrive', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        for (let i = 0; i < 12; i++) {
            await vi.advanceTimersByTimeAsync(4_000);
            setWatch('watching');
        }
        expect(beats()).toHaveLength(1); // 48 s of fixes, one beat
        await vi.advanceTimersByTimeAsync(3_000);
        setWatch('watching');
        await settle();
        expect(beats()).toHaveLength(2);
    });

    it("beats from BgGeo's heartbeat alone when the WebView timer does not fire (background)", async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        expect(beats()).toHaveLength(1);
        // iOS throttled the timer: the clock moves, no timer callback runs.
        vi.setSystemTime(Date.now() + 61_000);
        bgHeartbeat();
        await settle();
        expect(beats()).toHaveLength(2);
    });

    it.each([
        ['the shore role', { role: 'shore' as const }, 'watching'],
        ['no session', { sessionCode: null }, 'watching'],
        ['a paused (blocked) watch', {}, 'paused'],
        ['an anchor still being set', {}, 'setting'],
        ['no watch', {}, 'idle'],
    ])('sends nothing with %s', async (_label, sync, state) => {
        mocks.sync = { ...vesselSync(), ...sync };
        mocks.watch = { state };
        startHeartbeat();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        bgHeartbeat();
        await settle();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('a watch that becomes blocked stops beating and does NOT end, so the crew are told', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        setWatch('paused');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        bgHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`]);
    });

    it('weighing anchor (watching -> idle) sends ended once, and nothing after', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        setWatch('idle');
        await settle();
        setWatch('idle');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        bgHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `ended:${SESSION}`]);
    });

    it('handing the watch to the Pi (stopWatch, then joinSession as shore) ends the phone watch, then no beats', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        // anchorWatchPage.handleAcceptPiWatch: the Pi took it, this phone stands down…
        setWatch('idle');
        // …and rejoins the same session as the shore half.
        setSync({ role: 'shore' });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        bgHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `ended:${SESSION}`]);
    });

    it('a failed ended (no signal while weighing) is retried on the next activity until it lands', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'Network request failed' } });
        setWatch('idle');
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `ended:${SESSION}`]);
        bgHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `ended:${SESSION}`, `ended:${SESSION}`]);
        // Landed: never again.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        bgHeartbeat();
        await settle();
        expect(beats()).toHaveLength(3);
    });

    it('a pending ended survives the app being killed and is sent at the next launch', async () => {
        mocks.watch = { state: 'watching' };
        const first = startHeartbeat();
        await settle();
        mocks.rpc.mockRejectedValueOnce(new TypeError('Load failed'));
        setWatch('idle');
        await settle();
        first.stop();
        expect(beats()).toHaveLength(2);

        startHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `ended:${SESSION}`, `ended:${SESSION}`]);
    });

    it('a server without the heartbeat (PGRST202 at the first beat) is not called again for that watch', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { code: 'PGRST202', message: 'Could not find the function public.record_anchor_watch_heartbeat' },
        });
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(60_000);
            setWatch('watching');
            bgHeartbeat();
        }
        setWatch('idle'); // and no ended either: there is nothing to end
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(beats()).toEqual([`watching:${SESSION}`]);
        // No pending end was stored for later either.
        const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '');
        expect(stored.some((value) => value.includes(SESSION))).toBe(false);

        // A later watch on another session asks again.
        mocks.rpc.mockResolvedValue({ data: { expires_at: '2026-10-11T01:00:00Z' }, error: null });
        setSync({ sessionCode: OTHER_SESSION });
        setWatch('watching');
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `watching:${OTHER_SESSION}`]);
    });

    // Review 2026-10-10: a refusal (42501) is not "no server". supabase-js sends
    // the anon key when a lapsed token cannot be refreshed (a locked phone at
    // 03:00 on marginal signal), and that is refused too: a passing auth fault
    // must never switch the watchdog off for the rest of the app's life.
    it('a refused beat (42501) is tried again at the next beat, and the beats carry on', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: '42501', message: 'Only the phone keeping this watch may report it' },
        });
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(beats()).toEqual([`watching:${SESSION}`, `watching:${SESSION}`, `watching:${SESSION}`]);
        expect(mocks.warn.mock.calls.some(([message]) => /refused/.test(String(message)))).toBe(true);
    });

    it('a refused ended (42501) stays owed and is sent again', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: '42501', message: 'permission denied for function record_anchor_watch_heartbeat' },
        });
        setWatch('idle');
        await settle();
        bgHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `ended:${SESSION}`, `ended:${SESSION}`]);
    });

    it('ended waits for a check-in still on its way, so that check-in cannot land last and undo it', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        let land: (value: unknown) => void = () => undefined;
        mocks.rpc.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
        await vi.advanceTimersByTimeAsync(60_000); // a check-in goes out over a slow link…
        expect(beats()).toHaveLength(2);
        setWatch('idle'); // …and the anchor comes up while it is still on its way
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `watching:${SESSION}`]);
        land({ data: null, error: null });
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`, `watching:${SESSION}`, `ended:${SESSION}`]);
    });

    it('an identity switch beats nothing more for the old account and ends nothing on its behalf', async () => {
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        expect(beats()).toHaveLength(1);
        // authStore advances the fence; AnchorWatchSyncService tears the session down in the same turn.
        setAuthIdentityScope('crew-1');
        setSync({ sessionCode: null });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        setWatch('idle');
        bgHeartbeat();
        await settle();
        expect(beats()).toEqual([`watching:${SESSION}`]);
    });

    it('logs reasons only, never a session code', async () => {
        mocks.rpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'Network request failed' } });
        mocks.watch = { state: 'watching' };
        startHeartbeat();
        await settle();
        setWatch('idle');
        await settle();
        expect(mocks.warn).toHaveBeenCalled();
        for (const call of mocks.warn.mock.calls) expect(JSON.stringify(call)).not.toContain(SESSION);
    });
});
