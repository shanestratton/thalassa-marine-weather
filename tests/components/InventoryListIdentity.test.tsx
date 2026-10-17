import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../../services/vessel/sharedBinders';
import type { InventoryItem } from '../../types';

const mocks = vi.hoisted(() => ({
    getAll: vi.fn(),
    getStats: vi.fn(),
    deduplicateByName: vi.fn(),
    update: vi.fn(),
    deleteItem: vi.fn(),
    adjustQuantity: vi.fn(),
    initLocalDatabase: vi.fn(),
    sharePdf: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
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
    shareInventoryPdf: mocks.sharePdf,
}));

vi.mock('../../utils/system', () => ({ triggerHaptic: mocks.haptic }));
vi.mock('../../components/Toast', () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));

vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action, status }: { title: string; action?: React.ReactNode; status?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {status}
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
    // The sheet's pinned main button too (132-B19).
    ModalSheet: ({
        children,
        title,
        footer,
    }: {
        children: React.ReactNode;
        title: string;
        footer?: React.ReactNode;
    }) => (
        <section aria-label={title}>
            {children}
            {footer}
        </section>
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
        mocks.sharePdf.mockResolvedValue('shared');
    });

    it('erases A data and edit state before a deferred B load resolves', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Edit Private A stores' }));
        expect(screen.getByRole('region', { name: 'Edit item' })).toBeInTheDocument();

        const accountBLoad = deferred<InventoryItem[]>();
        mocks.getAll.mockReturnValueOnce(accountBLoad.promise);
        mocks.getStats.mockResolvedValueOnce(stats(1));

        act(() => {
            const accountB = setAuthIdentityScope('account-b');
            localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', accountB), '1');
        });

        expect(screen.queryByText('Private A stores')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Edit item' })).not.toBeInTheDocument();

        accountBLoad.resolve([item('b-item', 'Private B stores')]);
        await screen.findByText('Private B stores');
        expect(screen.queryByText('Private A stores')).not.toBeInTheDocument();

        mocks.getAll.mockResolvedValueOnce([item('a-item', 'Private A stores')]);
        act(() => setAuthIdentityScope('account-a'));
        await screen.findByText('Private A stores');
        expect(screen.queryByText('Private B stores')).not.toBeInTheDocument();
    });

    it('keeps the edit category chooser three-by-five and saves its selection', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Edit Private A stores' }));
        const grid = screen.getByRole('group', { name: 'Store category' });
        expect(grid).toHaveClass('grid-cols-3');
        expect(within(grid).getAllByRole('button')).toHaveLength(15);
        fireEvent.click(within(grid).getByRole('button', { name: 'Cleaning' }));
        expect(within(grid).getByRole('button', { name: 'Cleaning' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() =>
            expect(mocks.update).toHaveBeenCalledWith('a-item', expect.objectContaining({ category: 'Cleaning' })),
        );
    });

    it('drops a deferred A edit completion after switching to B', async () => {
        const update = deferred<InventoryItem | null>();
        mocks.update.mockReturnValue(update.promise);
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Edit Private A stores' }));
        // A real change: a Save with nothing changed writes nothing (126-B9c).
        fireEvent.change(screen.getByLabelText(/Item name/), { target: { value: 'Renamed A stores' } });

        fireEvent.click(screen.getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('a-item', { item_name: 'Renamed A stores' }));

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

/**
 * One 'Share or save' row (130-B8; binder audit STORES-01): Download called
 * jsPDF's save(), which does nothing in the iPhone app, then said the PDF was
 * downloaded. Crew on a skipper's shared stores get his boat's name.
 */
describe("Ship's Stores: Share or save", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        setAuthIdentityScope(null);
        const accountA = setAuthIdentityScope('account-a');
        localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', accountA), '1');
        mocks.getAll.mockResolvedValue([item('a-item', 'Private A stores')]);
        mocks.deduplicateByName.mockResolvedValue(0);
        mocks.initLocalDatabase.mockResolvedValue(undefined);
        mocks.sharePdf.mockResolvedValue('shared');
    });

    async function openPicker() {
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Share or save stores list' }));
        return screen.getByRole('region', { name: 'Share or save stores list' });
    }

    it('has one row, and no Download that does nothing on an iPhone', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Private A stores');
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        // One menu item in the ⋮, Diary's menu (132-B20).
        expect(screen.getAllByRole('menuitem')).toHaveLength(1);
        expect(screen.getByRole('menuitem', { name: 'Share or save stores list' })).toBeEnabled();
        expect(screen.queryByRole('menuitem', { name: /Download/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Share stores list/ })).not.toBeInTheDocument();
    });

    it("shares the stores on screen under the boat's name, once however fast the second tap", async () => {
        const shared = deferred<string>();
        mocks.sharePdf.mockReturnValue(shared.promise);
        const picker = await openPicker();
        const button = within(picker).getByRole('button', { name: 'Share or save all categories' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(mocks.sharePdf).toHaveBeenCalledTimes(1);
        expect(mocks.sharePdf).toHaveBeenCalledWith({
            items: [expect.objectContaining({ id: 'a-item' })],
            categories: new Set(),
            vesselName: 'Account A Vessel',
            units: 'metric',
        });
        expect(within(picker).getByRole('button', { name: 'Making the PDF…' })).toBeDisabled();
        await act(async () => shared.resolve('shared'));
        // The share sheet speaks for itself: no toast, and the picker closes.
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(screen.queryByRole('region', { name: 'Share or save stores list' })).not.toBeInTheDocument();
    });

    it("prints the skipper's boat on his shared stores, not the crew member's own", async () => {
        // Crew on a skipper's boat that shares Ship's Stores (shared binders, 2026-10-02).
        localStorage.setItem(
            authScopedStorageKey('thalassa_shared_binders_v1', getAuthIdentityScope()),
            JSON.stringify({
                version: 1,
                userId: 'account-a',
                confirmedAt: '2026-10-14T00:00:00.000Z',
                skippers: [
                    {
                        ownerId: 'skipper-b',
                        vesselName: 'Wind Dancer',
                        lastAcceptedAt: '2026-10-14T00:00:00.000Z',
                        registers: { stores: { read: true, write: true } },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
        const picker = await openPicker();
        expect(screen.getByText(/Shared from Wind Dancer/)).toBeInTheDocument();
        fireEvent.click(within(picker).getByRole('button', { name: 'Share or save all categories' }));
        await waitFor(() =>
            expect(mocks.sharePdf).toHaveBeenCalledWith({
                items: [expect.objectContaining({ id: 'a-item' })],
                categories: new Set(),
                vesselName: 'Wind Dancer',
                units: 'metric',
            }),
        );
    });

    it('says downloaded only when the web downloaded it', async () => {
        mocks.sharePdf.mockResolvedValue('downloaded');
        const picker = await openPicker();
        fireEvent.click(within(picker).getByRole('button', { name: 'Share or save all categories' }));
        await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Stores PDF downloaded'));
    });

    it('leaves the picker open when the share sheet is dismissed', async () => {
        mocks.sharePdf.mockResolvedValue('cancelled');
        const picker = await openPicker();
        fireEvent.click(within(picker).getByRole('button', { name: 'Share or save all categories' }));
        await waitFor(() => expect(mocks.sharePdf).toHaveBeenCalledTimes(1));
        await act(async () => Promise.resolve());
        expect(screen.getByRole('region', { name: 'Share or save stores list' })).toBeInTheDocument();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(within(picker).getByRole('button', { name: 'Share or save all categories' })).toBeEnabled();
    });

    it('never offers a blank PDF: a choice with nothing in it says so and waits', async () => {
        const picker = await openPicker();
        fireEvent.click(within(picker).getByRole('button', { name: 'Engine, 0 items' }));
        const button = within(picker).getByRole('button', { name: 'Nothing in those categories yet' });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(mocks.sharePdf).not.toHaveBeenCalled();
        fireEvent.click(within(picker).getByRole('button', { name: 'Provisions, 1 item' }));
        expect(within(picker).getByRole('button', { name: 'Share or save 2 categories' })).toBeEnabled();
    });

    it('says so when the PDF cannot be made, and lets the skipper try again', async () => {
        mocks.sharePdf.mockRejectedValueOnce(new Error('no canvas'));
        const picker = await openPicker();
        fireEvent.click(within(picker).getByRole('button', { name: 'Share or save all categories' }));
        await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not make the PDF. Try again.'));
        expect(within(picker).getByRole('button', { name: 'Share or save all categories' })).toBeEnabled();
    });
});
