/**
 * Crew IDs stay with the skipper (126-B4, binder audit DOC-3).
 *
 * The server keeps 'Crew Visas/IDs' papers for the binder's owner. So a crew
 * member filing into a skipper's shared Documents is never offered Crew IDs:
 * the outbox's UPDATE ... RETURNING on a paper moved into a category they can
 * no longer read is refused with 42501 and would be retried forever. Nor
 * does the shared binder list one a crew phone synced before the push: it
 * could neither be kept up to date nor edited. The skipper is told, once,
 * that the group is theirs alone.
 *
 * The real DocumentForm and the real DocumentsHub (its services faked), with
 * fictional papers on the fictional 'Kestrel': skipper 'skipper-1', crew
 * 'crew-1'.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentCategory, ShipDocument } from '../types';

const hoisted = vi.hoisted(() => ({ docs: [] as ShipDocument[] }));

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));
vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: {
        getAll: () => hoisted.docs,
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        getDownloadUrl: vi.fn(),
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
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { DocumentForm } from '../components/vessel/documents/DocumentForm';
import { DocumentsHub } from '../components/vessel/DocumentsHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';

const AT = '2026-10-09T01:00:00.000Z';
const OWNER_LINE = 'Only you see crew IDs, even when you share Documents with crew.';

function paper(id: string, name: string, category: DocumentCategory): ShipDocument {
    return {
        id,
        user_id: 'skipper-1',
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

const REGISTO = paper('3d2c1b0a-0000-4000-8000-000000000001', 'Registo de Propriedade', 'Registration');
const PASSPORT = paper('3d2c1b0a-0000-4000-8000-000000000002', 'Passport — Kenji Mori', 'Crew Visas/IDs');
const RADIO = paper('3d2c1b0a-0000-4000-8000-000000000003', 'Licença de rádio', 'Radio/MMSI');

function Form({
    category,
    crewView,
    onCategoryChange = vi.fn(),
}: {
    category: DocumentCategory;
    crewView?: boolean;
    onCategoryChange?: (category: DocumentCategory) => void;
}) {
    return (
        <DocumentForm
            isEdit={false}
            formName="Passport — Ana Ribeiro"
            formCategory={category}
            formIssueDate=""
            formExpiryDate=""
            formNotes=""
            formFileUri={null}
            formFileName={null}
            onNameChange={vi.fn()}
            onCategoryChange={onCategoryChange}
            onIssueDateChange={vi.fn()}
            onExpiryDateChange={vi.fn()}
            onNotesChange={vi.fn()}
            onFileSelect={vi.fn()}
            onRemoveFile={vi.fn()}
            onSave={vi.fn()}
            crewView={crewView}
        />
    );
}

const pills = () => screen.getAllByRole('button', { name: / category$/ });

describe('DocumentForm: Crew IDs in a shared binder', () => {
    it('crew are not offered Crew IDs; the other five stay in the same three-column grid (two rows)', () => {
        render(<Form category="Registration" crewView />);
        expect(screen.queryByRole('button', { name: 'Crew IDs category' })).toBeNull();
        expect(pills().map((pill) => pill.getAttribute('aria-label'))).toEqual([
            'Registration category',
            'Insurance category',
            'Radio/MMSI category',
            'Customs category',
            'Manuals category',
        ]);
        const grid = pills()[0].parentElement as HTMLElement;
        expect(grid.className).toContain('grid-cols-3');
        expect(Math.ceil(grid.children.length / 3)).toBe(2);
        expect(screen.queryByText(OWNER_LINE)).toBeNull();
    });

    it('crew are never offered Crew IDs, whatever the form opened with', () => {
        // DocumentsHub lists no crew IDs to crew, so this cannot open; if it
        // did, the pill stays away and nothing reads as picked.
        render(<Form category="Crew Visas/IDs" crewView />);
        expect(screen.queryByRole('button', { name: 'Crew IDs category' })).toBeNull();
        expect(pills()).toHaveLength(5);
        expect(pills().some((pill) => pill.getAttribute('aria-pressed') === 'true')).toBe(false);
        // The crew view never shows the owner's line.
        expect(screen.queryByText(OWNER_LINE)).toBeNull();
    });

    it("the owner sees all six, and the 'only you' line only while Crew IDs is picked", () => {
        function Host() {
            const [category, setCategory] = React.useState<DocumentCategory>('Registration');
            return <Form category={category} onCategoryChange={setCategory} />;
        }
        render(<Host />);
        expect(pills()).toHaveLength(6);
        expect(screen.queryByText(OWNER_LINE)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Crew IDs category' }));
        expect(screen.getByText(OWNER_LINE)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Customs category' }));
        expect(screen.queryByText(OWNER_LINE)).toBeNull();
    });
});

const SNAPSHOT_KEY = 'thalassa_shared_binders_v1::user%3Acrew-1';

function shareDocuments() {
    act(() => {
        localStorage.setItem(
            SNAPSHOT_KEY,
            JSON.stringify({
                version: 1,
                userId: 'crew-1',
                confirmedAt: '2026-10-09T00:00:00.000Z',
                skippers: [
                    {
                        ownerId: 'skipper-1',
                        vesselName: 'Kestrel',
                        lastAcceptedAt: '2026-10-01T00:00:00.000Z',
                        registers: {
                            stores: { read: false, write: false },
                            equipment: { read: false, write: false },
                            maintenance: { read: false, write: false },
                            documents: { read: true, write: true },
                        },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    });
}

describe("DocumentsHub: the skipper's Documents shared with crew", () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        localStorage.clear();
    });

    it('a crew member is never offered Crew IDs, adding or editing', async () => {
        setAuthIdentityScope('crew-1');
        shareDocuments();
        // What the server serves crew after 20261010110000: no ID papers.
        hoisted.docs = [REGISTO, RADIO];
        render(<DocumentsHub onBack={vi.fn()} />);

        expect(await screen.findByText('Registo de Propriedade')).toBeInTheDocument();
        expect(screen.getByText(/Kestrel/)).toBeInTheDocument();
        expect(screen.queryByText(/only you/i)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
        let sheet = screen.getByRole('dialog', { name: 'Add document' });
        expect(within(sheet).queryByRole('button', { name: 'Crew IDs category' })).toBeNull();
        expect(within(sheet).getAllByRole('button', { name: / category$/ })).toHaveLength(5);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

        fireEvent.click(screen.getByRole('button', { name: 'Edit Registo de Propriedade' }));
        sheet = screen.getByRole('dialog', { name: 'Edit document' });
        expect(within(sheet).getByRole('button', { name: 'Registration category' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(within(sheet).queryByRole('button', { name: 'Crew IDs category' })).toBeNull();
    });

    it("a crew phone still holding the skipper's crew IDs never lists, counts or opens them", async () => {
        setAuthIdentityScope('crew-1');
        shareDocuments();
        // Synced before 20261010110000 was pushed (or before it is): the
        // passport is still in the local mirror, expired, with a cached scan.
        hoisted.docs = [
            REGISTO,
            {
                ...PASSPORT,
                expiry_date: '2021-03-31T00:00:00.000Z',
                file_uri: `supabase-storage://vessel_vault/skipper-1/documents/${PASSPORT.id}.jpg`,
            },
            RADIO,
        ];
        render(<DocumentsHub onBack={vi.fn()} />);

        expect(await screen.findByText('Registo de Propriedade')).toBeInTheDocument();
        expect(screen.getByText('Licença de rádio')).toBeInTheDocument();
        expect(screen.queryByText('Passport — Kenji Mori')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Edit Passport — Kenji Mori' })).toBeNull();
        expect(screen.queryByText(/^Crew IDs/)).toBeNull();
        // Not counted either: two papers, none expired.
        expect(screen.getByText(/^2 items/)).toBeInTheDocument();
        expect(screen.queryByText(/expired/)).toBeNull();
        // Nor found by a search.
        fireEvent.change(screen.getByRole('textbox', { name: 'Search documents' }), {
            target: { value: 'Passport' },
        });
        expect(screen.queryByText('Passport — Kenji Mori')).toBeNull();
        expect(screen.getByText('No documents match')).toBeInTheDocument();
    });

    it("the skipper's own Documents mark the Crew IDs group as theirs alone", async () => {
        setAuthIdentityScope('skipper-1');
        hoisted.docs = [REGISTO, PASSPORT, RADIO];
        render(<DocumentsHub onBack={vi.fn()} />);

        expect(await screen.findByText('Passport — Kenji Mori')).toBeInTheDocument();
        const header = screen.getByText(/^Crew IDs/);
        expect(header).toHaveTextContent('Crew IDs · only you');
        // Only that group says so.
        expect(screen.getAllByText(/only you/i)).toHaveLength(1);

        // The owner still files under Crew IDs, and is told who sees it.
        fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
        const sheet = screen.getByRole('dialog', { name: 'Add document' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Crew IDs category' }));
        expect(within(sheet).getByText(OWNER_LINE)).toBeInTheDocument();
    });
});
