/**
 * Ship's papers kept on the phone, said so on every card, and shared or saved
 * in one go (126-B3b, binder audit DOC-1 and DOC-10).
 *
 * - Every paper with a file says "On this phone" or "Needs signal to open", so
 *   the skipper knows before he reaches the customs counter; a paper too big
 *   to back up says it is on this phone only. A paper filed on the iPad turns
 *   "On this phone" after one open with signal, or by itself over Wi-Fi.
 * - "Share or save selected" is the one action: ONE share sheet with every
 *   ticked file on this phone (cloud ones fetched first with signal), the
 *   ones that are not left out and counted with no signal, no toast for a
 *   share that went (the sheet is its own confirmation) and none for a
 *   cancel. "Download selected", whose cancel said "Saved 3 of 3 files", is
 *   gone.
 *
 * The real DocumentsHub over the real LocalDatabase and vault; the share
 * sheet, the network status and the filesystem are stubs, and Storage is the
 * real supabase-js client on a fake fetch. Fictional papers on the fictional
 * 'Kestrel' (skipper 'kestrel-skipper').
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipDocument } from '../types';

const h = vi.hoisted(() => {
    const state = {
        objects: new Map<string, Uint8Array>(),
        requests: [] as string[],
        network: { connected: true, connectionType: 'cellular' },
    };
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        state.requests.push(url.pathname);
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new TypeError('Failed to fetch');
        if (url.pathname === '/storage/v1/object/list/vessel_vault') {
            const body = JSON.parse(String(init?.body)) as { prefix: string; search?: string };
            const folder = `${body.prefix.replace(/\/$/, '')}/`;
            return json(
                200,
                [...state.objects]
                    .filter(
                        ([path]) => path.startsWith(folder) && path.slice(folder.length).startsWith(body.search ?? ''),
                    )
                    .map(([path, bytes]) => ({
                        name: path.slice(folder.length),
                        id: `object-${path}`,
                        updated_at: '2026-10-09T01:00:00.000Z',
                        metadata: { eTag: `"etag-${path}"`, size: bytes.length },
                    })),
            );
        }
        if (url.pathname.startsWith('/storage/v1/object/sign/vessel_vault/')) {
            const path = decodeURIComponent(url.pathname.slice('/storage/v1/object/sign/vessel_vault/'.length));
            return json(200, { signedURL: `/object/sign/vessel_vault/${path}?token=fixture.signed.token` });
        }
        return json(404, { message: 'unexpected' });
    });
    return {
        state,
        fetch,
        share: vi.fn(),
        warn: vi.fn(),
    };
});

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/share', () => ({ Share: { share: h.share } }));
vi.mock('@capacitor/network', () => ({ Network: { getStatus: vi.fn(async () => ({ ...h.state.network })) } }));
vi.mock('../services/supabase', async (importOriginal) => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    return {
        ...(await importOriginal<typeof import('../services/supabase')>()),
        supabase: createClient('https://kestrel-project.test.invalid', 'anon-test-key', {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: h.fetch as unknown as typeof fetch },
        }),
    };
});
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        getDownloadUrl: vi.fn(async (uri: string) => uri),
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
import { initLocalDatabase, insertLocal, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { prefetchPapers, recordLocalCopy, saveAttachment } from '../services/vessel/vaultFiles';

const SKIPPER = 'kestrel-skipper';
const AT = '2026-10-09T01:00:00.000Z';
const ON_PHONE = 'On this phone';
const NEEDS_SIGNAL = 'Needs signal to open';
const PHONE_ONLY = 'On this phone only (too big to back up)';

function setOnline(online: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

function pdf(name: string): File {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 1) % 251;
    bytes.set(
        Array.from('%PDF-1.7\n', (c) => c.charCodeAt(0)),
        0,
    );
    return new File([bytes], name, { type: 'application/pdf' });
}

function paper(
    id: string,
    name: string,
    fileUri: string | null,
    category: ShipDocument['category'] = 'Registration',
): ShipDocument {
    return {
        id,
        user_id: SKIPPER,
        document_name: name,
        category,
        issue_date: null,
        expiry_date: null,
        file_uri: fileUri,
        notes: null,
        created_at: AT,
        updated_at: AT,
    };
}

/** A paper filed on this phone: its file in the vault, its row naming it. */
async function fileHere(id: string, name: string): Promise<void> {
    const saved = await saveAttachment(pdf(`${name}.pdf`));
    if (!saved.ok) throw new Error('not saved');
    await insertLocal('ship_documents', paper(id, name, saved.uri));
    await recordLocalCopy(id, saved.uri, saved.bytes);
}

