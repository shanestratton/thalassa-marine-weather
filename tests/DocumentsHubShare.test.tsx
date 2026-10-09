/**
 * Sharing Ship's Documents (binder audit 2026-10-09, DOC-4): a synced photo of
 * a paper goes out as the picture it is, two papers with one name go out as two
 * files, and the copies made for the share sheet (passports among them) are
 * cleared from the phone's cache once it closes, shared, cancelled or failed.
 *
 * The real page and its file code over an in-memory filesystem; the share
 * sheet, the signed-URL service and the network are fakes. Fictional papers on
 * the fictional 'Kestrel'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipDocument } from '../types';

const hoisted = vi.hoisted(() => ({
    docs: [] as ShipDocument[],
    share: vi.fn(),
    logWarn: vi.fn(),
}));

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/share', () => ({ Share: { share: hoisted.share } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: hoisted.logWarn, error: vi.fn() }),
}));
vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: {
        getAll: () => hoisted.docs,
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));
// The signed URL storage-js returns: the object path, then a JWT token "a.b.c".
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        getDownloadUrl: vi.fn(
            async (uri: string) =>
                uri.replace(
                    'supabase-storage://vessel_vault/',
                    'https://example-project.supabase.co/storage/v1/object/sign/vessel_vault/',
                ) + '?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ4In0.c2lnbmF0dXJl',
        ),
        openDownload: vi.fn(),
        pullFromCloud: vi.fn().mockResolvedValue(0),
        markForSync: vi.fn(),
        markDeleted: vi.fn(),
        pendingCount: 0,
    },
}));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestCatchUpSync: vi.fn(),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { memoryFs } from './helpers/memoryFilesystem';
import { toast } from '../components/Toast';
import { DocumentsHub } from '../components/vessel/DocumentsHub';

const AT = '2026-10-09T01:00:00.000Z';

function paper(id: string, name: string, file: string | null): ShipDocument {
    return {
        id,
        user_id: 'kestrel-skipper',
        document_name: name,
        category: 'Insurance',
        issue_date: null,
        expiry_date: null,
        file_uri: file ? `supabase-storage://vessel_vault/kestrel-skipper/documents/${file}` : null,
        notes: null,
        created_at: AT,
        updated_at: AT,
    };
}

/** What storage serves: the bytes with the upload's own content type. */
const SERVED: Record<string, string> = { jpg: 'image/jpeg', pdf: 'application/pdf', png: 'image/png' };

const cacheFiles = () => [...memoryFs.files.keys()].filter((key) => key.startsWith('CACHE/'));
const sharedFiles = (call = 0): string[] => hoisted.share.mock.calls[call][0].files;

beforeEach(() => {
    memoryFs.reset();
    hoisted.share.mockReset().mockResolvedValue({ activityType: 'com.apple.DocumentManagerUICore.SaveToFiles' });
    hoisted.logWarn.mockReset();
    vi.mocked(toast.error).mockClear();
    hoisted.docs = [
        paper('1a2b3c4d-0000-4000-8000-000000000001', 'Hull insurance', '1a2b3c4d.jpg'),
        paper('5e6f7a8b-0000-4000-8000-000000000002', 'Hull insurance', '5e6f7a8b.pdf'),
        paper('9c0d1e2f-0000-4000-8000-000000000003', 'Паспорт судна', '9c0d1e2f.png'),
    ];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
            const ext = new URL(input).pathname.split('.').pop() ?? '';
            return {
                ok: true,
                status: 200,
                blob: async () => new Blob([`fictional ${ext} bytes`], { type: SERVED[ext] ?? '' }),
            };
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function selectBothHullInsurance() {
    render(<DocumentsHub onBack={vi.fn()} />);
    const selects = await screen.findAllByRole('button', { name: 'Select Hull insurance' });
    expect(selects).toHaveLength(2);
    for (const select of selects) fireEvent.click(select);
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
}

async function shareSelected() {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Email or share selected documents' }));
    });
}

describe('Documents: Share selected', () => {
    it('two papers with one name go out as two files, each with its own type, and both are cleared after', async () => {
        await selectBothHullInsurance();
        await shareSelected();

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        const files = sharedFiles();
        expect(files).toHaveLength(2);
        expect(new Set(files).size).toBe(2);
        expect(files.some((uri) => uri.endsWith('.jpg'))).toBe(true);
        expect(files.some((uri) => uri.endsWith('.pdf'))).toBe(true);
        expect(files.every((uri) => uri.includes('Hull insurance-'))).toBe(true);
        // One share sheet, one folder of copies, cleared in one go.
        expect(new Set(files.map((uri) => uri.split('/').slice(0, -1).join('/'))).size).toBe(1);
        await waitFor(() => expect(cacheFiles()).toEqual([]));
        expect(memoryFs.count('rmdir')).toBe(1);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('a cancelled share sheet also clears the copies, without an error', async () => {
        hoisted.share.mockRejectedValue(new Error('Share canceled'));
        await selectBothHullInsurance();
        await shareSelected();

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(cacheFiles()).toEqual([]));
        expect(toast.error).not.toHaveBeenCalled();
        expect(hoisted.logWarn).not.toHaveBeenCalledWith('documents: batch-share-failed', expect.anything());
    });

    it('a failed share says so, logs a reason, and clears the copies', async () => {
        hoisted.share.mockRejectedValue(new Error('Share sheet unavailable'));
        await selectBothHullInsurance();
        await shareSelected();

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Share failed'));
        expect(hoisted.logWarn).toHaveBeenCalledWith('documents: batch-share-failed', expect.anything());
        await waitFor(() => expect(cacheFiles()).toEqual([]));
    });
});

describe('Documents: open one paper', () => {
    it('a synced photo opens as the picture it is, under its own name, and the copy is cleared', async () => {
        render(<DocumentsHub onBack={vi.fn()} />);
        await act(async () => {
            fireEvent.click(await screen.findByText('Паспорт судна'));
        });

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        const [file] = sharedFiles();
        expect(file).toMatch(/\/Паспорт судна-9c0d1e2f\.png$/);
        await waitFor(() => expect(cacheFiles()).toEqual([]));
        expect(memoryFs.count('writeFile')).toBe(1);
        expect(memoryFs.count('rmdir')).toBe(1);
    });

    it('a second tap while the first sheet is up leaves the first copy alone, quietly', async () => {
        // On a slow link the skipper taps 'Hull insurance' twice. The second
        // share is refused while the first sheet is up; its clean-up must not
        // take the file the first sheet is still showing (Save to Files, Mail).
        // The taps are a beat apart here: two at once race vitest's async
        // module mock, and one of them gets the real Filesystem.
        let closeFirstSheet!: () => void;
        hoisted.share
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        closeFirstSheet = () => resolve({});
                    }),
            )
            .mockRejectedValueOnce(new Error("Can't share while sharing is in progress"));
        hoisted.docs = [paper('1a2b3c4d-0000-4000-8000-000000000001', 'Hull insurance', '1a2b3c4d.jpg')];
        render(<DocumentsHub onBack={vi.fn()} />);
        const name = await screen.findByText('Hull insurance');
        await act(async () => {
            fireEvent.click(name);
        });
        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        await act(async () => {
            fireEvent.click(name);
        });

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(2));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        const [firstFile] = sharedFiles(0);
        expect(cacheFiles().some((key) => firstFile.endsWith(key))).toBe(true);
        expect(toast.error).not.toHaveBeenCalled();

        await act(async () => {
            closeFirstSheet();
        });
        await waitFor(() => expect(cacheFiles()).toEqual([]));
    });
});
