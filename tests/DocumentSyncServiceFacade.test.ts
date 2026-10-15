import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncQueueItem } from '../services/vessel/LocalDatabase';

const mocks = vi.hoisted(() => ({
    syncNow: vi.fn(),
    getSyncStatus: vi.fn(),
    syncListeners: [] as (() => void)[],
    outboxListeners: [] as ((table: string) => void)[],
    getFullQueue: vi.fn(),
    cloudFrom: vi.fn(),
    storageFrom: vi.fn(),
    createSignedUrl: vi.fn(),
    removeStorageObject: vi.fn(),
}));

vi.mock('../services/vessel/SyncService', () => ({
    syncNow: mocks.syncNow,
    getSyncStatus: mocks.getSyncStatus,
    onSyncComplete: (listener: () => void) => {
        mocks.syncListeners.push(listener);
        return () => {
            mocks.syncListeners = mocks.syncListeners.filter((candidate) => candidate !== listener);
        };
    },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: mocks.getFullQueue,
    onOutboxAppended: (listener: (table: string) => void) => {
        mocks.outboxListeners.push(listener);
        return () => {
            mocks.outboxListeners = mocks.outboxListeners.filter((candidate) => candidate !== listener);
        };
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: mocks.cloudFrom,
        storage: {
            from: mocks.storageFrom,
        },
    },
}));

async function loadService() {
    vi.resetModules();
    const module = await import('../services/vessel/DocumentSyncService');
    return module.DocumentSyncService;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((fulfil) => {
        resolve = fulfil;
    });
    return { promise, resolve };
}

let queueSerial = 0;
/** One outbox entry, as LocalDatabase keeps it. */
function queued(
    recordId: string,
    status: SyncQueueItem['status'] = 'pending',
    extra: Partial<SyncQueueItem> = {},
): SyncQueueItem {
    queueSerial += 1;
    return {
        id: `queue-${queueSerial}`,
        table_name: 'ship_documents',
        record_id: recordId,
        mutation_type: 'UPDATE',
        payload: '{}',
        created_at: '2026-10-14T01:00:00.000Z',
        status,
        retry_count: status === 'failed' ? 1 : 0,
        owner_user_id: 'user-a',
        ...extra,
    };
}

