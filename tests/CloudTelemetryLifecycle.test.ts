import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    user: vi.fn(),
    ingest: vi.fn(),
    clear: vi.fn(),
    state: vi.fn(),
    warn: vi.fn(),
}));
vi.mock('../services/supabase', () => ({
    supabase: { from: vi.fn(() => ({ select: vi.fn(() => ({ order: vi.fn(() => ({ limit: mocks.query })) })) })) },
    getCurrentUserId: mocks.user,
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { getState: mocks.state, ingestRemote: mocks.ingest, clearRemote: mocks.clear },
}));
vi.mock('../services/PiTelemetryService', () => ({ PiTelemetryService: { isPresent: () => false } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => false }));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { CloudTelemetryService } from '../services/CloudTelemetryService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null };
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const result = (owner = 'owner-a'): QueryResult => ({
    data: [
        {
            owner_id: owner,
            boat_id: `boat-${owner}`,
            source: 'pi',
            device_label: owner,
            reported_at: new Date().toISOString(),
            tws_kts: 12,
        },
    ],
    error: null,
});
const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe('cloud telemetry account and reader lifecycle fences', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-09-10T00:00:00Z');
        CloudTelemetryService.release();
        setAuthIdentityScope('owner-a');
        vi.clearAllMocks();
        mocks.state.mockReturnValue({ connectionStatus: 'disconnected' });
        mocks.user.mockImplementation(async () => getAuthIdentityScope().userId);
        mocks.query.mockResolvedValue(result());
    });
    afterEach(() => {
        CloudTelemetryService.release();
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('does not resurrect a cloud feed after the final screen release', async () => {
        const old = deferred<QueryResult>();
        mocks.query.mockReturnValueOnce(old.promise);
        CloudTelemetryService.retain();
        await flush();
        expect(mocks.query).toHaveBeenCalledTimes(1);
        CloudTelemetryService.release();
        old.resolve(result());
        await flush();
        expect(mocks.ingest).not.toHaveBeenCalled();
        expect(CloudTelemetryService.getLatest()).toBeNull();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(mocks.query).toHaveBeenCalledTimes(1);
    });

    it('fences a pending user resolution before starting any old query', async () => {
        const user = deferred<string | null>();
        mocks.user.mockReturnValueOnce(user.promise);
        CloudTelemetryService.retain();
        setAuthIdentityScope('owner-b');
        user.resolve('owner-a');
        await flush();
        expect(mocks.query).not.toHaveBeenCalled();
        expect(mocks.ingest).not.toHaveBeenCalled();
    });

    it.each([null, 'owner-b'])('cannot reinsert owner-a history after auth switches to %s', async (owner) => {
        const old = deferred<QueryResult>();
        mocks.query.mockReturnValueOnce(old.promise);
        CloudTelemetryService.retain();
        await flush();
        setAuthIdentityScope(owner);
        old.resolve(result('owner-a'));
        await flush();
        expect(mocks.ingest).not.toHaveBeenCalled();
        expect(CloudTelemetryService.getLatest()).toBeNull();
    });

    it('restart can read immediately while an old request is stuck; old finally cannot unlock the new request', async () => {
        const old = deferred<QueryResult>();
        const next = deferred<QueryResult>();
        mocks.query.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        CloudTelemetryService.retain();
        await flush();
        CloudTelemetryService.release();
        CloudTelemetryService.retain();
        await flush();
        expect(mocks.query).toHaveBeenCalledTimes(2);
        old.resolve(result('old-account'));
        await flush();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mocks.query).toHaveBeenCalledTimes(2);
        expect(mocks.ingest).not.toHaveBeenCalled();
        next.resolve(result());
        await flush();
        expect(mocks.ingest).toHaveBeenCalledTimes(1);
        expect(CloudTelemetryService.getLatest()?.ownerId).toBe('owner-a');
    });

    it('a new identity resumes on the existing schedule without waiting for its predecessor', async () => {
        const old = deferred<QueryResult>();
        mocks.query.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result('owner-b'));
        CloudTelemetryService.retain();
        await flush();
        setAuthIdentityScope('owner-b');
        expect(mocks.query).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(CloudTelemetryService.getLatest()?.ownerId).toBe('owner-b');
        expect(mocks.ingest).toHaveBeenCalledTimes(1);
        old.reject(new Error('obsolete request failure'));
        await flush();
        expect(CloudTelemetryService.getLatest()?.ownerId).toBe('owner-b');
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    it('late query error results are discarded after release', async () => {
        const old = deferred<QueryResult>();
        mocks.query.mockReturnValueOnce(old.promise);
        CloudTelemetryService.retain();
        await flush();
        CloudTelemetryService.release();
        old.resolve({ data: null, error: { message: 'old forbidden request' } });
        await flush();
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(mocks.ingest).not.toHaveBeenCalled();
    });

    it('a valid retained read publishes fresh telemetry once; multiple readers share one poller', async () => {
        CloudTelemetryService.retain();
        CloudTelemetryService.retain();
        await flush();
        expect(mocks.query).toHaveBeenCalledTimes(1);
        expect(mocks.ingest).toHaveBeenCalledTimes(1);
        expect(CloudTelemetryService.getLatest()?.snapshot.twsKts).toBe(12);
        CloudTelemetryService.release();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mocks.query).toHaveBeenCalledTimes(2);
    });

    it('one-shot reads remain independent of retention and never feed the instrument store', async () => {
        const reading = await CloudTelemetryService.readOnce();
        expect(reading?.ownerId).toBe('owner-a');
        expect(mocks.ingest).not.toHaveBeenCalled();
        expect(CloudTelemetryService.getLatest()).toBeNull();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(mocks.query).toHaveBeenCalledTimes(1);
    });

    it('one-shot reads also discard a previous identity response', async () => {
        const old = deferred<QueryResult>();
        mocks.query.mockReturnValueOnce(old.promise);
        const reading = CloudTelemetryService.readOnce();
        await flush();
        setAuthIdentityScope('owner-b');
        old.resolve(result());
        expect(await reading).toBeNull();
        expect(mocks.ingest).not.toHaveBeenCalled();
    });

    it('a subscriber releasing the last reader cannot be followed by late store ingestion', async () => {
        const unsubscribe = CloudTelemetryService.subscribe((latest) => {
            if (latest) CloudTelemetryService.release();
        });
        try {
            CloudTelemetryService.retain();
            await flush();
            expect(CloudTelemetryService.getLatest()).toBeNull();
            expect(mocks.ingest).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
    });
});
