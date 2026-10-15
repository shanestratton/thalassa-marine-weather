/**
 * Equipment's one 'Share or save' row (130-B8; binder audit EQ-10): the
 * register went out with 'Vessel' for the boat's name, and a second tap while
 * the first PDF was being made started another. Crew on a skipper's shared
 * register get his boat's name, not their own from settings.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem } from '../../types';

const mocks = vi.hoisted(() => ({
    rows: [] as EquipmentItem[],
    exportPdf: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
}));

vi.mock('../../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));
vi.mock('../../services/vessel/LocalEquipmentService', () => ({
    LocalEquipmentService: {
        getAll: vi.fn(() => mocks.rows),
        create: vi.fn().mockResolvedValue({ id: 'equipment-new' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        pullFromCloud: vi.fn().mockResolvedValue(0),
        getDownloadUrl: vi.fn(async (uri: string) => uri),
        openDownload: vi.fn().mockResolvedValue(undefined),
        markForSync: vi.fn(),
        markDeleted: vi.fn(),
        pendingCount: 0,
    },
}));
vi.mock('../../services/vessel/LocalDatabase', () => ({ generateUUID: vi.fn(() => 'id'), getById: vi.fn() }));
vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: '  Serene Example  ' } } }),
}));
vi.mock('../../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: mocks.exportPdf }));

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../../services/vessel/sharedBinders';
import { EquipmentList } from '../../components/vessel/EquipmentList';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const windlass: EquipmentItem = {
    id: 'equipment-a',
    user_id: 'account-a',
    equipment_name: 'Anchor windlass',
    category: 'Rigging',
    make: 'Example Winches',
    model: 'W-1000',
    serial_number: 'W-0001',
    installation_date: null,
    warranty_expiry: null,
    manual_uri: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
};

async function openMenu() {
    render(<EquipmentList onBack={vi.fn()} />);
    await screen.findByText('Anchor windlass');
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
}

/** This sailor is crew on a skipper's boat that shares Equipment (shared binders, 2026-10-02). */
function crewOnSharedEquipment(vesselName: string | null): void {
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1', getAuthIdentityScope()),
        JSON.stringify({
            version: 1,
            userId: 'account-a',
            confirmedAt: '2026-10-14T00:00:00.000Z',
            skippers: [
                {
                    ownerId: 'skipper-b',
                    vesselName,
                    lastAcceptedAt: '2026-10-14T00:00:00.000Z',
                    registers: { equipment: { read: true, write: true } },
                },
            ],
        }),
    );
    reloadSharedBindersFromStorage();
}

describe('Equipment: Share or save', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        setAuthIdentityScope('account-a');
        reloadSharedBindersFromStorage();
        mocks.rows = [windlass];
        mocks.exportPdf.mockResolvedValue('shared');
    });

    it("shares the register under the boat's name, from one row", async () => {
        await openMenu();
        expect(screen.queryByRole('button', { name: /Export to PDF/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        await waitFor(() =>
            expect(mocks.exportPdf).toHaveBeenCalledWith(
                [expect.objectContaining({ id: 'equipment-a' })],
                'Serene Example',
            ),
        );
        // The share sheet speaks for itself.
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it("prints the skipper's boat on his shared register, not the crew member's own", async () => {
        crewOnSharedEquipment('Wind Dancer');
        await openMenu();
        expect(screen.getByText(/Shared from Wind Dancer/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        await waitFor(() =>
            expect(mocks.exportPdf).toHaveBeenCalledWith([expect.objectContaining({ id: 'equipment-a' })], 'Wind Dancer'),
        );
    });

    it("prints no name when the skipper's boat has none, rather than the crew member's", async () => {
        crewOnSharedEquipment(null);
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalledTimes(1));
        expect(mocks.exportPdf.mock.calls[0][1]).toBeUndefined();
    });

    it('starts no second PDF while one is being made', async () => {
        const exported = deferred<string>();
        mocks.exportPdf.mockReturnValue(exported.promise);
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        const row = screen.getByRole('button', { name: 'Share or save equipment list' });
        expect(row).toBeDisabled();
        fireEvent.click(row);
        expect(mocks.exportPdf).toHaveBeenCalledTimes(1);
        await act(async () => exported.resolve('cancelled'));
        expect(screen.getByRole('button', { name: 'Share or save equipment list' })).toBeEnabled();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('says downloaded only on a download, and owns up to a failure', async () => {
        mocks.exportPdf.mockResolvedValueOnce('downloaded').mockRejectedValueOnce(new Error('no canvas'));
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('PDF downloaded'));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not make the PDF. Try again.'));
    });

    it('says so instead of sending a blank register', async () => {
        mocks.exportPdf.mockResolvedValue('empty');
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save equipment list' }));
        await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('No equipment to put on the register yet.'));
    });
});
