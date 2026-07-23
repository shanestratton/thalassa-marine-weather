import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

interface QueryResult {
    data: unknown;
    error: unknown;
}

class MockQuery implements PromiseLike<QueryResult> {
    readonly select = vi.fn((_columns?: string) => this);
    readonly eq = vi.fn((_column: string, _value: unknown) => this);
    readonly limit = vi.fn((_count: number) => this);
    readonly maybeSingle = vi.fn(() => this.result);
    readonly single = vi.fn(() => this.result);
    readonly upsert = vi.fn((_values: unknown, _options?: unknown) => this);

    constructor(private readonly result: Promise<QueryResult>) {}

    then<TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
        return this.result.then(onfulfilled, onrejected);
    }
}

interface MockClient {
    auth: {
        getUser: ReturnType<typeof vi.fn>;
    };
    from: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
    client: null as MockClient | null,
}));

vi.mock('../services/supabase', () => ({
    get supabase() {
        return mocks.client;
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getCachedIdentity, saveIdentity, syncIdentity, type VesselIdentity } from '../services/VesselIdentityService';

const USER_ID = 'user-1';
const CACHE_KEY = 'thalassa_vessel_identity';

function identity(ownerId = USER_ID, overrides: Partial<VesselIdentity> = {}): VesselIdentity {
    return {
        id: `identity-${ownerId}`,
        owner_id: ownerId,
        vessel_name: 'Thalassa',
        reg_number: 'ABC-123',
        mmsi: '503123456',
        call_sign: 'VZX7890',
        phonetic_name: 'Tah-lass-ah',
        vessel_type: 'sail',
        hull_color: 'White',
        model: 'Bavaria 40',
        updated_at: '2026-07-23T00:00:00.000Z',
        ...overrides,
    };
}

function query(result: QueryResult | Promise<QueryResult>): MockQuery {
    return new MockQuery(Promise.resolve(result));
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function installClient(
    routes: Record<string, MockQuery[]>,
    authResult: Promise<unknown> = Promise.resolve({ data: { user: { id: USER_ID } } }),
): MockClient {
    const client: MockClient = {
        auth: {
            getUser: vi.fn(() => authResult),
        },
        from: vi.fn((table: string) => {
            const next = routes[table]?.shift();
            if (!next) throw new Error(`Unexpected query for ${table}`);
            return next;
        }),
    };
    mocks.client = client;
    return client;
}

function cacheRecord(cachedFor: string, access: 'owner' | 'accepted_crew', cachedIdentity: VesselIdentity): void {
    localStorage.setItem(
        authScopedStorageKey(CACHE_KEY),
        JSON.stringify({
            version: 1,
            cached_for_user_id: cachedFor,
            access,
            identity: cachedIdentity,
        }),
    );
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope(USER_ID);
    mocks.client = null;
});

describe('VesselIdentityService hostile cache handling', () => {
    it('accepts a proven accepted-crew cache for only the account that produced it', () => {
        cacheRecord(USER_ID, 'accepted_crew', identity('captain-1'));

        expect(getCachedIdentity()?.owner_id).toBe('captain-1');

        setAuthIdentityScope('user-2');
        expect(getCachedIdentity()).toBeNull();
    });

    it('rejects malformed, account-mismatched, and access-mismatched cache records', () => {
        cacheRecord('other-user', 'owner', identity());
        expect(getCachedIdentity()).toBeNull();

        cacheRecord(USER_ID, 'accepted_crew', identity());
        expect(getCachedIdentity()).toBeNull();

        cacheRecord(USER_ID, 'owner', identity(USER_ID, { vessel_type: 'invalid' as 'sail' }));
        expect(getCachedIdentity()).toBeNull();
    });

    it('does not assign provenance to a raw scoped crew row from an older build', () => {
        localStorage.setItem(authScopedStorageKey(CACHE_KEY), JSON.stringify(identity('captain-1')));

        expect(getCachedIdentity()).toBeNull();
    });
});

describe('VesselIdentityService exact owner and crew resolution', () => {
    it('uses a validated owner row first and never performs a crew lookup', async () => {
        const ownerQuery = query({
            data: identity(USER_ID, {
                reg_number: null as unknown as string,
                hull_color: null as unknown as string,
            }),
            error: null,
        });
        const client = installClient({ vessel_identity: [ownerQuery] });

        const result = await syncIdentity();

        expect(result).toMatchObject({ owner_id: USER_ID, reg_number: '', hull_color: '' });
        expect(ownerQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('*'));
        expect(ownerQuery.eq).toHaveBeenCalledWith('owner_id', USER_ID);
        expect(client.from).not.toHaveBeenCalledWith('vessel_crew');
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey(CACHE_KEY)) ?? '{}')).toMatchObject({
            version: 1,
            cached_for_user_id: USER_ID,
            access: 'owner',
        });
    });

    it('fails closed when an owner-filtered query returns a different owner', async () => {
        cacheRecord(USER_ID, 'owner', identity());
        installClient({
            vessel_identity: [query({ data: identity('attacker'), error: null })],
        });

        expect(await syncIdentity()).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey(CACHE_KEY))).toBeNull();
    });

    it('rejects accessor-backed database rows without invoking their getters', async () => {
        const vesselNameGetter = vi.fn(() => 'Injected');
        const hostileRow = identity();
        Object.defineProperty(hostileRow, 'vessel_name', {
            enumerable: true,
            get: vesselNameGetter,
        });
        installClient({
            vessel_identity: [query({ data: hostileRow, error: null })],
        });

        expect(await syncIdentity()).toBeNull();
        expect(vesselNameGetter).not.toHaveBeenCalled();
        expect(getCachedIdentity()).toBeNull();
    });

    it('refuses to choose arbitrarily between multiple accepted vessels', async () => {
        cacheRecord(USER_ID, 'accepted_crew', identity('captain-old'));
        const client = installClient({
            vessel_identity: [query({ data: null, error: null })],
            vessel_crew: [
                query({
                    data: [
                        { owner_id: 'captain-1', crew_user_id: USER_ID, status: 'accepted' },
                        { owner_id: 'captain-2', crew_user_id: USER_ID, status: 'accepted' },
                    ],
                    error: null,
                }),
            ],
        });

        expect(await syncIdentity()).toBeNull();
        expect(client.from.mock.calls.filter(([table]) => table === 'vessel_identity')).toHaveLength(1);
        expect(localStorage.getItem(authScopedStorageKey(CACHE_KEY))).toBeNull();
    });

    it('resolves duplicate accepted membership rows when they identify one vessel', async () => {
        const crewQuery = query({
            data: [
                { owner_id: 'captain-1', crew_user_id: USER_ID, status: 'accepted' },
                { owner_id: 'captain-1', crew_user_id: USER_ID, status: 'accepted' },
            ],
            error: null,
        });
        const crewVesselQuery = query({ data: identity('captain-1'), error: null });
        installClient({
            vessel_identity: [query({ data: null, error: null }), crewVesselQuery],
            vessel_crew: [crewQuery],
        });

        const result = await syncIdentity();

        expect(result?.owner_id).toBe('captain-1');
        expect(crewQuery.select).toHaveBeenCalledWith('owner_id,crew_user_id,status');
        expect(crewQuery.eq).toHaveBeenCalledWith('crew_user_id', USER_ID);
        expect(crewQuery.eq).toHaveBeenCalledWith('status', 'accepted');
        expect(crewQuery.limit).toHaveBeenCalledWith(257);
        expect(crewVesselQuery.eq).toHaveBeenCalledWith('owner_id', 'captain-1');
        expect(JSON.parse(localStorage.getItem(authScopedStorageKey(CACHE_KEY)) ?? '{}')).toMatchObject({
            cached_for_user_id: USER_ID,
            access: 'accepted_crew',
            identity: { owner_id: 'captain-1' },
        });
    });

    it('rejects crew rows whose returned provenance contradicts the filters', async () => {
        const client = installClient({
            vessel_identity: [query({ data: null, error: null })],
            vessel_crew: [
                query({
                    data: [{ owner_id: 'captain-1', crew_user_id: 'someone-else', status: 'accepted' }],
                    error: null,
                }),
            ],
        });

        expect(await syncIdentity()).toBeNull();
        expect(client.from.mock.calls.filter(([table]) => table === 'vessel_identity')).toHaveLength(1);
    });
});