/** A paper filed on the iPad: synced here as a row, its file in Storage only. */
async function fromIpad(id: string, name: string, ext = 'pdf', category: ShipDocument['category'] = 'Registration') {
    const path = `${SKIPPER}/documents/${id}.${ext}`;
    h.state.objects.set(path, new TextEncoder().encode(`%PDF-1.7 ${name}`));
    await mergePulledRecords('ship_documents', [paper(id, name, `supabase-storage://vessel_vault/${path}`, category)]);
}

/** A paper too big to back up: kept on this phone only, its row has no file. */
async function tooBigToBackUp(id: string, name: string) {
    const saved = await saveAttachment(pdf(`${name}.pdf`));
    if (!saved.ok) throw new Error('not saved');
    await insertLocal('ship_documents', paper(id, name, null));
    await recordLocalCopy(id, saved.uri, saved.bytes, { tooLarge: true });
}

const card = (name: string) =>
    screen.getByRole('button', { name: `Edit ${name}` }).closest('.rounded-2xl') as HTMLElement;
const labelOf = (name: string) =>
    within(card(name)).queryByText(new RegExp(`^(${ON_PHONE}|${NEEDS_SIGNAL}|${PHONE_ONLY.replace(/[()]/g, '\\$&')})$`))
        ?.textContent ?? null;
const cacheFiles = () => [...memoryFs.files.keys()].filter((key) => key.startsWith('CACHE/'));
const downloads = () => memoryFs.calls.filter((c) => c.op === 'downloadFile').length;

async function shareOrSave() {
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Share or save selected documents' }));
    });
}

const REGISTO = '1a2b3c4d-0000-4000-8000-0000000000f1';
const GREEK = '2b3c4d5e-0000-4000-8000-0000000000f2';
const BIG = '3c4d5e6f-0000-4000-8000-0000000000f3';
const NO_FILE = '4d5e6f7a-0000-4000-8000-0000000000f4';
const RADIO = '5e6f7a8b-0000-4000-8000-0000000000f5';
const PASSPORT_1 = '6f7a8b9c-0000-4000-8000-0000000000f6';
const PASSPORT_2 = '7a8b9c0d-0000-4000-8000-0000000000f7';
const MANUAL = '8b9c0d1e-0000-4000-8000-0000000000f8';
const LYTTELTON = '9c0d1e2f-0000-4000-8000-0000000000f9';

beforeEach(async () => {
    memoryFs.reset();
    memoryFs.serve = (url: string) => {
        const marker = '/storage/v1/object/sign/vessel_vault/';
        const { pathname } = new URL(url);
        return h.state.objects.get(decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length))) ?? 404;
    };
    h.state.objects.clear();
    h.state.requests.length = 0;
    h.state.network = { connected: true, connectionType: 'cellular' };
    h.share.mockReset().mockResolvedValue({ activityType: 'com.apple.DocumentManagerUICore.SaveToFiles' });
    h.warn.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    setOnline(true);
    // The page's own fetch never carries a paper (downloads are native).
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('no page fetch in this test');
        }),
    );
    setAuthIdentityScope(SKIPPER);
    await initLocalDatabase(null);
    await initLocalDatabase(SKIPPER);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setOnline(true);
    setAuthIdentityScope(null);
});

