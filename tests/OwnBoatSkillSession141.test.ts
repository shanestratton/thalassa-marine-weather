import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOwnBoatSkillReview } from '../services/weather/ownBoatSkillSession';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    OWN_BOAT_SKILL_CAPABILITY_KEY,
    setAuthIdentityScope,
} from '../services/authIdentityScope';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    NOW = Date.UTC(2026, 9, 17, 6);
const mocks = vi.hoisted(() => ({
    state: {
        activeVesselId: '',
        vesselFleet: [] as {
            id: string;
            name: string;
            owner_id: string;
            revision: number;
            archived_at: null;
            releasedAt: null;
        }[],
    },
    pair: {
        deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        publicKeySpki: 'synthetic-public-pin',
        pairedAt: '2026-10-17T00:00:00Z',
    },
    revision: 1,
    pinned: vi.fn(),
    headers: vi.fn(),
    app: vi.fn(),
    listeners: new Set<() => void>(),
    settingsListeners: new Set<() => void>(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => mocks.state,
        subscribe: (fn: () => void) => {
            mocks.settingsListeners.add(fn);
            return () => mocks.settingsListeners.delete(fn);
        },
    },
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => mocks.pair,
    getPiEquipmentReadRevision: () => mocks.revision,
    getChartDevice: async () => ({ chartDeviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    pinnedPiRequest: mocks.pinned,
}));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => 'https://synthetic-pi.invalid' } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => true }));
vi.mock('../services/supabaseAuth', () => ({ getAuthenticatedFunctionHeaders: mocks.headers }));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: async () => ({ isActive: true }),
        addListener: (_: string, fn: () => void) => {
            mocks.listeners.add(fn);
            return Promise.resolve({
                remove: async () => {
                    mocks.listeners.delete(fn);
                },
            });
        },
    },
}));
const binding = {
    ownerId: ID,
    vesselId: ID,
    vesselRevision: 2,
    piDeviceId: ID,
    controllerId: ID,
    pairingRevision: 'a'.repeat(64),
    enrollmentRevision: 'b'.repeat(64),
    selfKey: 'c'.repeat(64),
    windSourceKey: 'd'.repeat(64),
    positionSourceKey: 'e'.repeat(64),
};
const proposal = {
    schema: 1,
    nonce: 'f'.repeat(64),
    binding,
    vesselName: 'Synthetic boat',
    windSource: 'synthetic.wind',
    positionSource: 'synthetic.gps',
    expiresAt: NOW + 60_000,
};
const cap = {
    schema: 1,
    capability: '1'.repeat(64),
    consent: { schema: 1, revision: ID, binding, issuedAt: NOW, expiresAt: NOW + 14 * 86400_000 },
};
const reply = (v: unknown) => ({ status: 200, data: JSON.stringify(v) });
beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(ID);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    mocks.state = {
        activeVesselId: ID,
        vesselFleet: [
            { id: ID, name: 'Synthetic boat', owner_id: ID, revision: 2, archived_at: null, releasedAt: null },
        ],
    };
    mocks.revision = 1;
    mocks.settingsListeners.clear();
    mocks.listeners.clear();
    mocks.headers.mockReset().mockResolvedValue({ Authorization: 'Bearer synthetic.jwt.only' });
    mocks.pinned.mockReset().mockImplementation(async (request) => {
        if (request.url.endsWith('/prepare')) return reply(proposal);
        if (request.url.endsWith('/confirm')) return reply(cap);
        if (request.url.endsWith('/enable')) return reply({ schema: 1, state: 'logging' });
        return reply({ schema: 1, state: 'off', cleared: request.url.endsWith('/clear') });
    });
});
afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
    localStorage.clear();
});
describe('actual private phone adapter', () => {
    it('persists only the opaque grant in the actual owner/pinned-Pi namespace and uses enrolled pinned transport', async () => {
        const session = await openOwnBoatSkillReview();
        expect(mocks.pinned).not.toHaveBeenCalled();
        await session.prepare();
        await session.confirm(false);
        const key = authScopedStorageKey(OWN_BOAT_SKILL_CAPABILITY_KEY, getAuthIdentityScope());
        const stored = localStorage.getItem(key)!;
        expect(stored).toContain(cap.capability);
        expect(stored).not.toContain('synthetic.jwt');
        expect(mocks.pinned.mock.calls[1][0]).toMatchObject({
            method: 'POST',
            responseType: 'text',
            headers: { Authorization: 'Bearer synthetic.jwt.only' },
            data: { logging: false },
        });
        expect(mocks.pinned.mock.calls[1][0].isCurrent()).toBe(true);
        session.release();
        expect(mocks.settingsListeners.size).toBe(0);
    });
    it('logout clears access synchronously and asks the original Pi to stop without any new owner JWT', async () => {
        const session = await openOwnBoatSkillReview();
        await session.prepare();
        await session.confirm(true);
        const key = authScopedStorageKey(OWN_BOAT_SKILL_CAPABILITY_KEY, getAuthIdentityScope());
        const jwtCount = mocks.headers.mock.calls.length;
        setAuthIdentityScope(OTHER);
        expect(localStorage.getItem(key)).toBeNull();
        expect(session.current()).toBe(false);
        await Promise.resolve();
        expect(mocks.pinned).toHaveBeenLastCalledWith(
            expect.objectContaining({
                url: 'https://synthetic-pi.invalid/api/own-boat-skill/off',
                data: { schema: 1, capability: cap.capability },
            }),
        );
        expect(mocks.headers).toHaveBeenCalledTimes(jwtCount);
        expect(mocks.pinned.mock.calls.at(-1)![0].headers.Authorization).toBeUndefined();
    });
    it('a vessel A/B/A transition retires the original active review and never resurrects its grant', async () => {
        const session = await openOwnBoatSkillReview();
        await session.prepare();
        await session.confirm(true);
        mocks.state.activeVesselId = OTHER;
        mocks.settingsListeners.forEach((fn) => fn());
        mocks.state.activeVesselId = ID;
        mocks.settingsListeners.forEach((fn) => fn());
        expect(session.current()).toBe(false);
        expect(session.saved).toBe(false);
        await expect(session.read()).rejects.toThrow();
    });
    it('pair/controller generation changes before header completion block the actual request', async () => {
        const session = await openOwnBoatSkillReview();
        await session.prepare();
        mocks.headers.mockImplementationOnce(async () => {
            mocks.revision++;
            return { Authorization: 'Bearer synthetic.jwt.only' };
        });
        await expect(session.confirm(true)).rejects.toThrow();
        expect(mocks.pinned).toHaveBeenCalledTimes(1);
        session.release();
    });
    it('an unowned or anonymous selected vessel cannot even acquire a review', async () => {
        mocks.state.vesselFleet[0].owner_id = OTHER;
        await expect(openOwnBoatSkillReview()).rejects.toThrow();
        expect(mocks.pinned).not.toHaveBeenCalled();
    });
    it('an unrelated settings event while backgrounding cannot silently stop separately approved logging', async () => {
        const session = await openOwnBoatSkillReview();
        await session.prepare();
        await session.confirm(true);
        const count = mocks.pinned.mock.calls.length;
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        mocks.settingsListeners.forEach((fn) => fn());
        expect(session.saved).toBe(true);
        expect(mocks.pinned).toHaveBeenCalledTimes(count);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(mocks.pinned).toHaveBeenCalledTimes(count);
        expect(session.current()).toBe(false);
        visibility.mockRestore();
    });
    it('actual unsettled native requests remain capped across timed-out review remounts', async () => {
        vi.useFakeTimers();
        const settle: ((value: unknown) => void)[] = [];
        mocks.pinned.mockImplementation(() => new Promise((resolve) => settle.push(resolve)));
        for (let i = 0; i < 2; i++) {
            const session = await openOwnBoatSkillReview();
            const pending = session.prepare(),
                rejected = expect(pending).rejects.toThrow('timed out');
            await vi.advanceTimersByTimeAsync(20_001);
            await rejected;
        }
        const third = await openOwnBoatSkillReview();
        await expect(third.prepare()).rejects.toThrow('capacity');
        expect(mocks.pinned).toHaveBeenCalledTimes(2);
        for (const resolve of settle) resolve(reply(proposal));
        await vi.advanceTimersByTimeAsync(0);
        third.release();
        const fresh = await openOwnBoatSkillReview();
        mocks.pinned.mockResolvedValueOnce(reply(proposal));
        expect(await fresh.prepare()).toEqual(proposal);
        fresh.release();
    });
});
