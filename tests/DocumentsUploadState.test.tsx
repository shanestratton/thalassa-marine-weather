/**
 * Documents says honestly what hasn't uploaded (131-B9, binder audit DOC-8 and
 * DOC-9).
 *
 * - A paper saved with no signal says "Not uploaded yet" on its card until it
 *   really has uploaded, and the header's "N pending" is counted from the
 *   outbox itself, not from a list the page kept on the side.
 * - A refused upload says so on its card, with the reason in plain words and
 *   a Retry button; the header counts it apart.
 * - Opening Documents no longer forces a full pull of every binder: it
 *   follows the sync engine the way Stores and Equipment do.
 *
 * The real DocumentsHub, DocumentSyncService, LocalDocumentService and
 * LocalDatabase over the in-memory filesystem; the sync engine is a stub whose
 * cycles the test runs by hand. Fictional papers on the fictional 'Kestrel'
 * (skipper 'kestrel-skipper').
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipDocument } from '../types';

type CycleResult = {
    pushed: number;
    pulled: number;
    errors: string[];
    pruned?: number;
    discardedShared?: number;
    rehomedShared?: number;
    sharedOwnerIds?: string[];
};

const sync = vi.hoisted(() => ({
    listeners: [] as ((result: CycleResult) => void)[],
    syncNow: vi.fn(),
    getSyncStatus: vi.fn(() => 'idle'),
    forceFullPull: vi.fn(),
    requestFullReconciliation: vi.fn(),
    requestCatchUpSync: vi.fn(),
}));

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));
vi.mock('../services/supabase', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/supabase')>()),
    supabase: null,
}));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (typeof sync.listeners)[number]) => {
        sync.listeners.push(listener);
        return () => {
            sync.listeners = sync.listeners.filter((candidate) => candidate !== listener);
        };
    },
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    getSyncStatus: sync.getSyncStatus,
    syncNow: sync.syncNow,
    forceFullPull: sync.forceFullPull,
    requestFullReconciliation: sync.requestFullReconciliation,
    requestCatchUpSync: sync.requestCatchUpSync,
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
import { LocalDocumentService } from '../services/vessel/LocalDocumentService';
import {
    deleteLocal,
    getFullQueue,
    initLocalDatabase,
    insertLocal,
    markFailed,
    mergePulledRecords,
    removeSynced,
} from '../services/vessel/LocalDatabase';

const SKIPPER = 'kestrel-skipper';
const AT = '2026-10-14T01:00:00.000Z';
const INSURANCE = '1a2b3c4d-0000-4000-8000-000000000b91';
const LICENCE = '2b3c4d5e-0000-4000-8000-000000000b92';
const CREW_LIST = '3c4d5e6f-0000-4000-8000-000000000b93';

function paper(id: string, name: string, category: ShipDocument['category'] = 'Insurance'): ShipDocument {
    return {
        id,
        user_id: SKIPPER,
        document_name: name,
        category,
        issue_date: null,
        expiry_date: null,
        file_uri: null,
        notes: null,
        created_at: AT,
        updated_at: AT,
    };
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function setOnline(online: boolean) {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/** This paper's changes still in the outbox. */
const queued = (id: string) =>
    getFullQueue().filter((item) => item.table_name === 'ship_documents' && item.record_id === id);

/** A sync cycle ended, as SyncService tells its listeners. */
const cycleEnds = (result: CycleResult = { pushed: 0, pulled: 0, errors: [] }) =>
    act(() => [...sync.listeners].forEach((listener) => listener(result)));

/** The engine pushed this paper: its changes leave the outbox, then the cycle ends. */
async function uploads(id: string): Promise<void> {
    await removeSynced(queued(id).map((item) => item.id));
    cycleEnds({ pushed: 1, pulled: 0, errors: [] });
}

/**
 * The engine dropped this paper's change instead of pushing it (SyncService
 * pushMutations on a fresh share snapshot: a skipper's paper this sailor can
 * no longer edit). It leaves the outbox all the same.
 */
async function dropped(id: string): Promise<void> {
    await removeSynced(queued(id).map((item) => item.id));
}

/** The cloud refused this paper's change, with the engine's own message. */
async function refuses(id: string, message: string): Promise<void> {
    await markFailed(
        queued(id).map((item) => item.id),
        message,
    );
}

const card = (name: string) =>
    screen.getByRole('button', { name: `Edit ${name}` }).closest('.rounded-2xl') as HTMLElement;
const findCard = async (name: string) =>
    (await screen.findByRole('button', { name: `Edit ${name}` })).closest('.rounded-2xl') as HTMLElement;