describe('VesselIdentityService generation fences', () => {
    it('discards an auth result completed after an account switch', async () => {
        const auth = deferred<unknown>();
        const client = installClient({}, auth.promise);
        const pending = syncIdentity();

        setAuthIdentityScope('user-2');
        auth.resolve({ data: { user: { id: USER_ID } } });

        await expect(pending).resolves.toBeNull();
        expect(client.from).not.toHaveBeenCalled();
    });

    it('does not inspect or cache an owner query completed after an account switch', async () => {
        const owner = deferred<QueryResult>();
        const ownerQuery = query(owner.promise);
        installClient({ vessel_identity: [ownerQuery] });
        const pending = syncIdentity();
        await vi.waitFor(() => expect(ownerQuery.maybeSingle).toHaveBeenCalled());

        setAuthIdentityScope('user-2');
        owner.resolve({ data: identity(), error: null });

        await expect(pending).resolves.toBeNull();
        setAuthIdentityScope(USER_ID);
        expect(getCachedIdentity()).toBeNull();
    });

    it('does not use a crew lookup completed after an account switch', async () => {
        const crew = deferred<QueryResult>();
        const client = installClient({
            vessel_identity: [query({ data: null, error: null })],
            vessel_crew: [query(crew.promise)],
        });
        const pending = syncIdentity();
        await vi.waitFor(() => expect(client.from).toHaveBeenCalledWith('vessel_crew'));

        setAuthIdentityScope('user-2');
        crew.resolve({
            data: [{ owner_id: 'captain-1', crew_user_id: USER_ID, status: 'accepted' }],
            error: null,
        });

        await expect(pending).resolves.toBeNull();
        expect(client.from.mock.calls.filter(([table]) => table === 'vessel_identity')).toHaveLength(1);
    });

    it('does not cache a crew vessel result completed after an account switch', async () => {
        const crewVessel = deferred<QueryResult>();
        const client = installClient({
            vessel_identity: [query({ data: null, error: null }), query(crewVessel.promise)],
            vessel_crew: [
                query({
                    data: [{ owner_id: 'captain-1', crew_user_id: USER_ID, status: 'accepted' }],
                    error: null,
                }),
            ],
        });
        const pending = syncIdentity();
        await vi.waitFor(() =>
            expect(client.from.mock.calls.filter(([table]) => table === 'vessel_identity')).toHaveLength(2),
        );

        setAuthIdentityScope('user-2');
        crewVessel.resolve({ data: identity('captain-1'), error: null });

        await expect(pending).resolves.toBeNull();
        setAuthIdentityScope(USER_ID);
        expect(getCachedIdentity()).toBeNull();
    });
});

