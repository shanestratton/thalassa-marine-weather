/**
 * Attaching a paper keeps the file on the phone (126-B3a, binder audit DOC-1
 * and DOC-2). "Add document" waits while the file is read; a file over 25 MB
 * is refused with its size; the outbox carries a short local path instead of
 * the whole file as base64; an edit that leaves the attachment alone does not
 * send it again; once synced, the paper still opens in airplane mode, at the
 * customs counter, from the copy this phone filed, while with signal a paper
 * replaced on another device opens as the cloud's file; and sharing several
 * with no signal shares the ones on this phone and says which were left out.
 *
 * The real DocumentsHub, DocumentForm, LocalDocumentService and LocalDatabase
 * over the in-memory filesystem; Share, the network and the sync engine are
 * stubs. Fictional papers on the fictional 'Kestrel' (skipper
 * 'kestrel-skipper'; crew 'albatross-crew').
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipDocument } from '../types';

const hoisted = vi.hoisted(() => ({
    share: vi.fn(),
    warn: vi.fn(),
    getDownloadUrl: vi.fn(),
}));

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/share', () => ({ Share: { share: hoisted.share } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: hoisted.warn, error: vi.fn() }),
}));
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        getDownloadUrl: hoisted.getDownloadUrl,
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
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getAll,
    getFullQueue,
    identityFileToken,
    initLocalDatabase,
    mergePulledRecords,
    removeSynced,
} from '../services/vessel/LocalDatabase';

const MiB = 1024 * 1024;
const SKIPPER = 'kestrel-skipper';
const CREW = 'albatross-crew';
const AT = '2026-10-09T01:00:00.000Z';
const NEEDS_SIGNAL = "This file isn't on this phone yet. Open it once with signal to keep a copy.";

function pdfFile(name: string, size: number): File {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 17 + 3) % 251;
    bytes.set(
        Array.from('%PDF-1.7\n', (c) => c.charCodeAt(0)),
        0,
    );
    return new File([bytes], name, { type: 'application/pdf' });
}

const vaultKeys = (identity: string) =>
    [...memoryFs.files.keys()].filter((key) =>
        key.startsWith(`LIBRARY/vault/${identityFileToken(identity)}/documents/`),
    );

function setOnline(online: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/** Hold the vault's chunked writes until released (the file is still being read). */
function holdVaultWrites() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const append = memoryFs.appendFile.bind(memoryFs);
    const write = memoryFs.writeFile.bind(memoryFs);
    vi.spyOn(memoryFs, 'appendFile').mockImplementation(async (options) => {
        if (options.path.startsWith('vault/')) await gate;
        return append(options);
    });
    vi.spyOn(memoryFs, 'writeFile').mockImplementation(async (options) => {
        if (options.path.startsWith('vault/') && options.path.includes('/documents/')) await gate;
        return write(options);
    });
    return { release };
}

async function openAddForm() {
    render(<DocumentsHub onBack={vi.fn()} />);
    await screen.findByText('No documents filed');
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
    const sheet = screen.getByRole('dialog', { name: 'Add document' });
    fireEvent.change(within(sheet).getByLabelText(/Document name/), { target: { value: 'Registo de Propriedade' } });
    return sheet;
}

function pick(sheet: HTMLElement, file: File) {
    const input = sheet.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
}

const saveButton = (sheet: HTMLElement) => within(sheet).getByRole('button', { name: 'Add document' });

beforeEach(async () => {
    memoryFs.reset();
    vi.restoreAllMocks();
    hoisted.share.mockReset().mockResolvedValue({});
    hoisted.warn.mockReset();
    hoisted.getDownloadUrl.mockReset().mockImplementation(async (uri: string) => uri);
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    setOnline(true);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('no network in this test');
        }),
    );
    setAuthIdentityScope(SKIPPER);
    // Through the signed-out scope, so the database re-reads the emptied filesystem.
    await initLocalDatabase(null);
    await initLocalDatabase(SKIPPER);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
    setAuthIdentityScope(null);
});

