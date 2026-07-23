import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getEquipment: vi.fn(),
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
}));

vi.mock('../services/vessel/LocalEquipmentService', () => ({
    LocalEquipmentService: {
        getAll: mocks.getEquipment,
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));
vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: mocks.getShoppingList,
    markPurchased: mocks.markPurchased,
    unmarkPurchased: mocks.unmarkPurchased,
    addManualItem: mocks.addManualItem,
    getVoyageBudget: vi.fn(),
}));
vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: (_name: string, qty: number, unit: string) => ({
        packageCount: qty,
        packageLabel: unit,
        matched: false,
    }),
}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn().mockReturnValue(null),
}));
vi.mock('../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
}));
vi.mock('../utils/equipmentPdfExport', () => ({
    exportEquipmentPdf: vi.fn(),
}));
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { EquipmentList } from '../components/vessel/EquipmentList';
import { GroceryListPage } from '../components/vessel/GroceryListPage';

const equipment = {
    id: 'equipment-1',
    user_id: 'user-1',
    equipment_name: 'Anchor Windlass',
    category: 'Electronics' as const,
    make: 'Muir',
    model: 'Storm 2200',
    serial_number: 'MW-2200-123',
    installation_date: '2025-01-01',
    warranty_expiry: '2028-01-01',
    manual_uri: '/manuals/windlass.pdf',
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
};

const groceryItem = {
    id: 'grocery-1',
    ingredient_name: 'Tomatoes',
    required_qty: 4,
    unit: 'each',
    market_zone: 'Produce' as const,
    actual_cost: null,
    currency: 'AUD',
    purchased: false,
    purchased_at: null,
    store_location: '',
    provision_id: null,
    voyage_id: null,
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
};

describe('vessel list dialog accessibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getEquipment.mockReturnValue([equipment]);
        mocks.getShoppingList.mockReturnValue({
            total: 1,
            purchased: 0,
            remaining: 1,
            totalCost: 0,
            currency: 'AUD',
            zones: [{ zone: 'Produce', items: [groceryItem] }],
        });
    });

    it('contains equipment actions, names each target, and restores the opener', async () => {
        render(<EquipmentList onBack={vi.fn()} />);
        const opener = await screen.findByRole('button', { name: 'Equipment options' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Anchor Windlass equipment actions' });
        const close = within(dialog).getByRole('button', { name: 'Close actions for Anchor Windlass' });
        expect(close).toHaveFocus();
        expect(within(dialog).getByRole('button', { name: 'View details for Anchor Windlass' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Copy serial number for Anchor Windlass' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Open manual for Anchor Windlass' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Edit Anchor Windlass' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Delete Anchor Windlass' })).toBeEnabled();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Anchor Windlass equipment actions/ })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('focuses and dismisses the purchase details dialog without committing', async () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        const opener = await screen.findByRole('button', { name: 'Mark Tomatoes as purchased' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: /Mark as Purchased/ });
        const price = within(dialog).getByRole('spinbutton', { name: 'Price (optional)' });
        expect(price).toHaveFocus();
        expect(within(dialog).getByRole('textbox', { name: 'Store (optional)' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Coles' })).toHaveAttribute('aria-pressed', 'false');

        fireEvent.keyDown(price, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
        expect(mocks.markPurchased).not.toHaveBeenCalled();
        expect(opener).toHaveFocus();
    });

    it('labels the add-item form and restores its opener after Escape', async () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        await screen.findByText('Tomatoes');
        const opener = screen.getByRole('button', { name: 'Add item' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: /Add to Shopping List/ });
        const name = within(dialog).getByRole('textbox', { name: 'Item Name' });
        expect(name).toHaveFocus();
        expect(within(dialog).getByRole('spinbutton', { name: 'Qty' })).toBeEnabled();
        expect(within(dialog).getByRole('combobox', { name: 'Unit' })).toBeEnabled();
        const zones = within(dialog).getByRole('group', { name: 'Aisle / Zone' });
        expect(within(zones).getByRole('button', { name: /Produce/ })).toHaveAttribute('aria-pressed', 'false');

        fireEvent.keyDown(name, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Add to Shopping List/ })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });
});
