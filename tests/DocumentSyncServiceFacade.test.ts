import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    syncNow: vi.fn(),
    forceFullPull: vi.fn(),
    getAll: vi.fn(),
    getFullQueue: vi.fn(),
    cloudFrom: vi.fn(),
    storageFrom: vi.fn(),
    createSignedUrl: vi.fn(),
    removeStorageObject: vi.fn(),
    identity: 'user-a' as string | null,
}));

vi.mock('../services/vessel/SyncService', () => ({
    syncNow: mocks.syncNow,
    forceFullPull: mocks.forceFullPull,
}));

vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: {
        getAll: mocks.getAll,
    },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: mocks.getFullQueue,
    getLocalDatabaseIdentity: () => mocks.identity,
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

describe('DocumentSyncService canonical sync facade', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        mocks.syncNow.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
        mocks.forceFullPull.mockResolvedValue(0);
        mocks.getAll.mockReturnValue([]);
        mocks.getFullQueue.mockReturnValue([]);
        mocks.identity = 'user-a';
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
        expect(mocks.forceFullPull).not.toHaveBeenCalled();
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

    it('keeps document sync status isolated across account switches', async () => {
        const service = await loadService();
        service.markForSync('doc-a');
        await vi.waitFor(() => expect(service.getStatus('doc-a')).toBe('synced'));

        mocks.identity = 'user-b';
        expect(service.getAllStatuses()).toEqual({});
        service.markForSync('doc-b');
        await vi.waitFor(() => expect(service.getStatus('doc-b')).toBe('synced'));

        mocks.identity = 'user-a';
        expect(service.getAllStatuses()).toEqual({
            'doc-a': expect.objectContaining({ status: 'synced' }),
        });
        expect(service.getAllStatuses()).not.toHaveProperty('doc-b');
    });

    it('restores through the canonical full pull and counts newly materialized document IDs', async () => {
        const service = await loadService();
        const localDocument = { id: 'doc-local' };
        const restoredDocument = { id: 'doc-cloud' };
        mocks.getAll.mockReturnValueOnce([localDocument]).mockReturnValueOnce([localDocument, restoredDocument]);
        // The generic engine may pull rows from many vessel tables. Its count
        // must not be presented as the number of restored documents.
        mocks.forceFullPull.mockResolvedValue(19);

        await expect(service.pullFromCloud()).resolves.toBe(1);

        expect(mocks.forceFullPull).toHaveBeenCalledTimes(1);
        expect(mocks.getAll).toHaveBeenCalledTimes(2);
        expect(service.getStatus('doc-cloud')).toBe('synced');
        expect(mocks.cloudFrom).not.toHaveBeenCalled();
    });

    it('delegates pending writes to the generic engine and reflects a successful cycle', async () => {
        const cycle = deferred<{ pushed: number; pulled: number; errors: string[] }>();
        mocks.syncNow.mockReturnValueOnce(cycle.promise);
        const service = await loadService();

        service.markForSync('doc-1');

        expect(mocks.syncNow).toHaveBeenCalledTimes(1);
        expect(service.getStatus('doc-1')).toBe('uploading');

        cycle.resolve({ pushed: 1, pulled: 0, errors: [] });
        await vi.waitFor(() => expect(service.getStatus('doc-1')).toBe('synced'));
        expect(service.pendingCount).toBe(0);
    });

    it('uses the document outbox rather than unrelated table errors for status', async () => {
        mocks.syncNow.mockResolvedValue({
            pushed: 0,
            pulled: 0,
            errors: ['maintenance_tasks: upstream unavailable'],
        });
        const service = await loadService();

        service.markForSync('doc-1');

        await vi.waitFor(() => expect(service.getStatus('doc-1')).toBe('synced'));
    });

    it('keeps a newer same-document generation pending when an older cycle finishes', async () => {
        const firstCycle = deferred<{ pushed: number; pulled: number; errors: string[] }>();
        const secondCycle = deferred<{ pushed: number; pulled: number; errors: string[] }>();
        mocks.syncNow.mockReturnValueOnce(firstCycle.promise).mockReturnValueOnce(secondCycle.promise);
        const service = await loadService();

        service.markForSync('doc-1');
        service.markForSync('doc-1');
        mocks.getFullQueue.mockReturnValueOnce([
            {
                table_name: 'ship_documents',
                record_id: 'doc-1',
                status: 'pending',
            },
        ]);
        firstCycle.resolve({ pushed: 1, pulled: 0, errors: [] });

        await vi.waitFor(() => expect(mocks.syncNow).toHaveBeenCalledTimes(2));
        expect(service.getStatus('doc-1')).toBe('uploading');
        secondCycle.resolve({ pushed: 1, pulled: 0, errors: [] });
        await vi.waitFor(() => expect(service.getStatus('doc-1')).toBe('synced'));
    });

    it('contains a local database bootstrap race during restore', async () => {
        mocks.getAll.mockImplementationOnce(() => {
            throw new Error('LocalDB not initialized');
        });
        const service = await loadService();

        await expect(service.pullFromCloud()).resolves.toBe(0);
        expect(mocks.forceFullPull).not.toHaveBeenCalled();
    });

    it('propagates only the explicit queued delete through the generic engine', async () => {
        const service = await loadService();

        service.markDeleted('doc-absent-locally');

        await vi.waitFor(() => expect(mocks.syncNow).toHaveBeenCalledTimes(1));
        expect(mocks.cloudFrom).not.toHaveBeenCalled();
        expect(mocks.removeStorageObject).not.toHaveBeenCalled();
    });

    it('serializes a mutation arriving during sync into one canonical follow-up cycle', async () => {
        const firstCycle = deferred<{ pushed: number; pulled: number; errors: string[] }>();
        mocks.syncNow
            .mockReturnValueOnce(firstCycle.promise)
            .mockResolvedValueOnce({ pushed: 1, pulled: 0, errors: [] });
        const service = await loadService();

        service.markForSync('doc-1');
        service.markForSync('doc-2');

        expect(mocks.syncNow).toHaveBeenCalledTimes(1);

        firstCycle.resolve({ pushed: 1, pulled: 0, errors: [] });
        await vi.waitFor(() => expect(mocks.syncNow).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(service.getStatus('doc-2')).toBe('synced'));
    });
});