beforeEach(async () => {
    memoryFs.reset();
    sync.listeners = [];
    sync.syncNow.mockReset().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
    sync.getSyncStatus.mockReset().mockReturnValue('idle');
    sync.forceFullPull.mockReset().mockResolvedValue(0);
    sync.requestFullReconciliation.mockReset().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
    sync.requestCatchUpSync.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    setOnline(true);
    setAuthIdentityScope(SKIPPER);
    // Through the signed-out scope, so the database re-reads the emptied filesystem.
    await initLocalDatabase(null);
    await initLocalDatabase(SKIPPER);
});

afterEach(() => {
    setOnline(true);
    setAuthIdentityScope(null);
});

describe('Documents: "Not uploaded yet" until it really has uploaded', () => {
    it('a paper saved with no signal says so, and "1 pending", until the engine has pushed it', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        render(<DocumentsHub onBack={vi.fn()} />);

        const insurance = await findCard('Hull insurance, Horta to Papeete');
        expect(within(insurance).getByText('Not uploaded yet')).toBeInTheDocument();
        expect(screen.getByText('1 pending')).toBeInTheDocument();

        // A cycle that pushed something else changes nothing here.
        cycleEnds({ pushed: 3, pulled: 0, errors: [] });
        expect(within(insurance).getByText('Not uploaded yet')).toBeInTheDocument();

        await uploads(INSURANCE);
        await waitFor(() => expect(within(insurance).queryByText('Not uploaded yet')).not.toBeInTheDocument());
        expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
    });

    it('a paper pulled from the cloud never says it', async () => {
        await mergePulledRecords('ship_documents', [paper(LICENCE, 'Ship radio licence', 'Radio/MMSI')]);
        render(<DocumentsHub onBack={vi.fn()} />);

        expect(within(await findCard('Ship radio licence')).queryByText('Not uploaded yet')).not.toBeInTheDocument();
        expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
    });

    it('filed from the form, its card says so at once', async () => {
        render(<DocumentsHub onBack={vi.fn()} />);
        await screen.findByText('No documents filed');

        fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
        const sheet = screen.getByRole('dialog', { name: 'Add document' });
        fireEvent.change(within(sheet).getByLabelText(/Document name/), { target: { value: 'Crew list, Papeete' } });
        await act(async () => {
            fireEvent.click(within(sheet).getByRole('button', { name: 'Add document' }));
        });

        expect(within(await findCard('Crew list, Papeete')).getByText('Not uploaded yet')).toBeInTheDocument();
        expect(screen.getByText('1 pending')).toBeInTheDocument();
    });

    it('an edit queued while the page is open shows on its card, and goes when pushed', async () => {
        await mergePulledRecords('ship_documents', [paper(LICENCE, 'Ship radio licence', 'Radio/MMSI')]);
        render(<DocumentsHub onBack={vi.fn()} />);
        const licence = await findCard('Ship radio licence');
        expect(within(licence).queryByText('Not uploaded yet')).not.toBeInTheDocument();

        // Saved by the form's edit path (LocalDocumentService.update), here directly.
        await act(async () => {
            await LocalDocumentService.update(LICENCE, { notes: 'Renewed in Horta' });
        });
        await waitFor(() => expect(within(licence).getByText('Not uploaded yet')).toBeInTheDocument());

        await uploads(LICENCE);
        await waitFor(() => expect(within(licence).queryByText('Not uploaded yet')).not.toBeInTheDocument());
    });

    it('the header counts the papers on screen: a deleted paper still to leave the cloud has no card, and no count', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await insertLocal('ship_documents', paper(CREW_LIST, 'Crew list, Papeete', 'Customs Clearances'));
        await deleteLocal('ship_documents', CREW_LIST);
        render(<DocumentsHub onBack={vi.fn()} />);

        expect(await screen.findByText('1 pending')).toBeInTheDocument();
        expect(queued(CREW_LIST).map((item) => item.mutation_type)).toContain('DELETE');
        expect(screen.queryByText('Crew list, Papeete')).not.toBeInTheDocument();
    });
});