describe('Documents: attaching a file', () => {
    it('"Add document" waits while a 24.9 MB file is read, then files a short local path, not the file', async () => {
        const sheet = await openAddForm();
        const hold = holdVaultWrites();

        pick(sheet, pdfFile('Registo de Propriedade.pdf', Math.round(24.9 * MiB)));

        expect(await within(sheet).findByText('Preparing file…')).toBeInTheDocument();
        expect(saveButton(sheet)).toBeDisabled();

        hold.release();
        await waitFor(() => expect(saveButton(sheet)).toBeEnabled());
        expect(within(sheet).getByText('Registo de Propriedade.pdf')).toBeInTheDocument();
        expect(within(sheet).queryByText('Preparing file…')).toBeNull();

        await act(async () => {
            fireEvent.click(saveButton(sheet));
        });
        await waitFor(() => expect(getFullQueue()).toHaveLength(1));
        const [insert] = getFullQueue();
        expect(insert.mutation_type).toBe('INSERT');
        expect(insert.payload.length).toBeLessThan(1024);
        expect((JSON.parse(insert.payload) as { file_uri: string }).file_uri).toMatch(
            new RegExp(`^local-vault://vault/${identityFileToken(SKIPPER)}/documents/p-`),
        );
        expect(vaultKeys(SKIPPER)).toHaveLength(1);
    });

    it('a 63 MB file is refused with its size as the Files app shows it, and nothing is written', async () => {
        const sheet = await openAddForm();

        // 63,000,000 bytes: "63 MB" in Files (60.1 MiB).
        pick(sheet, pdfFile('Kestrel engine manual.pdf', 63_000_000));

        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith('That file is 63 MB. Documents can be up to 25 MB.'),
        );
        expect(vaultKeys(SKIPPER)).toEqual([]);
        expect(saveButton(sheet)).toBeEnabled();
        expect(within(sheet).getByText('Attach PDF, photo or document')).toBeInTheDocument();
        expect(hoisted.warn).toHaveBeenCalledWith('documents: attach-too-large');
    });

    it('editing only the notes of a filed paper does not send the file again', async () => {
        const id = '0b1c2d3e-0000-4000-8000-0000000000b1';
        const remote = `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.pdf`;
        await mergePulledRecords('ship_documents', [paper(id, 'Ship radio licence', remote)]);
        render(<DocumentsHub onBack={vi.fn()} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Edit Ship radio licence' }));
        const sheet = screen.getByRole('dialog', { name: 'Edit document' });
        fireEvent.change(within(sheet).getByLabelText(/Notes/), { target: { value: 'Callsign renewed in Nouméa' } });
        await act(async () => {
            fireEvent.click(within(sheet).getByRole('button', { name: 'Save changes' }));
        });

        await waitFor(() => expect(getFullQueue()).toHaveLength(1));
        const [update] = getFullQueue();
        expect(update.mutation_type).toBe('UPDATE');
        const payload = JSON.parse(update.payload) as Record<string, unknown>;
        expect(payload.notes).toBe('Callsign renewed in Nouméa');
        expect('file_uri' in payload).toBe(false);
    });
});

function paper(id: string, name: string, fileUri: string | null, updatedAt = AT): ShipDocument {
    return {
        id,
        user_id: SKIPPER,
        document_name: name,
        category: 'Registration',
        issue_date: null,
        expiry_date: null,
        file_uri: fileUri,
        notes: null,
        created_at: AT,
        updated_at: updatedAt,
    };
}

describe('Documents: opening a paper with no signal', () => {
    it('the paper this phone filed opens from its own copy after the sync, with no network at all', async () => {
        const sheet = await openAddForm();
        pick(sheet, pdfFile('Registo de Propriedade.pdf', 2 * MiB));
        await waitFor(() => expect(saveButton(sheet)).toBeEnabled());
        await waitFor(() => expect(within(sheet).getByText('Registo de Propriedade.pdf')).toBeInTheDocument());
        await act(async () => {
            fireEvent.click(saveButton(sheet));
        });
        await waitFor(() => expect(getFullQueue()).toHaveLength(1));
        const [filed] = getAll<ShipDocument>('ship_documents');

        // The push uploads it; the pull replaces the row's reference.
        await removeSynced(getFullQueue().map((item) => item.id));
        const remote = `supabase-storage://vessel_vault/${SKIPPER}/documents/${filed.id}.pdf`;
        await mergePulledRecords('ship_documents', [
            { ...filed, file_uri: remote, updated_at: '2026-10-09T03:00:00.000Z' },
        ]);
        cleanup();
        render(<DocumentsHub onBack={vi.fn()} />);
        const card = await screen.findByText('Registo de Propriedade');

        setOnline(false);
        await act(async () => {
            fireEvent.click(card);
        });

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        const [file] = hoisted.share.mock.calls[0][0].files as string[];
        expect(file).toMatch(new RegExp(`/Registo de Propriedade-${filed.id.slice(0, 8)}\\.pdf$`));
        expect(hoisted.getDownloadUrl).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalledWith('Could not open document');
        // The copy handed to the share sheet does not stay in Caches.
        await waitFor(() => expect([...memoryFs.files.keys()].filter((key) => key.startsWith('CACHE/'))).toEqual([]));
    });

    it('a paper filed on another device, with no copy here, says it needs signal', async () => {
        const id = '4e5f6a7b-0000-4000-8000-0000000000b2';
        await mergePulledRecords('ship_documents', [
            paper(id, 'Πιστοποιητικό νηολόγησης', `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.pdf`),
        ]);
        render(<DocumentsHub onBack={vi.fn()} />);
        const card = await screen.findByText('Πιστοποιητικό νηολόγησης');

        setOnline(false);
        await act(async () => {
            fireEvent.click(card);
        });

        await waitFor(() => expect(toast.info).toHaveBeenCalledWith(NEEDS_SIGNAL));
        expect(hoisted.warn).toHaveBeenCalledWith('documents: open-needs-signal');
        expect(hoisted.share).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalledWith('Could not open document');
    });
});

