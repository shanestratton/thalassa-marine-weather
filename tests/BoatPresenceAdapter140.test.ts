import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    scope: { key: 'user:a', userId: '00000000-0000-4000-8000-000000000001', generation: 0 },
    settings: {
        settings: { satelliteMode: false },
        activeVesselId: '00000000-0000-4000-8000-000000000002',
        vesselFleet: [
            {
                id: '00000000-0000-4000-8000-000000000002',
                owner_id: '00000000-0000-4000-8000-000000000001',
                archived_at: null,
                releasedAt: null,
            },
        ],
    },
    authListeners: new Set<() => void>(),
    settingsListeners: new Set<() => void>(),
    auth: vi.fn(),
    rpc: vi.fn(),
    gps: vi.fn(),
    signals: [] as AbortSignal[],
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => h.scope,
    subscribeAuthIdentityScope: (f: () => void) => {
        h.authListeners.add(f);
        return () => h.authListeners.delete(f);
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => h.settings,
        subscribe: (f: () => void) => {
            h.settingsListeners.add(f);
            return () => h.settingsListeners.delete(f);
        },
    },
}));
vi.mock('../services/supabase', () => ({ supabase: { auth: { getSession: h.auth }, rpc: h.rpc } }));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: h.gps } }));
import { boatPresence } from '../services/presence/boatPresence';
const config = {
    vesselId: '00000000-0000-4000-8000-000000000002',
    vesselName: 'Fictional boat',
    tier: 'off',
    revision: '00000000-0000-4000-8000-000000000003',
    sequence: 1,
    readerRevision: '00000000-0000-4000-8000-000000000004',
    publisherRevision: '00000000-0000-4000-8000-000000000005',
    publisherActive: false,
    serverTime: new Date().toISOString(),
};
beforeEach(() => {
    vi.useRealTimers();
    boatPresence.retire();
    h.scope = { key: 'user:a', userId: '00000000-0000-4000-8000-000000000001', generation: h.scope.generation + 1 };
    h.settings.settings.satelliteMode = false;
    h.settings.activeVesselId = config.vesselId;
    h.settings.vesselFleet = [{ id: config.vesselId, owner_id: h.scope.userId, archived_at: null, releasedAt: null }];
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    h.signals = [];
    h.rpc.mockReset();
    h.auth.mockReset();
    h.gps.mockReset();
    h.auth.mockResolvedValue({
        data: { session: { user: { id: h.scope.userId, user_metadata: { role: 'owner' } } } },
        error: null,
    });
    h.rpc.mockImplementation(() => ({
        abortSignal: (signal: AbortSignal) => {
            h.signals.push(signal);
            return Promise.resolve({ data: config, error: null });
        },
    }));
    for (const f of h.authListeners) f();
    for (const f of h.settingsListeners) f();
});
afterEach(() => {
    boatPresence.retire();
    vi.useRealTimers();
});
it('import/subscriptions start no request or extra GPS watcher', () => {
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.gps).not.toHaveBeenCalled();
});
it('uses exact whitelisted RPC with authoritative session identity', async () => {
    await boatPresence.load();
    expect(h.rpc).toHaveBeenCalledWith('boat_presence_control', { p_action: 'state', p_input: {} });
    expect(h.signals).toHaveLength(1);
});
it('a local provisional user cannot bypass a mismatching session', async () => {
    h.auth.mockResolvedValue({
        data: { session: { user: { id: 'other', user_metadata: { role: 'owner' } } } },
        error: null,
    });
    await expect(boatPresence.load()).rejects.toThrow('Sign in again');
    expect(h.rpc).not.toHaveBeenCalled();
});
it('never uses role metadata to adopt somebody else’s hull', async () => {
    h.settings.vesselFleet[0].owner_id = 'another-owner';
    for (const f of h.settingsListeners) f();
    await expect(boatPresence.load()).rejects.toThrow('syncing');
    expect(boatPresence.snapshot().config).toBe(null);
});
it('Satellite Mode blocks even an explicit load and retires synchronously', async () => {
    await boatPresence.load();
    h.rpc.mockClear();
    h.settings.settings.satelliteMode = true;
    for (const f of h.settingsListeners) f();
    expect(boatPresence.snapshot().config).toBe(null);
    await expect(boatPresence.load()).rejects.toThrow('normal connection');
    expect(h.rpc).not.toHaveBeenCalled();
});
it('an offline event retires private state with no replay on reconnect', async () => {
    await boatPresence.load();
    h.rpc.mockClear();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
    expect(boatPresence.snapshot().config).toBe(null);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    await boatPresence.tick();
    expect(h.rpc).not.toHaveBeenCalled();
});
it('auth A-B-A cannot revive a pending local session lookup', async () => {
    let finish!: (v: unknown) => void;
    h.auth.mockImplementation(
        () =>
            new Promise((r) => {
                finish = r;
            }),
    );
    const pending = boatPresence.load();
    h.scope = { ...h.scope, key: 'user:b', userId: 'other', generation: h.scope.generation + 1 };
    for (const f of h.authListeners) f();
    h.scope = {
        ...h.scope,
        key: 'user:a',
        userId: '00000000-0000-4000-8000-000000000001',
        generation: h.scope.generation + 1,
    };
    for (const f of h.authListeners) f();
    finish({ data: { session: { user: { id: h.scope.userId } } }, error: null });
    await expect(pending).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(boatPresence.snapshot().config).toBe(null);
});
it('caps a hung session lookup and cannot issue RPC after timeout', async () => {
    vi.useFakeTimers();
    let finish!: (v: unknown) => void;
    h.auth.mockImplementation(
        () =>
            new Promise((r) => {
                finish = r;
            }),
    );
    const pending = boatPresence.load();
    const failure = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(6001);
    await failure;
    finish({ data: { session: { user: { id: h.scope.userId } } }, error: null });
    await Promise.resolve();
    expect(h.rpc).not.toHaveBeenCalled();
});
it('aborts a hung RPC within6 seconds', async () => {
    vi.useFakeTimers();
    h.rpc.mockImplementation(() => ({
        abortSignal: (signal: AbortSignal) => {
            h.signals.push(signal);
            return new Promise(() => {});
        },
    }));
    const pending = boatPresence.load();
    const failure = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(6001);
    await failure;
    expect(h.signals[0].aborted).toBe(true);
});