describe('Documents: each card says where its file is', () => {
    it('on this phone, needs signal, on this phone only, or nothing for a paper with no file', async () => {
        await fileHere(REGISTO, 'Registo de Propriedade');
        await fromIpad(GREEK, 'Πιστοποιητικό νηολόγησης', 'jpg');
        await tooBigToBackUp(BIG, 'Watermaker manual');
        await insertLocal('ship_documents', paper(NO_FILE, 'Crew list, Papeete', null, 'Customs Clearances'));

        render(<DocumentsHub onBack={vi.fn()} />);

        await waitFor(() => expect(labelOf('Registo de Propriedade')).toBe(ON_PHONE));
        expect(labelOf('Πιστοποιητικό νηολόγησης')).toBe(NEEDS_SIGNAL);
        expect(labelOf('Watermaker manual')).toBe(PHONE_ONLY);
        expect(labelOf('Crew list, Papeete')).toBeNull();
    });

    it('a paper filed on the iPad turns "On this phone" after one open with signal, kept natively', async () => {
        await fromIpad(GREEK, 'Πιστοποιητικό νηολόγησης', 'jpg');
        render(<DocumentsHub onBack={vi.fn()} />);
        await waitFor(() => expect(labelOf('Πιστοποιητικό νηολόγησης')).toBe(NEEDS_SIGNAL));

        await act(async () => {
            fireEvent.click(screen.getByText('Πιστοποιητικό νηολόγησης'));
        });

        await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
        const [file] = h.share.mock.calls[0][0].files as string[];
        expect(file).toMatch(/\/Πιστοποιητικό νηολόγησης-2b3c4d5e\.jpg$/);
        expect(downloads()).toBe(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        await waitFor(() => expect(labelOf('Πιστοποιητικό νηολόγησης')).toBe(ON_PHONE));
        await waitFor(() => expect(cacheFiles()).toEqual([]));

        // And it opens in airplane mode from now on.
        setOnline(false);
        await act(async () => {
            fireEvent.click(screen.getByText('Πιστοποιητικό νηολόγησης'));
        });
        await waitFor(() => expect(h.share).toHaveBeenCalledTimes(2));
        expect(downloads()).toBe(1);
    });

    it('on Wi-Fi, opening Documents keeps the papers on the phone, but not a manual', async () => {
        h.state.network = { connected: true, connectionType: 'wifi' };
        await fromIpad(REGISTO, 'Registo de Propriedade');
        await fromIpad(GREEK, 'Πιστοποιητικό νηολόγησης', 'jpg');
        await fromIpad(MANUAL, 'Watermaker manual', 'pdf', 'User Manuals');

        render(<DocumentsHub onBack={vi.fn()} />);

        await waitFor(() => expect(labelOf('Registo de Propriedade')).toBe(ON_PHONE));
        await waitFor(() => expect(labelOf('Πιστοποιητικό νηολόγησης')).toBe(ON_PHONE));
        expect(labelOf('Watermaker manual')).toBe(NEEDS_SIGNAL);
        expect(downloads()).toBe(2);
        expect(h.share).not.toHaveBeenCalled();
    });
});

describe('Documents: a pass after a sync relabels the open page', () => {
    it('a paper kept by the Wi-Fi pass a sync asks for turns "On this phone" on the page already open', async () => {
        // An id no other test here uses: the vault module (and its passes) lives across this file's tests.
        await fromIpad(LYTTELTON, 'Registo de Propriedade');
        render(<DocumentsHub onBack={vi.fn()} />);
        // Opened on cellular: nothing comes down.
        await waitFor(() => expect(labelOf('Registo de Propriedade')).toBe(NEEDS_SIGNAL));

        // Aboard on the marina Wi-Fi, the next sync's pass keeps it.
        h.state.network = { connected: true, connectionType: 'wifi' };
        await act(async () => {
            expect(await prefetchPapers({ minGapMs: 30 * 60 * 1000 })).toBe(1);
        });

        await waitFor(() => expect(labelOf('Registo de Propriedade')).toBe(ON_PHONE));
    });
});

describe('Documents: Share or save selected', () => {
    it('three ticked, one only in the cloud, no signal: ONE sheet with the two here, and one left out', async () => {
        await fileHere(PASSPORT_1, 'Passport');
        await fileHere(PASSPORT_2, 'Passport');
        await fromIpad(RADIO, 'Ship radio licence');
        render(<DocumentsHub onBack={vi.fn()} />);
        setOnline(false);
        for (const select of await screen.findAllByRole('button', { name: 'Select Passport' })) fireEvent.click(select);
        fireEvent.click(screen.getByRole('button', { name: 'Select Ship radio licence' }));
        const requests = h.state.requests.length;

        await shareOrSave();

        await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
        const files = h.share.mock.calls[0][0].files as string[];
        expect(files).toHaveLength(2);
        expect(new Set(files).size).toBe(2);
        expect(files.every((file) => /\/Passport-[0-9a-f]{8}\.pdf$/.test(file))).toBe(true);
        expect(toast.info).toHaveBeenCalledWith("1 paper isn't on this phone yet and was left out.");
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
        expect(h.state.requests.length).toBe(requests);
        await waitFor(() => expect(cacheFiles()).toEqual([]));
    });

    it('with signal, a paper only in the cloud is kept on the phone first, then shared in the same sheet', async () => {
        await fileHere(REGISTO, 'Registo de Propriedade');
        await fromIpad(RADIO, 'Ship radio licence');
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Registo de Propriedade' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select Ship radio licence' }));

        await shareOrSave();

        await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
        const files = h.share.mock.calls[0][0].files as string[];
        expect(files.map((file) => file.split('/').pop())).toEqual([
            'Registo de Propriedade-1a2b3c4d.pdf',
            'Ship radio licence-5e6f7a8b.pdf',
        ]);
        expect(downloads()).toBe(1);
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.info).not.toHaveBeenCalled();
        await waitFor(() => expect(labelOf('Ship radio licence')).toBe(ON_PHONE));
        await waitFor(() => expect(cacheFiles()).toEqual([]));
    });

    it('none of them on this phone and no signal: says so, and opens no sheet', async () => {
        await fromIpad(RADIO, 'Ship radio licence');
        await fromIpad(GREEK, 'Πιστοποιητικό νηολόγησης', 'jpg');
        render(<DocumentsHub onBack={vi.fn()} />);
        setOnline(false);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Ship radio licence' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select Πιστοποιητικό νηολόγησης' }));

        await shareOrSave();

        await waitFor(() =>
            expect(toast.info).toHaveBeenCalledWith("These papers aren't on this phone yet. Connect to share them."),
        );
        expect(h.share).not.toHaveBeenCalled();
    });

    it('with signal, papers the cloud no longer has say "Share failed", never "connect"', async () => {
        await fromIpad(RADIO, 'Ship radio licence');
        await fromIpad(GREEK, 'Πιστοποιητικό νηολόγησης', 'jpg');
        // Their stored files were removed on the iPad; the sweep has not pruned the rows yet.
        h.state.objects.clear();
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Ship radio licence' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select Πιστοποιητικό νηολόγησης' }));

        await shareOrSave();

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Share failed'));
        expect(toast.info).not.toHaveBeenCalled();
        expect(h.warn).toHaveBeenCalledWith('documents: share-failed', expect.anything());
        expect(h.share).not.toHaveBeenCalled();
    });

    it('with signal, one the cloud refuses is left out and said so; the rest go in the one sheet', async () => {
        await fileHere(REGISTO, 'Registo de Propriedade');
        await fromIpad(RADIO, 'Ship radio licence');
        h.state.objects.clear();
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Registo de Propriedade' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select Ship radio licence' }));

        await shareOrSave();

        await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
        expect((h.share.mock.calls[0][0].files as string[]).map((file) => file.split('/').pop())).toEqual([
            'Registo de Propriedade-1a2b3c4d.pdf',
        ]);
        expect(toast.error).toHaveBeenCalledWith("1 paper couldn't be read and was left out.");
        expect(toast.info).not.toHaveBeenCalled();
        await waitFor(() => expect(cacheFiles()).toEqual([]));
    });

    it('a cancelled sheet says nothing at all, and the selection is cleared as before', async () => {
        h.share.mockRejectedValue(new Error('Share canceled'));
        await fileHere(PASSPORT_1, 'Passport');
        await fileHere(REGISTO, 'Registo de Propriedade');
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Passport' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select Registo de Propriedade' }));

        await shareOrSave();

        await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Select Passport' })).toHaveAttribute('aria-pressed', 'false'),
        );
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.info).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
        await waitFor(() => expect(cacheFiles()).toEqual([]));
    });

    it('a sheet that fails says "Share failed" and logs why', async () => {
        h.share.mockRejectedValue(new Error('Share sheet unavailable'));
        await fileHere(REGISTO, 'Registo de Propriedade');
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Registo de Propriedade' }));

        await shareOrSave();

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Share failed'));
        expect(h.warn).toHaveBeenCalledWith('documents: share-failed', expect.anything());
    });

    it('the ⋮ menu has exactly "Share or save selected" and "Clear selection"', async () => {
        await fileHere(REGISTO, 'Registo de Propriedade');
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Select Registo de Propriedade' }));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));

        const menu = screen.getByRole('button', { name: 'Share or save selected documents' }).parentElement!;
        expect(
            within(menu)
                .getAllByRole('button')
                .map((button) => button.textContent?.trim()),
        ).toEqual(['Share or save selected', 'Clear selection']);
        expect(screen.queryByText('Download selected')).toBeNull();
        expect(screen.queryByRole('button', { name: /Download selected/ })).toBeNull();
    });
});