describe('DocumentSyncService canonical sync facade', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        mocks.syncNow.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
        mocks.getSyncStatus.mockReturnValue('idle');
        mocks.syncListeners = [];
        mocks.outboxListeners = [];
        mocks.getFullQueue.mockReturnValue([]);
        mocks.createSignedUrl.mockResolvedValue({
            data: { signedUrl: 'https://signed.example/document.pdf' },
            error: null,
        });
        mocks.storageFrom.mockReturnValue({
            createSignedUrl: mocks.createSignedUrl,
            remove: mocks.removeStorageObject,
        });
    });

    it('does not start a second sync engine or touch remote rows when imported', async () => {
        const addEventListener = vi.spyOn(window, 'addEventListener');
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        await loadService();
        await Promise.resolve();

        expect(mocks.syncNow).not.toHaveBeenCalled();
        expect(mocks.syncListeners).toHaveLength(0);
        expect(mocks.outboxListeners).toHaveLength(0);
        expect(mocks.cloudFrom).not.toHaveBeenCalled();
        expect(mocks.storageFrom).not.toHaveBeenCalled();
        expect(addEventListener).not.toHaveBeenCalled();
        expect(setTimeoutSpy).not.toHaveBeenCalled();

        addEventListener.mockRestore();
        setTimeoutSpy.mockRestore();
    });

    it('refreshes a private download URL without deleting a remote row or storage object', async () => {
        const service = await loadService();
        const staleUrl =
            'https://project.supabase.co/storage/v1/object/sign/vessel_vault/user/documents/doc-1.pdf?token=old';

        await expect(service.getDownloadUrl(staleUrl)).resolves.toBe('https://signed.example/document.pdf');

        expect(mocks.storageFrom).toHaveBeenCalledWith('vessel_vault');
        expect(mocks.createSignedUrl).toHaveBeenCalledWith('user/documents/doc-1.pdf', 60 * 60);
        expect(mocks.removeStorageObject).not.toHaveBeenCalled();
        expect(mocks.cloudFrom).not.toHaveBeenCalled();
    });

    it('resolves a stable private-bucket reference with a one-hour URL', async () => {
        const service = await loadService();

        await expect(
            service.getDownloadUrl('supabase-storage://vessel_vault/user-a/documents/doc-1.pdf'),
        ).resolves.toBe('https://signed.example/document.pdf');

        expect(mocks.createSignedUrl).toHaveBeenCalledWith('user-a/documents/doc-1.pdf', 60 * 60);
    });

    it('severs the reserved tab opener and applies no-referrer before navigating a document', async () => {
        const replace = vi.fn();
        const close = vi.fn();
        const head = document.createElement('head');
        const pendingWindow = {
            opener: window,
            document: {
                createElement: document.createElement.bind(document),
                head,
            },
            location: { replace },
            close,
        };
        const open = vi.spyOn(window, 'open').mockReturnValue(pendingWindow as unknown as Window);
        const service = await loadService();

        await service.openDownload('https://documents.example.test/manual.pdf');

        expect(open).toHaveBeenCalledWith('about:blank', '_blank');
        expect(pendingWindow.opener).toBeNull();
        expect(head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
        expect(replace).toHaveBeenCalledWith('https://documents.example.test/manual.pdf');
        expect(close).not.toHaveBeenCalled();
    });

    it('closes the reserved tab instead of navigating a scriptable document URI', async () => {
        const replace = vi.fn();
        const close = vi.fn();
        const pendingWindow = {
            opener: window,
            document: {
                createElement: document.createElement.bind(document),
                head: document.createElement('head'),
            },
            location: { replace },
            close,
        };
        vi.spyOn(window, 'open').mockReturnValue(pendingWindow as unknown as Window);
        const service = await loadService();

        await expect(service.openDownload('data:text/html,<script>globalThis.pwned=1</script>')).rejects.toThrow(
            'Unsafe document URL',
        );

        expect(replace).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });

    it('rejects a cleartext public document while preserving explicit boat-LAN support', async () => {
        const replace = vi.fn();
        const close = vi.fn();
        const pendingWindow = {
            opener: window,
            document: {
                createElement: document.createElement.bind(document),
                head: document.createElement('head'),
            },
            location: { replace },
            close,
        };
        vi.spyOn(window, 'open').mockReturnValue(pendingWindow as unknown as Window);
        const service = await loadService();

        await expect(service.openDownload('http://documents.example.test/manual.pdf')).rejects.toThrow(
            'Unsafe document URL',
        );

        expect(replace).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });

    it('keeps no status of its own: nothing in localStorage, and no full pull to restore with', async () => {
        const service = await loadService();
        mocks.getFullQueue.mockReturnValue([queued('doc-a')]);

        service.uploadStates();

        expect(localStorage.length).toBe(0);
        expect('pullFromCloud' in service).toBe(false);
        expect('pendingCount' in service).toBe(false);
    });
});

/**
 * What has not uploaded yet, from the outbox itself (131-B9, binder audit
 * DOC-8 and DOC-9).
 */
