import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    equipmentRows: [] as any[],
    documentRows: [] as any[],
    checklistRows: [] as any[],
    equipmentCreate: vi.fn(),
    pullDocuments: vi.fn(),
    checklistSaveRun: vi.fn(),
    maintenanceCreate: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
}));

vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../components/Toast', () => ({
    toast: {
        success: mocks.toastSuccess,
        error: mocks.toastError,
        info: mocks.toastInfo,
    },
}));
vi.mock('../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label, onConfirm }: { label: string; onConfirm: () => void }) => (
        <button type="button" onClick={onConfirm}>
            {label}
        </button>
    ),
}));
vi.mock('../services/vessel/LocalEquipmentService', () => ({
    LocalEquipmentService: {
        getAll: vi.fn(() => mocks.equipmentRows),
        create: (...args: unknown[]) => mocks.equipmentCreate(...args),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: {
        getAll: vi.fn(() => mocks.documentRows),
        create: vi.fn().mockResolvedValue({ id: 'document-new' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        pullFromCloud: (...args: unknown[]) => mocks.pullDocuments(...args),
        getDownloadUrl: vi.fn(async (uri: string) => uri),
        openDownload: vi.fn().mockResolvedValue(undefined),
        markForSync: vi.fn(),
        markDeleted: vi.fn(),
        pendingCount: 0,
    },
}));
vi.mock('../services/vessel/LocalChecklistService', () => ({
    LocalChecklistService: {
        getAll: vi.fn(() => mocks.checklistRows),
        create: vi.fn().mockResolvedValue({ id: 'checklist-new' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
        saveRun: (...args: unknown[]) => mocks.checklistSaveRun(...args),
    },
}));
vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        createTask: (...args: unknown[]) => mocks.maintenanceCreate(...args),
    },
}));
vi.mock('../services/vessel/LocalDatabase', () => ({
    generateUUID: vi.fn(() => 'run-a'),
}));
vi.mock('../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: vi.fn().mockResolvedValue(undefined) }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { EquipmentList } from '../components/vessel/EquipmentList';
import { DocumentsHub } from '../components/vessel/DocumentsHub';
import { ChecklistsPage } from '../components/vessel/ChecklistsPage';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const equipmentA = {
    id: 'equipment-a',
    user_id: 'account-a',
    equipment_name: 'A private windlass',
    category: 'Electronics' as const,
    make: 'A',
    model: 'One',
    serial_number: 'PRIVATE-A',
    installation_date: null,
    warranty_expiry: null,
    manual_uri: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
};

const documentA = {
    id: 'document-a',
    user_id: 'account-a',
    document_name: 'A private insurance policy',
    category: 'Insurance' as const,
    issue_date: null,
    expiry_date: null,
    file_uri: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
};

const checklistA = [
    {
        id: 'heading-a',
        type: 'heading' as const,
        text: 'A private departure',
        heading_id: null,
        order: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    },
    {
        id: 'item-a',
        type: 'detail' as const,
        text: 'A private bilge check',
        heading_id: 'heading-a',
        order: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    },
];

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    mocks.equipmentRows = [equipmentA];
    mocks.documentRows = [documentA];
    mocks.checklistRows = checklistA;
    mocks.equipmentCreate.mockResolvedValue({ id: 'equipment-new' });
    mocks.pullDocuments.mockResolvedValue(0);
    mocks.checklistSaveRun.mockResolvedValue({});
    mocks.maintenanceCreate.mockResolvedValue({});
});

describe('vessel office identity boundary', () => {
    it('clears A equipment/form state and suppresses a deferred A create completion in B', async () => {
        const create = deferred<{ id: string }>();
        mocks.equipmentCreate.mockReturnValueOnce(create.promise);
        render(<EquipmentList onBack={vi.fn()} />);
        expect(await screen.findByText('A private windlass')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Slide to Add Equipment' }));
        fireEvent.change(screen.getByRole('textbox', { name: /^Equipment Name/ }), {
            target: { value: 'A pending radar' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Register new equipment' }));
        await waitFor(() => expect(mocks.equipmentCreate).toHaveBeenCalledOnce());

        mocks.equipmentRows = [];
        act(() => setAuthIdentityScope('account-b'));
        expect(screen.queryByText('A private windlass')).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue('A pending radar')).not.toBeInTheDocument();

        create.resolve({ id: 'equipment-new' });
        await act(async () => Promise.resolve());
        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Equipment registered');
    });

    it('clears A documents/selections and ignores a deferred A cloud restore', async () => {
        const pull = deferred<number>();
        mocks.pullDocuments.mockReturnValueOnce(pull.promise);
        render(<DocumentsHub onBack={vi.fn()} />);
        expect(await screen.findByText('A private insurance policy')).toBeInTheDocument();

        fireEvent.click(screen.getByText('A private insurance policy'));
        mocks.documentRows = [];
        act(() => setAuthIdentityScope('account-b'));
        expect(screen.queryByText('A private insurance policy')).not.toBeInTheDocument();

        pull.resolve(1);
        await act(async () => Promise.resolve());
        expect(mocks.toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining('Restored'));
    });

    it('closes A run state and suppresses a deferred A run completion in B', async () => {
        const saveRun = deferred<Record<string, never>>();
        mocks.checklistSaveRun.mockReturnValueOnce(saveRun.promise);
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(await screen.findByText('A private bilge check')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Run checklist inspection' }));
        fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        await waitFor(() => expect(mocks.checklistSaveRun).toHaveBeenCalledOnce());

        mocks.checklistRows = [];
        act(() => setAuthIdentityScope('account-b'));
        expect(screen.queryByRole('dialog', { name: 'Run Checklist' })).not.toBeInTheDocument();
        expect(screen.queryByText('A private bilge check')).not.toBeInTheDocument();

        saveRun.resolve({});
        await act(async () => Promise.resolve());
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining('Checklist complete'));
        expect(mocks.maintenanceCreate).not.toHaveBeenCalled();
    });
});
