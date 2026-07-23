import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpsert = vi.fn();
const mockInsert = vi.fn();
const mockRpc = vi.fn();
const mockEq = vi.fn();

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
        from: (table: string) => ({
            select: () => ({
                eq: (...args: unknown[]) => {
                    mockEq(table, ...args);
                    return { maybeSingle: () => mockMaybeSingle() };
                },
            }),
            upsert: (...args: unknown[]) => mockUpsert(table, ...args),
            insert: (...args: unknown[]) => mockInsert(table, ...args),
        }),
        rpc: (...args: unknown[]) => mockRpc(...args),
    },
}));

vi.mock('../stores/LocationStore', () => ({
    LocationStore: { getState: () => ({ lat: -27.47, lon: 153.02 }) },
}));

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

let GuardianService: typeof import('../services/GuardianService').GuardianService;
let setAuthIdentityScope: typeof import('../services/authIdentityScope').setAuthIdentityScope;

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ setAuthIdentityScope } = await import('../services/authIdentityScope'));
    setAuthIdentityScope('account-a');
    ({ GuardianService } = await import('../services/GuardianService'));
    mockGetUser.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
    GuardianService.stop();
    vi.useRealTimers();
});

describe('Guardian identity boundary', () => {
    it('hides A synchronously and discards a deferred A profile result', async () => {
        const profileRequest = deferred<{
            data: { user_id: string; vessel_name: string; armed: boolean };
            error: null;
        }>();
        mockMaybeSingle.mockReturnValueOnce(profileRequest.promise);
        const load = GuardianService.fetchProfile();
        await vi.waitFor(() => expect(mockEq).toHaveBeenCalledWith('guardian_profiles', 'user_id', 'account-a'));

        setAuthIdentityScope('account-b');
        expect(GuardianService.getState()).toMatchObject({
            profile: null,
            nearbyUsers: [],
            alerts: [],
            armed: false,
        });

        profileRequest.resolve({
            data: { user_id: 'account-a', vessel_name: 'A private vessel', armed: true },
            error: null,
        });
        await expect(load).resolves.toBeNull();
        expect(GuardianService.getState().profile).toBeNull();
        expect(GuardianService.getState().armed).toBe(false);
    });

    it('uses an immutable owner filter and rejects a row for another owner', async () => {
        mockMaybeSingle.mockResolvedValueOnce({
            data: { user_id: 'account-b', vessel_name: 'Wrong owner', armed: true },
            error: null,
        });

        await expect(GuardianService.fetchProfile()).resolves.toBeNull();
        expect(mockEq).toHaveBeenCalledWith('guardian_profiles', 'user_id', 'account-a');
        expect(GuardianService.getState().profile).toBeNull();
    });

    it('does not let a deferred A profile mutation refresh or report success in B', async () => {
        const write = deferred<{ error: null }>();
        mockUpsert.mockReturnValueOnce(write.promise);

        const result = GuardianService.updateProfile({ vessel_name: 'A vessel' });
        await vi.waitFor(() => expect(mockUpsert).toHaveBeenCalledTimes(1));
        expect(mockUpsert.mock.calls[0][1]).toMatchObject({
            user_id: 'account-a',
            vessel_name: 'A vessel',
        });

        setAuthIdentityScope('account-b');
        mockGetUser.mockResolvedValue({ data: { user: { id: 'account-b' } }, error: null });
        write.resolve({ error: null });

        await expect(result).resolves.toBe(false);
        expect(mockEq).not.toHaveBeenCalled();
        expect(GuardianService.getState().profile).toBeNull();
    });

    it('stops account timers at the identity fence without disarming A on the server', async () => {
        vi.useFakeTimers();
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        mockMaybeSingle.mockResolvedValue({ data: null, error: null });
        mockRpc.mockResolvedValue({ data: [], error: null });

        await GuardianService.initialize();
        expect(vi.getTimerCount()).toBe(2);

        setAuthIdentityScope('account-b');
        expect(vi.getTimerCount()).toBe(0);
        expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
        expect(mockRpc).not.toHaveBeenCalledWith('guardian_disarm');
    });

    it('returns defensive snapshots and isolates subscriber failures', async () => {
        mockMaybeSingle.mockResolvedValueOnce({
            data: { user_id: 'account-a', vessel_name: 'Original', armed: false },
            error: null,
        });
        const healthyListener = vi.fn();
        GuardianService.subscribe(() => {
            throw new Error('broken listener');
        });
        GuardianService.subscribe(healthyListener);

        await GuardianService.fetchProfile();
        expect(healthyListener).toHaveBeenCalled();
        const snapshot = GuardianService.getState();
        if (!snapshot.profile) throw new Error('profile was not loaded');
        snapshot.profile.vessel_name = 'Mutated copy';
        expect(GuardianService.getState().profile?.vessel_name).toBe('Original');
    });

    it('rejects invalid MMSI, coordinates, profile fields, and alert text before writing', async () => {
        await expect(GuardianService.claimMMSI(12345)).resolves.toEqual({
            success: false,
            error: 'MMSI must be exactly 9 digits',
        });
        await expect(GuardianService.setHomeCoordinate(91, 0, 100)).resolves.toBe(false);
        await expect(GuardianService.setHomeCoordinate(0, 181, 100)).resolves.toBe(false);
        await expect(GuardianService.updateProfile({ vessel_name: 'x'.repeat(501) })).resolves.toBe(false);
        await expect(GuardianService.reportSuspicious('   ')).resolves.toEqual({ success: false, notified: 0 });
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockRpc).not.toHaveBeenCalled();
    });
});