describe('VesselIdentityService hostile save handling', () => {
    it('rejects runtime payloads that try to smuggle immutable ownership fields', async () => {
        const client = installClient({});
        const hostile = {
            vessel_name: 'Looks legitimate',
            owner_id: 'attacker',
            id: 'attacker-row',
            updated_at: '1900-01-01T00:00:00.000Z',
        } as unknown as Parameters<typeof saveIdentity>[0];

        await expect(saveIdentity(hostile)).resolves.toBeNull();
        expect(client.auth.getUser).not.toHaveBeenCalled();
        expect(client.from).not.toHaveBeenCalled();
    });

    it('writes only allow-listed fields and the authenticated owner', async () => {
        const saveQuery = query({ data: identity(), error: null });
        installClient({ vessel_identity: [saveQuery] });

        const result = await saveIdentity({ vessel_name: 'Safe Name', vessel_type: 'power' });

        expect(result?.owner_id).toBe(USER_ID);
        expect(saveQuery.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                vessel_name: 'Safe Name',
                vessel_type: 'power',
                owner_id: USER_ID,
                updated_at: expect.any(String),
            }),
            { onConflict: 'owner_id' },
        );
        const payload = saveQuery.upsert.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('id');
    });

    it('rejects accessor payloads without invoking hostile getters', async () => {
        const getter = vi.fn(() => 'Surprise');
        const hostile = {};
        Object.defineProperty(hostile, 'vessel_name', { enumerable: true, get: getter });
        const client = installClient({});

        await expect(saveIdentity(hostile as Parameters<typeof saveIdentity>[0])).resolves.toBeNull();
        expect(getter).not.toHaveBeenCalled();
        expect(client.auth.getUser).not.toHaveBeenCalled();
    });

    it('rejects oversized runtime strings before authentication or persistence', async () => {
        const client = installClient({});

        await expect(saveIdentity({ vessel_name: 'x'.repeat(4097) })).resolves.toBeNull();
        expect(client.auth.getUser).not.toHaveBeenCalled();
        expect(client.from).not.toHaveBeenCalled();
    });

    it('rejects a save response not owned by the authenticated account', async () => {
        const saveQuery = query({ data: identity('attacker'), error: null });
        installClient({ vessel_identity: [saveQuery] });

        await expect(saveIdentity({ vessel_name: 'Safe Name' })).resolves.toBeNull();
        expect(getCachedIdentity()).toBeNull();
    });

    it('discards a save result completed after an account switch', async () => {
        const save = deferred<QueryResult>();
        const saveQuery = query(save.promise);
        installClient({ vessel_identity: [saveQuery] });
        const pending = saveIdentity({ vessel_name: 'Safe Name' });
        await vi.waitFor(() => expect(saveQuery.single).toHaveBeenCalled());

        setAuthIdentityScope('user-2');
        save.resolve({ data: identity(), error: null });

        await expect(pending).resolves.toBeNull();
        setAuthIdentityScope(USER_ID);
        expect(getCachedIdentity()).toBeNull();
    });
});