describe('DocumentSyncService upload states', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.syncNow.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
        mocks.getSyncStatus.mockReturnValue('idle');
        mocks.syncListeners = [];
        mocks.outboxListeners = [];
        mocks.getFullQueue.mockReturnValue([]);
    });

    it("lists each paper the outbox still holds, waiting (queued or being pushed), and no other table's", async () => {
        const service = await loadService();
        mocks.getFullQueue.mockReturnValue([
            queued('doc-new', 'pending', { mutation_type: 'INSERT' }),
            queued('doc-new', 'pending'),
            queued('doc-pushing', 'syncing'),
            queued('stores-1', 'failed', { table_name: 'inventory_items', error_message: 'Failed to fetch' }),
        ]);

        expect(service.uploadStates()).toEqual({
            'doc-new': { failed: false },
            'doc-pushing': { failed: false },
        });
    });

    it('a refused paper is failed, with the first refusal as its reason in plain words', async () => {
        const service = await loadService();
        mocks.getFullQueue.mockReturnValue([
            queued('doc-big', 'pending', { mutation_type: 'INSERT' }),
            queued('doc-big', 'failed', {
                error_message: 'File upload failed: The object exceeded the maximum allowed size',
            }),
            // Fenced behind the refusal: still pending, never the reason.
            queued('doc-big', 'pending'),
            queued('doc-big', 'failed', { error_message: 'Failed to fetch' }),
        ]);

        expect(service.uploadStates()).toEqual({
            'doc-big': { failed: true, reason: 'the file is too big for the cloud' },
        });
    });

    it('says nothing while the database is switching accounts', async () => {
        const service = await loadService();
        mocks.getFullQueue.mockImplementation(() => {
            throw new Error('LocalDB not initialized');
        });

        expect(service.uploadStates()).toEqual({});
    });

    it("tells its listener when a cycle ends or a paper's change is queued, not another table's", async () => {
        const service = await loadService();
        const listener = vi.fn();
        const stop = service.onUploadsChanged(listener);

        mocks.syncListeners.forEach((notify) => notify());
        mocks.outboxListeners.forEach((notify) => notify('ship_documents'));
        mocks.outboxListeners.forEach((notify) => notify('inventory_items'));
        expect(listener).toHaveBeenCalledTimes(2);

        stop();
        expect(mocks.syncListeners).toHaveLength(0);
        expect(mocks.outboxListeners).toHaveLength(0);
    });

    it('retry runs one sync cycle now, through the engine', async () => {
        const service = await loadService();

        await service.retryUploads();

        expect(mocks.syncNow).toHaveBeenCalledTimes(1);
        expect(mocks.cloudFrom).not.toHaveBeenCalled();
    });

    it('retry during a cycle waits it out, then runs one that starts after the tap', async () => {
        const running = deferred<{ pushed: number; pulled: number; errors: string[] }>();
        mocks.getSyncStatus.mockReturnValue('syncing');
        mocks.syncNow.mockReturnValueOnce(running.promise);
        const service = await loadService();

        const retry = service.retryUploads();
        await Promise.resolve();
        expect(mocks.syncNow).toHaveBeenCalledTimes(1);

        running.resolve({ pushed: 0, pulled: 0, errors: ['ship_documents/doc-1: Failed to fetch'] });
        await retry;
        expect(mocks.syncNow).toHaveBeenCalledTimes(2);
    });
});

describe('uploadFailureReason', () => {
    it.each([
        ['File upload failed: The object exceeded the maximum allowed size', 'the file is too big for the cloud'],
        ['File upload failed: Payload too large', 'the file is too big for the cloud'],
        ['Local attachment missing', 'its file is no longer on this phone'],
        ['Could not read local attachment (404)', "its file on this phone couldn't be read"],
        ['Local attachment was empty or unreadable', "its file on this phone couldn't be read"],
        ['TypeError: Failed to fetch', 'the connection dropped'],
        ['Load failed', 'the connection dropped'],
        ['NetworkError when attempting to fetch resource.', 'the connection dropped'],
        ['File upload failed: Failed to fetch', 'the connection dropped'],
        ['JWT expired', 'you need to sign in again'],
        ['Not authenticated', 'you need to sign in again'],
        ['Auth session missing!', 'you need to sign in again'],
        ['Authenticated user does not match the local database identity', 'you need to sign in again'],
        [
            'new row violates row-level security policy for table "ship_documents"',
            "the cloud didn't allow it for this account",
        ],
        ['permission denied for table ship_documents', "the cloud didn't allow it for this account"],
        ['Record not found or update not authorized', "the cloud didn't accept it"],
        ['Attachment cleanup failed: Object not found', "the cloud's old copy of the file couldn't be cleared"],
        ['invalid input value for enum document_category: "Manuals"', "the cloud didn't accept it"],
        [undefined, "the cloud didn't accept it"],
    ])('%s -> %s', async (message, reason) => {
        const { uploadFailureReason } = await import('../services/vessel/DocumentSyncService');
        expect(uploadFailureReason(message)).toBe(reason);
    });
});
