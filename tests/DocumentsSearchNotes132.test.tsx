/**
 * Documents' search reads the notes too (132-B19). A policy number, an
 * agent's name or a callsign is written in a paper's notes, and searching for
 * it found nothing. The Add/Edit sheet's Save is pinned below its fields.
 *
 * DocumentFormCrewIds.test.tsx's harness: the real DocumentsHub, its services
 * faked, with fictional papers on the fictional 'Kestrel'.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
        uploadStates: () => ({}),
        onUploadsChanged: () => () => undefined,
        retryUploads: vi.fn().mockResolvedValue(undefined),
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

import { DocumentsHub } from '../components/vessel/DocumentsHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const AT = '2026-10-09T01:00:00.000Z';

function paper(id: string, name: string, category: DocumentCategory, notes: string | null = null): ShipDocument {
    return {
        id,
        user_id: 'skipper-1',
        document_name: name,
        category,
        issue_date: null,
        expiry_date: null,
        file_uri: null,
        notes,
        created_at: AT,
        updated_at: AT,
    };
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('skipper-1');
    hoisted.docs = [
        paper(
            '4e3d2c1b-0000-4000-8000-000000000001',
            'Hull insurance',
            'Insurance',
            'Policy KX-2231, agent Pico Marine',
        ),
        paper('4e3d2c1b-0000-4000-8000-000000000002', 'Ship radio licence', 'Radio/MMSI', 'Callsign VJN4417'),
        paper('4e3d2c1b-0000-4000-8000-000000000003', 'Registo de Propriedade', 'Registration'),
    ];
});

afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('Documents search', () => {
    it('finds a paper by what is written in its notes, as well as by its name', async () => {
        render(<DocumentsHub onBack={vi.fn()} />);
        expect(await screen.findByText('Registo de Propriedade')).toBeInTheDocument();
        const box = screen.getByRole('textbox', { name: 'Search documents' });
        expect(box).toHaveAttribute('placeholder', 'Search documents and notes…');

        fireEvent.change(box, { target: { value: 'kx-2231' } });
        expect(screen.getByText('Hull insurance')).toBeInTheDocument();
        expect(screen.queryByText('Ship radio licence')).toBeNull();
        expect(screen.queryByText('Registo de Propriedade')).toBeNull();

        fireEvent.change(box, { target: { value: 'VJN4417' } });
        expect(screen.getByText('Ship radio licence')).toBeInTheDocument();
        expect(screen.queryByText('Hull insurance')).toBeNull();

        // A paper with no notes is still found by its name.
        fireEvent.change(box, { target: { value: 'registo' } });
        expect(screen.getByText('Registo de Propriedade')).toBeInTheDocument();

        fireEvent.change(box, { target: { value: 'Lloyd' } });
        expect(screen.getByText('No documents match')).toBeInTheDocument();
    });

    it("the sheet's Save is pinned below its fields, and the notes are folded until wanted", async () => {
        render(<DocumentsHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Edit Registo de Propriedade' }));
        const sheet = screen.getByRole('dialog', { name: 'Edit document' });
        const footer = sheet.querySelector<HTMLElement>('[data-modal-sheet-footer]')!;
        const body = sheet.querySelector<HTMLElement>('[data-modal-sheet-body]')!;
        expect(within(footer).getByRole('button', { name: 'Save changes' })).toBeEnabled();
        expect(within(body).queryByRole('button', { name: 'Save changes' })).toBeNull();
        expect(within(body).getByRole('button', { name: 'Add notes' })).toBeInTheDocument();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

        fireEvent.click(screen.getByRole('button', { name: 'Edit Hull insurance' }));
        const insured = screen.getByRole('dialog', { name: 'Edit document' });
        expect(within(insured).getByLabelText('Notes (optional)')).toHaveValue('Policy KX-2231, agent Pico Marine');
        expect(within(insured).queryByRole('button', { name: 'Add notes' })).toBeNull();
    });
});