describe('Documents: a refused upload says so, with the reason and a Retry button', () => {
    it('says why in plain words, counts it apart, and offers Retry', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await insertLocal('ship_documents', paper(CREW_LIST, 'Crew list, Papeete', 'Customs Clearances'));
        await refuses(INSURANCE, 'File upload failed: The object exceeded the maximum allowed size');
        render(<DocumentsHub onBack={vi.fn()} />);

        const insurance = await findCard('Hull insurance, Horta to Papeete');
        expect(within(insurance).getByText('Upload failed: the file is too big for the cloud')).toBeInTheDocument();
        expect(within(insurance).queryByText('Not uploaded yet')).not.toBeInTheDocument();
        expect(
            within(insurance).getByRole('button', { name: 'Retry uploading Hull insurance, Horta to Papeete' }),
        ).toHaveTextContent('Retry');
        expect(screen.getByText('1 upload failed')).toBeInTheDocument();
        expect(screen.getByText('1 pending')).toBeInTheDocument();
        // A paper only waiting has no Retry: the engine sends it by itself.
        expect(within(card('Crew list, Papeete')).queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    });

    it('a refusal that happens while the page is open shows when the cycle ends', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        render(<DocumentsHub onBack={vi.fn()} />);
        const insurance = await findCard('Hull insurance, Horta to Papeete');
        expect(within(insurance).getByText('Not uploaded yet')).toBeInTheDocument();

        await refuses(INSURANCE, 'new row violates row-level security policy for table "ship_documents"');
        cycleEnds({ pushed: 0, pulled: 0, errors: ['ship_documents: refused'] });

        expect(
            within(insurance).getByText("Upload failed: the cloud didn't allow it for this account"),
        ).toBeInTheDocument();
        expect(screen.getByText('1 upload failed')).toBeInTheDocument();
        expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
    });

    it('Retry runs a sync now, says "Trying again…" while it runs, and the card clears once it has uploaded', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await refuses(INSURANCE, 'TypeError: Load failed');
        render(<DocumentsHub onBack={vi.fn()} />);
        const insurance = await findCard('Hull insurance, Horta to Papeete');
        expect(within(insurance).getByText('Upload failed: the connection dropped')).toBeInTheDocument();

        const cycle = deferred();
        sync.syncNow.mockImplementationOnce(async () => {
            await cycle.promise;
            await uploads(INSURANCE);
            return { pushed: 1, pulled: 0, errors: [] };
        });
        fireEvent.click(within(insurance).getByRole('button', { name: /Retry uploading/ }));

        const busy = await within(insurance).findByRole('button', {
            name: 'Trying again to upload Hull insurance, Horta to Papeete',
        });
        expect(busy).toBeDisabled();
        expect(busy).toHaveTextContent('Trying again…');
        expect(sync.syncNow).toHaveBeenCalledTimes(1);

        await act(async () => {
            cycle.resolve();
        });
        await waitFor(() => expect(within(insurance).queryByText(/Upload failed/)).not.toBeInTheDocument());
        expect(within(insurance).queryByRole('button', { name: /Retry|Trying again/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
        expect(toast.success).toHaveBeenCalledWith('"Hull insurance, Horta to Papeete" uploaded');
    });

    it('a Retry that is refused again says so, with the new reason', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await refuses(INSURANCE, 'TypeError: Load failed');
        render(<DocumentsHub onBack={vi.fn()} />);
        const insurance = await findCard('Hull insurance, Horta to Papeete');

        sync.syncNow.mockImplementationOnce(async () => {
            await refuses(INSURANCE, 'JWT expired');
            cycleEnds({ pushed: 0, pulled: 0, errors: ['ship_documents: JWT expired'] });
            return { pushed: 0, pulled: 0, errors: ['ship_documents: JWT expired'] };
        });
        await act(async () => {
            fireEvent.click(within(insurance).getByRole('button', { name: /Retry uploading/ }));
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Still not uploaded: you need to sign in again'));
        expect(within(insurance).getByText('Upload failed: you need to sign in again')).toBeInTheDocument();
        expect(within(insurance).getByRole('button', { name: /Retry uploading/ })).toBeEnabled();
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('Retry while a sync is already running waits it out, then runs one that starts after the tap', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await refuses(INSURANCE, 'TypeError: Load failed');
        render(<DocumentsHub onBack={vi.fn()} />);

        const running = deferred<CycleResult>();
        sync.getSyncStatus.mockReturnValue('syncing');
        sync.syncNow.mockReturnValueOnce(running.promise).mockImplementationOnce(async () => {
            await uploads(INSURANCE);
            return { pushed: 1, pulled: 0, errors: [] };
        });
        fireEvent.click(
            within(await findCard('Hull insurance, Horta to Papeete')).getByRole('button', { name: /Retry/ }),
        );
        await waitFor(() => expect(sync.syncNow).toHaveBeenCalledTimes(1));

        // The cycle under way read the outbox before the tap: it ends with the paper still refused.
        sync.getSyncStatus.mockReturnValue('idle');
        await act(async () => {
            running.resolve({ pushed: 0, pulled: 0, errors: ['ship_documents: Load failed'] });
        });

        await waitFor(() => expect(sync.syncNow).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('"Hull insurance, Horta to Papeete" uploaded'));
    });

    // Review fix: gone from the outbox is not proof it uploaded. A crew edit
    // refused while the share snapshot was stale is dropped by the cycle a
    // Retry runs once the snapshot is fresh (or an add is moved into the
    // sailor's own binder); sharedBinderNotice's central toast says so, and
    // this page must not contradict it with "uploaded".
    it.each([
        ['dropped, while another paper pushed', { pushed: 1, discardedShared: 1 }],
        ["moved into the sailor's own binder", { pushed: 1, rehomedShared: 1 }],
    ])('a Retry whose change the engine %s never says it uploaded', async (_case, counts) => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await insertLocal('ship_documents', paper(LICENCE, 'Ship radio licence', 'Radio/MMSI'));
        await refuses(INSURANCE, 'Record not found or update not authorized');
        render(<DocumentsHub onBack={vi.fn()} />);
        const insurance = await findCard('Hull insurance, Horta to Papeete');
        expect(within(insurance).getByText("Upload failed: the cloud didn't accept it")).toBeInTheDocument();

        sync.syncNow.mockImplementationOnce(async () => {
            await dropped(INSURANCE);
            await removeSynced(queued(LICENCE).map((item) => item.id));
            const result: CycleResult = { pulled: 0, errors: [], sharedOwnerIds: [SKIPPER], ...counts };
            cycleEnds(result);
            return result;
        });
        await act(async () => {
            fireEvent.click(within(insurance).getByRole('button', { name: /Retry uploading/ }));
        });

        await waitFor(() => expect(within(insurance).queryByText(/Upload failed/)).not.toBeInTheDocument());
        expect(within(insurance).queryByRole('button', { name: /Retry|Trying again/ })).not.toBeInTheDocument();
        expect(sync.syncNow).toHaveBeenCalledTimes(1);
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('a cycle already under way that dropped the change counts too, though the one after the tap pushed', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await insertLocal('ship_documents', paper(LICENCE, 'Ship radio licence', 'Radio/MMSI'));
        await refuses(INSURANCE, 'new row violates row-level security policy for table "ship_documents"');
        render(<DocumentsHub onBack={vi.fn()} />);

        const running = deferred<CycleResult>();
        sync.getSyncStatus.mockReturnValue('syncing');
        sync.syncNow.mockReturnValueOnce(running.promise).mockImplementationOnce(async () => {
            await uploads(LICENCE);
            return { pushed: 1, pulled: 0, errors: [] };
        });
        fireEvent.click(
            within(await findCard('Hull insurance, Horta to Papeete')).getByRole('button', { name: /Retry/ }),
        );
        await waitFor(() => expect(sync.syncNow).toHaveBeenCalledTimes(1));

        // The cycle under way put the refused change back in line, and dropped it.
        sync.getSyncStatus.mockReturnValue('idle');
        await dropped(INSURANCE);
        await act(async () => {
            running.resolve({ pushed: 0, pulled: 0, errors: [], discardedShared: 1, sharedOwnerIds: [SKIPPER] });
        });

        await waitFor(() => expect(sync.syncNow).toHaveBeenCalledTimes(2));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: /Trying again/ })).not.toBeInTheDocument(),
        );
        expect(within(card('Hull insurance, Horta to Papeete')).queryByText(/Upload failed/)).not.toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('Retry with no signal says it goes by itself once back online, and runs nothing', async () => {
        await insertLocal('ship_documents', paper(INSURANCE, 'Hull insurance, Horta to Papeete'));
        await refuses(INSURANCE, 'TypeError: Load failed');
        render(<DocumentsHub onBack={vi.fn()} />);
        const insurance = await findCard('Hull insurance, Horta to Papeete');
        setOnline(false);

        fireEvent.click(within(insurance).getByRole('button', { name: /Retry/ }));

        expect(toast.info).toHaveBeenCalledWith("No signal. It uploads by itself once you're back online.");
        expect(sync.syncNow).not.toHaveBeenCalled();
    });
});

describe('Documents: opening it forces no full pull, and it still follows other devices', () => {
    it('opening Documents asks for no full pull and says nothing was "restored"', async () => {
        await mergePulledRecords('ship_documents', [paper(LICENCE, 'Ship radio licence', 'Radio/MMSI')]);
        render(<DocumentsHub onBack={vi.fn()} />);
        await screen.findByText('Ship radio licence');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });

        expect(sync.forceFullPull).not.toHaveBeenCalled();
        expect(sync.requestFullReconciliation).not.toHaveBeenCalled();
        expect(sync.syncNow).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('Restored'));
    });

    it('a sync that pulled a paper filed on the iPad brings it onto the open page', async () => {
        render(<DocumentsHub onBack={vi.fn()} />);
        await screen.findByText('No documents filed');

        await mergePulledRecords('ship_documents', [paper(LICENCE, 'Ship radio licence', 'Radio/MMSI')]);
        cycleEnds({ pushed: 0, pulled: 1, errors: [] });

        expect(await screen.findByText('Ship radio licence')).toBeInTheDocument();
        expect(within(card('Ship radio licence')).queryByText('Not uploaded yet')).not.toBeInTheDocument();
    });
});