describe('Documents: with signal, and sharing several', () => {
    async function fileOnThisPhone(name: string): Promise<ShipDocument> {
        const sheet = await openAddForm();
        fireEvent.change(within(sheet).getByLabelText(/Document name/), { target: { value: name } });
        pick(sheet, pdfFile(`${name}.pdf`, MiB));
        await waitFor(() => expect(within(sheet).getByText(`${name}.pdf`)).toBeInTheDocument());
        await act(async () => {
            fireEvent.click(saveButton(sheet));
        });
        await waitFor(() => expect(getAll<ShipDocument>('ship_documents')).toHaveLength(1));
        return getAll<ShipDocument>('ship_documents')[0];
    }

    it("a paper replaced on another device opens as the cloud's file, not the older copy on this phone", async () => {
        const filed = await fileOnThisPhone('Hull insurance');
        cleanup();
        // Synced; then, before this phone opens Documents again, the iPad swaps
        // in the renewed certificate at the same .pdf path, and the pull brings it.
        await removeSynced(getFullQueue().map((item) => item.id));
        const remote = `supabase-storage://vessel_vault/${SKIPPER}/documents/${filed.id}.pdf`;
        await mergePulledRecords('ship_documents', [
            { ...filed, user_id: SKIPPER, file_uri: remote, updated_at: '2026-10-12T09:00:00.000Z' },
        ]);
        hoisted.getDownloadUrl.mockImplementation(
            async (uri: string) => `https://storage.test.invalid/${uri.slice('supabase-storage://'.length)}?token=x`,
        );
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                blob: async () => new Blob(['%PDF-1.7 renewed certificate'], { type: 'application/pdf' }),
            })),
        );
        let sharedText = '';
        hoisted.share.mockImplementation(async ({ files }: { files: string[] }) => {
            const file = memoryFs.files.get(files[0].replace('mem://', ''));
            sharedText = Buffer.from(file?.data ?? '', 'base64').toString();
        });
        render(<DocumentsHub onBack={vi.fn()} />);
        const card = await screen.findByText('Hull insurance');

        await act(async () => {
            fireEvent.click(card);
        });

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        expect(hoisted.getDownloadUrl).toHaveBeenCalledWith(remote);
        expect(sharedText).toBe('%PDF-1.7 renewed certificate');
    });

    it('with no signal, sharing several shares the ones on this phone and names what was left out', async () => {
        await fileOnThisPhone('Registo de Propriedade');
        cleanup();
        const id = '8a9b0c1d-0000-4000-8000-0000000000b3';
        await mergePulledRecords('ship_documents', [
            paper(id, 'Hull insurance', `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.pdf`),
        ]);
        render(<DocumentsHub onBack={vi.fn()} />);
        setOnline(false);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Registo de Propriedade' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select Hull insurance' }));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Email or share selected documents' }));
        });

        await waitFor(() => expect(hoisted.share).toHaveBeenCalledTimes(1));
        const files = hoisted.share.mock.calls[0][0].files as string[];
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/\/Registo de Propriedade-[0-9a-f]{8}\.pdf$/);
        expect(toast.info).toHaveBeenCalledWith("1 paper isn't on this phone yet and was left out.");
        expect(toast.error).not.toHaveBeenCalledWith('Share failed');
    });
});

describe('Documents: the account changes while a file is read', () => {
    it("nothing lands in the new account's scope, and the old account's partial pick is cleared", async () => {
        const sheet = await openAddForm();
        const hold = holdVaultWrites();
        pick(sheet, pdfFile('Passport — Søren Holm.pdf', 5 * MiB));
        await within(sheet).findByText('Preparing file…');

        await act(async () => {
            setAuthIdentityScope(CREW);
            await initLocalDatabase(CREW);
        });
        hold.release();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(screen.queryByRole('dialog', { name: 'Add document' })).toBeNull();
        expect(vaultKeys(CREW)).toEqual([]);
        await waitFor(() => expect(vaultKeys(SKIPPER)).toEqual([]));
        expect(getFullQueue()).toEqual([]);
    });
});
