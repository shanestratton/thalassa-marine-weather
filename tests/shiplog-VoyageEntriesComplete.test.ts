import { beforeEach, describe, expect, it, vi } from 'vitest';

type Response = { data: unknown; error: { message: string } | null };
const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    getCurrentUserId: vi.fn(),
    archiveIntents: vi.fn(),
    filterTombstones: vi.fn(),
    overlayArchive: vi.fn(),
    responses: [] as Array<Promise<Response>>,
    ranges: [] as Array<[number, number]>,
}));

vi.mock('../services/supabase', () => ({
    supabase: { from: (...args: unknown[]) => mocks.from(...args) },
    getCurrentUserId: () => mocks.getCurrentUserId(),
}));
vi.mock('../services/shiplog/VoyageSummaryCache', () => ({
    getCachedSummaries: vi.fn(),
    setCachedSummaries: vi.fn(),
}));
vi.mock('../services/shiplog/OfflineQueue', () => ({
    getVoyageArchiveIntentSnapshot: (...args: unknown[]) => mocks.archiveIntents(...args),
    filterVoyageTombstonedEntries: (...args: unknown[]) => mocks.filterTombstones(...args),
    applyVoyageArchiveIntentOverlay: (...args: unknown[]) => mocks.overlayArchive(...args),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getVoyageEntries } from '../services/shiplog/VoyageSummary';
import { fromDbFormat, toDbFormat } from '../services/shiplog/helpers';

const strict = { throwOnIncomplete: true };
const row = (index = 0): Record<string, unknown> => ({
    id: `entry-${index}`,
    client_operation_id: `capture-${index}`,
    user_id: 'owner-a',
    voyage_id: 'trip-a',
    timestamp: new Date(Date.UTC(2026, 8, 25, 0, 0, index)).toISOString(),
    latitude: -20.1,
    longitude: 148.8,
    speed_kts: 0.1,
    cumulative_distance_nm: 0,
    entry_type: 'auto',
    source: 'device',
    archived: false,
});

function page(data: unknown, error: Response['error'] = null) {
    mocks.responses.push(Promise.resolve({ data, error }));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.resetAllMocks();
    setAuthIdentityScope('owner-a');
    mocks.getCurrentUserId.mockResolvedValue('owner-a');
    mocks.archiveIntents.mockResolvedValue([]);
    mocks.filterTombstones.mockImplementation(async (entries: unknown[]) => entries);
    mocks.overlayArchive.mockImplementation(async (entries: unknown[]) => entries);
    mocks.responses.length = 0;
    mocks.ranges.length = 0;
    mocks.from.mockImplementation(() => {
        const response = mocks.responses.shift() ?? Promise.resolve({ data: [], error: null });
        const query = {
            select: () => query,
            eq: () => query,
            or: () => query,
            order: () => query,
            abortSignal: () => query,
            range: (start: number, end: number) => {
                mocks.ranges.push([start, end]);
                return query;
            },
            then: response.then.bind(response),
        };
        return query;
    });
});

describe('strict complete voyage history reads', () => {
    it('distinguishes a valid empty cloud history from a failed request', async () => {
        page([]);
        await expect(getVoyageEntries('trip-a', true, strict)).resolves.toEqual([]);
        page(null, { message: 'offline' });
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('history page');
    });

    it('returns all valid rows and capture operation IDs', async () => {
        page([row()]);
        await expect(getVoyageEntries('trip-a', true, strict)).resolves.toEqual([
            expect.objectContaining({ id: 'entry-0', clientOperationId: 'capture-0' }),
        ]);
    });

    it('implies completeness even when requireComplete is explicitly false', async () => {
        page(Array.from({ length: 1000 }, (_, index) => row(index)));
        page(null, { message: 'connection dropped' });
        await expect(getVoyageEntries('trip-a', true, { ...strict, requireComplete: false })).rejects.toThrow(
            'history page',
        );
        expect(mocks.filterTombstones).not.toHaveBeenCalled();
    });

    it('rejects a full hard cap rather than calling a truncated history complete', async () => {
        page([row(), row(1)]);
        await expect(getVoyageEntries('trip-a', true, { ...strict, maxRows: 2 })).rejects.toThrow('row limit');
        expect(mocks.ranges).toEqual([[0, 1]]);
        expect(mocks.filterTombstones).not.toHaveBeenCalled();
    });

    it('accepts a complete history below the cap', async () => {
        page([row()]);
        await expect(getVoyageEntries('trip-a', true, { ...strict, maxRows: 2 })).resolves.toHaveLength(1);
    });

    it.each([null, {}, 'not a page'])('rejects invalid page payload %j, not a successful empty read', async (data) => {
        page(data);
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('invalid history response');
    });

    it.each([
        null,
        [],
        {},
        { ...row(), id: '' },
        { ...row(), timestamp: 'invalid' },
        { ...row(), latitude: null },
        { ...row(), longitude: 181 },
        { ...row(), speed_kts: '0.1' },
        { ...row(), cumulative_distance_nm: Number.NaN },
        { ...row(), entry_type: 'unexpected' },
        { ...row(), source: 'unknown' },
        { ...row(), archived: 'false' },
    ])('rejects malformed row %j before it can be used as stationary evidence', async (entry) => {
        page([entry]);
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('malformed history row');
        expect(mocks.filterTombstones).not.toHaveBeenCalled();
    });

    it.each([{ user_id: 'owner-b' }, { voyage_id: 'trip-b' }])('rejects owner/voyage mismatch %j', async (patch) => {
        page([{ ...row(), ...patch }]);
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('another owner or voyage');
    });

    it('rejects oversized responses and duplicate rows', async () => {
        page([row(), row(1), row(2)]);
        await expect(getVoyageEntries('trip-a', true, { ...strict, maxRows: 2 })).rejects.toThrow('exceeded');
        page([row(), row()]);
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('repeated rows');
    });

    it('rejects session mismatch before reading rows', async () => {
        mocks.getCurrentUserId.mockResolvedValue('owner-b');
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('session changed');
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('rejects absent authentication and invalid caps', async () => {
        await expect(getVoyageEntries('trip-a', true, { ...strict, maxRows: 0 })).rejects.toThrow('row limit');
        setAuthIdentityScope(null);
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('no readable session');
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('rejects a delayed result after the account changes', async () => {
        const pending = deferred<Response>();
        mocks.responses.push(pending.promise);
        const request = getVoyageEntries('trip-a', true, strict);
        const rejected = expect(request).rejects.toThrow('session changed');
        await vi.waitFor(() => expect(mocks.from).toHaveBeenCalledOnce());
        setAuthIdentityScope('owner-b');
        pending.resolve({ data: [row()], error: null });
        await rejected;
        expect(mocks.filterTombstones).not.toHaveBeenCalled();
    });

    it('rejects cancellation even if the transport ignores the abort', async () => {
        const pending = deferred<Response>();
        const controller = new AbortController();
        mocks.responses.push(pending.promise);
        const request = getVoyageEntries('trip-a', true, { ...strict, signal: controller.signal });
        const rejected = expect(request).rejects.toThrow('cancelled');
        await vi.waitFor(() => expect(mocks.from).toHaveBeenCalledOnce());
        controller.abort();
        pending.resolve({ data: [], error: null });
        await rejected;
    });

    it('does not disguise transport or durable local truth failures as empty history', async () => {
        mocks.from.mockImplementationOnce(() => {
            throw new Error('transport offline');
        });
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('transport offline');
        mocks.archiveIntents.mockRejectedValueOnce(new Error('local ledger unreadable'));
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('local ledger unreadable');
        mocks.filterTombstones.mockRejectedValueOnce(new Error('delete ledger unreadable'));
        page([row()]);
        await expect(getVoyageEntries('trip-a', true, strict)).rejects.toThrow('delete ledger unreadable');
    });

    it('preserves fail-closed/default behavior for existing callers', async () => {
        page(null);
        await expect(getVoyageEntries('trip-a')).resolves.toEqual([]);
        page([row(), row(1)]);
        await expect(getVoyageEntries('trip-a', false, { maxRows: 2, requireComplete: true })).resolves.toEqual([]);
        page(null, { message: 'offline' });
        await expect(getVoyageEntries('trip-a', false, { requireComplete: true })).resolves.toEqual([]);
    });
});

describe('capture operation identity read-back', () => {
    it('maps a cloud operation ID without exposing it as a writable DB field', () => {
        const entry = fromDbFormat(row());
        expect(entry.clientOperationId).toBe('capture-0');
        expect(toDbFormat(entry)).not.toHaveProperty('client_operation_id');
        expect(toDbFormat(entry)).not.toHaveProperty('clientOperationId');
    });

    it.each([null, undefined, '', 42])('ignores absent/malformed optional operation ID %j', (value) => {
        expect(fromDbFormat({ ...row(), client_operation_id: value }).clientOperationId).toBeUndefined();
    });
});
