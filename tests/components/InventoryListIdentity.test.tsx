import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../../services/authIdentityScope';
import type { InventoryItem } from '../../types';

const mocks = vi.hoisted(() => ({
    getAll: vi.fn(),
    getStats: vi.fn(),
    deduplicateByName: vi.fn(),
    update: vi.fn(),
    deleteItem: vi.fn(),
    adjustQuantity: vi.fn(),
    initLocalDatabase: vi.fn(),
    downloadPdf: vi.fn(),
    sharePdf: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    haptic: vi.fn(),
    flash: vi.fn(),
    undoProps: null as null | { onUndo: () => void; onDismiss: () => void },
}));

vi.mock('../../services/vessel/LocalInventoryService', () => ({
    LocalInventoryService: {
        getAll: mocks.getAll,
        getStats: mocks.getStats,
        deduplicateByName: mocks.deduplicateByName,
        update: mocks.update,
        delete: mocks.deleteItem,
        adjustQuantity: mocks.adjustQuantity,
    },
}));

vi.mock('../../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: mocks.initLocalDatabase,
}));

vi.mock('../../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
}));

vi.mock('../../hooks/useSuccessFlash', () => ({
    useSuccessFlash: () => ({ ref: { current: null }, flash: mocks.flash }),
}));

vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Account A Vessel' } } }),
}));

vi.mock('../../utils/inventoryPdfExport', () => ({
    downloadInventoryPdf: mocks.downloadPdf,
    shareInventoryPdf: mocks.sharePdf,
}));

vi.mock('../../utils/system', () => ({ triggerHaptic: mocks.haptic }));
vi.mock('../../components/Toast', () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {action}
        </header>
    ),
}));

vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label, onConfirm }: { label: string; onConfirm: () => void }) => (
        <button onClick={onConfirm}>{label}</button>
    ),
}));

vi.mock('../../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, title }: { children: React.ReactNode; title: string }) => (
        <section aria-label={title}>{children}</section>
    ),
}));

vi.mock('../../components/ui/UndoToast', () => ({
    UndoToast: (props: { isOpen: boolean; onUndo: () => void; onDismiss: () => void }) => {
        if (props.isOpen) mocks.undoProps = props;
        return null;
    },
}));

vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../components/ui/ShimmerBlock', () => ({
    ShimmerBlock: () => <div>Loading inventory</div>,
}));

vi.mock('../../components/ui/OfflineBadge', () => ({ OfflineBadge: () => null }));

vi.mock('../../components/vessel/InventoryScanner', () => ({
    InventoryScanner: () => <div data-testid="inventory-scanner">Scanner</div>,
}));

vi.mock('../../components/vessel/inventory/SwipeableInventoryCard', () => ({
    SwipeableInventoryCard: ({
        item,
        onEdit,
        onDelete,
        onQuantityAdjust,
    }: {
        item: InventoryItem;
        onEdit: () => void;
        onDelete: () => void;
        onQuantityAdjust: (id: string, delta: number) => void;
    }) => (
        <article>
            <span>{item.item_name}</span>
            <button onClick={onEdit}>Edit {item.item_name}</button>
            <button onClick={onDelete}>Delete {item.item_name}</button>
            <button onClick={() => onQuantityAdjust(item.id, 1)}>Increase {item.item_name}</button>
        </article>
    ),
}));

import { InventoryList } from '../../components/vessel/InventoryList';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const item = (id: string, name: string): InventoryItem => ({
    id,
    user_id: id.startsWith('a') ? 'account-a' : 'account-b',
    barcode: null,
    item_name: name,
    description: null,
    category: 'Provisions',
    quantity: 2,
    min_quantity: 1,
    unit: 'each',
    currency: null,
    unit_value: null,
    unit_system: null,
    location_zone: 'Galley',
    location_specific: null,
    expiry_date: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
});

const stats = (count: number) => ({ totalItems: count, totalQuantity: count * 2, lowStock: 0 });

describe('InventoryList identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.undoProps = null;
        localStorage.clear();
        setAuthIdentityScope(null);
        const accountA = setAuthIdentityScope('account-a');
        localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', accountA), '1');
        mocks.getAll.mockResolvedValue([item('a-item', 'Private A stores')]);
        mocks.getStats.mockResolvedValue(stats(1));
        mocks.deduplicateByName.mockResolvedValue(0);
        mocks.update.mockResolvedValue(item('a-item', 'Updated A stores'));
        mocks.deleteItem.mockResolvedValue(undefined);
        mocks.adjustQuantity.mockResolvedValue(item('a-item', 'Private A stores'));
        mocks.initLocalDatabase.mockResolvedValue(undefined);
        mocks.downloadPdf.mockResolvedValue(undefined);
        mocks.sharePdf.mockResolvedValue(undefined);
    });

    it('erases A data and edit state before a deferred B load resolves', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Edit Private A stores' }));
        expect(screen.getByRole('region', { name: 'Edit Item' })).toBeInTheDocument();

        const accountBLoad = deferred<InventoryItem[]>();
        mocks.getAll.mockReturnValueOnce(accountBLoad.promise);
        mocks.getStats.mockResolvedValueOnce(stats(1));

        act(() => {
            const accountB = setAuthIdentityScope('account-b');
            localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', accountB), '1');
        });

        expect(screen.queryByText('Private A stores')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Edit Item' })).not.toBeInTheDocument();

        accountBLoad.resolve([item('b-item', 'Private B stores')]);
        await screen.findByText('Private B stores');
        expect(screen.queryByText('Private A stores')).not.toBeInTheDocument();

        mocks.getAll.mockResolvedValueOnce([item('a-item', 'Private A stores')]);
        act(() => setAuthIdentityScope('account-a'));
        await screen.findByText('Private A stores');
        expect(screen.queryByText('Private B stores')).not.toBeInTheDocument();
    });

    it('drops a deferred A edit completion after switching to B', async () => {
        const update = deferred<InventoryItem | null>();
        mocks.update.mockReturnValue(update.promise);
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Edit Private A stores' }));

        fireEvent.click(screen.getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a-item', expect.any(Object)));

        const accountBLoad = deferred<InventoryItem[]>();
        mocks.getAll.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        update.resolve(item('a-item', 'Updated A stores'));
        await act(async () => update.promise);

        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Item updated');
        expect(mocks.flash).not.toHaveBeenCalled();
        expect(screen.queryByText('Updated A stores')).not.toBeInTheDocument();

        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it('rejects an old A undo timer callback after B becomes active', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Delete Private A stores' }));
        const staleDismiss = mocks.undoProps?.onDismiss;
        expect(staleDismiss).toBeTypeOf('function');

        const accountBLoad = deferred<InventoryItem[]>();
        mocks.getAll.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        await act(async () => staleDismiss?.());

        expect(mocks.deleteItem).not.toHaveBeenCalled();
        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it('runs the deduplication migration independently for A and B', async () => {
        localStorage.clear();
        mocks.getAll.mockResolvedValue([]);
        mocks.getStats.mockResolvedValue(stats(0));
        render(<InventoryList onBack={vi.fn()} />);
        await waitFor(() => expect(mocks.deduplicateByName).toHaveBeenCalledTimes(1));
        expect(
            localStorage.getItem(authScopedStorageKey('thalassa_inventory_deduped', setAuthIdentityScope('account-a'))),
        ).toBe('1');

        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(mocks.deduplicateByName).toHaveBeenCalledTimes(2));
        expect(
            localStorage.getItem(authScopedStorageKey('thalassa_inventory_deduped', setAuthIdentityScope('account-b'))),
        ).toBe('1');
    });

    it('never reads the local cache until the captured account switch is ready', async () => {
        const accountAReady = deferred<void>();
        mocks.initLocalDatabase.mockReturnValueOnce(accountAReady.promise);
        mocks.getAll.mockResolvedValueOnce([]);
        render(<InventoryList onBack={vi.fn()} />);
        await waitFor(() => expect(mocks.initLocalDatabase).toHaveBeenCalledWith('account-a'));
        expect(mocks.getAll).not.toHaveBeenCalled();

        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(mocks.getAll).toHaveBeenCalledTimes(1));
        accountAReady.resolve();
        await act(async () => accountAReady.promise);

        expect(mocks.getAll).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Private A stores')).not.toBeInTheDocument();
    });
});
