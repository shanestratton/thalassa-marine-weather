import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getEquipment: vi.fn(),
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    // ── Vessel release dialogs (2026-09-08 decision) ─────────────────────
    /** The mocked settings store's state; the selector hook reads straight from it. */
    fleetStore: { settings: {} } as Record<string, unknown>,
    releaseVesselProfile: vi.fn(),
    undoVesselRelease: vi.fn(),
    patchActiveVesselProfile: vi.fn(),
    dismissVesselClaimConflict: vi.fn(),
    releaseBlockedReason: vi.fn(),
    getCachedActiveVoyage: vi.fn(() => null as unknown),
    getActiveVoyage: vi.fn(),
    piStatus: vi.fn(),
    piPing: vi.fn(),
    /** A paired Pi (or null): the dialog may only refresh a Pi it is paired to. */
    getPairing: vi.fn(() => null as unknown),
    /** What the boat_members head-count query resolves to. */
    crewQuery: { count: 0 as number | null, error: null as unknown },
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
    reconcileGroceryInventoryMirror: vi.fn(async () => ({ repaired: 0, errors: [] })),
}));
vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: (_name: string, qty: number, unit: string) => ({
        packageCount: qty,
        packageLabel: unit,
        matched: false,
    }),
}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: mocks.getCachedActiveVoyage,
    getActiveVoyage: mocks.getActiveVoyage,
}));
vi.mock('../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
}));
vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => ({
        loaded: true,
        isSkipper: true,
        canEditStores: true,
        canViewGalley: true,
        permissions: {
            can_view_passage_meals: true,
        },
    }),
}));
vi.mock('../utils/equipmentPdfExport', () => ({
    exportEquipmentPdf: vi.fn(),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

// ── Vessel tab dependencies ──────────────────────────────────────────────
// The tab reads the fleet through a tolerant adapter, so a plain object stands
// in for the store; the pre-reads are pinned so each test controls the counts.
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: Object.assign(
        (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.fleetStore),
        { getState: () => mocks.fleetStore },
    ),
}));
vi.mock('../services/supabase', () => {
    const chain = () => {
        const query: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'neq', 'in', 'is', 'match', 'order', 'limit', 'maybeSingle', 'single']) {
            query[method] = () => query;
        }
        query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data: null, error: mocks.crewQuery.error, count: mocks.crewQuery.count }).then(
                resolve,
                reject,
            );
        return query;
    };
    return {
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key',
        isSupabaseConfigured: () => true,
        supabase: {
            from: vi.fn(chain),
            rpc: vi.fn(async () => ({ data: null, error: null })),
            auth: {
                getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
                getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
                onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
            },
        },
    };
});
vi.mock('../services/PiCacheService', () => ({
    piCache: { getStatus: mocks.piStatus, ping: mocks.piPing },
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: mocks.getPairing,
}));
vi.mock('../services/VesselIdentityService', () => ({
    saveIdentity: vi.fn(),
}));
vi.mock('../hooks/useKeyboardOffset', () => ({
    useKeyboardOffset: () => 0,
}));
vi.mock('../components/settings/YachtDatabaseSearch', () => ({
    YachtDatabaseSearch: () => null,
}));
vi.mock('../components/crew/JoinVessel', async () => {
    const React = await import('react');
    return {
        JoinVessel: ({ onClose }: { onClose: () => void }) =>
            React.createElement(
                'div',
                { role: 'dialog', 'aria-label': 'Join a Vessel' },
                React.createElement('button', { type: 'button', onClick: onClose }, 'Close vessel join form'),
            ),
    };
});

import { EquipmentList } from '../components/vessel/EquipmentList';
import { GroceryListPage } from '../components/vessel/GroceryListPage';
import { VesselTab } from '../components/settings/VesselTab';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { UserSettings } from '../types';

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
        expect(within(dialog).getByRole('textbox', { name: 'Retailer (optional)' })).toBeEnabled();
        expect(within(dialog).getByRole('button', { name: 'Coles' })).toHaveAttribute('aria-pressed', 'false');

        fireEvent.keyDown(price, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
        expect(mocks.markPurchased).not.toHaveBeenCalled();
        expect(opener).toHaveFocus();
    });

    it('labels the add-item form and restores its opener after Escape', async () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        await screen.findByText('Tomatoes');
        const opener = screen.getByRole('button', { name: 'Add item to shopping list' });
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

    it('keeps the purchase dialog usable and reports a failed mutation', async () => {
        mocks.markPurchased.mockRejectedValueOnce(new Error('disk unavailable'));
        render(<GroceryListPage onBack={vi.fn()} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Mark Tomatoes as purchased' }));
        const dialog = screen.getByRole('dialog', { name: /Mark as Purchased/ });
        const confirm = within(dialog).getByRole('button', { name: 'Confirm purchase of Tomatoes' });
        fireEvent.click(confirm);

        expect(await within(dialog).findByRole('alert')).toHaveTextContent(
            'Tomatoes could not be marked as purchased. Please try again.',
        );
        await waitFor(() => expect(confirm).toBeEnabled());
        expect(dialog).toBeInTheDocument();
        expect(mocks.markPurchased).toHaveBeenCalledOnce();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel marking Tomatoes as purchased' }));
        expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
    });

    it('moves focus to a stable action when a purchased item leaves the active filter', async () => {
        mocks.markPurchased.mockImplementationOnce(async () => {
            mocks.getShoppingList.mockReturnValue({
                total: 1,
                purchased: 1,
                remaining: 0,
                totalCost: 0,
                currency: 'AUD',
                zones: [
                    {
                        zone: 'Produce',
                        items: [
                            {
                                ...groceryItem,
                                purchased: true,
                                purchased_at: '2026-07-23T08:00:00.000Z',
                            },
                        ],
                    },
                ],
            });
        });
        render(<GroceryListPage onBack={vi.fn()} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Mark Tomatoes as purchased' }));
        fireEvent.click(
            within(screen.getByRole('dialog', { name: /Mark as Purchased/ })).getByRole('button', {
                name: 'Confirm purchase of Tomatoes',
            }),
        );

        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Add item to shopping list' })).toHaveFocus();
        });
    });

    it('preserves the manual-item form and reports a failed add', async () => {
        mocks.addManualItem.mockRejectedValueOnce(new Error('disk unavailable'));
        render(<GroceryListPage onBack={vi.fn()} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Add item to shopping list' }));
        const dialog = screen.getByRole('dialog', { name: /Add to Shopping List/ });
        const name = within(dialog).getByRole('textbox', { name: 'Item Name' });
        fireEvent.change(name, { target: { value: 'Dish soap' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Add item to grocery list' }));

        expect(await within(dialog).findByRole('alert')).toHaveTextContent(
            'Dish soap could not be added. Please try again.',
        );
        await waitFor(() => expect(name).toBeEnabled());
        expect(name).toHaveValue('Dish soap');
        expect(mocks.addManualItem).toHaveBeenCalledWith({
            name: 'Dish soap',
            qty: 1,
            unit: 'each',
            zone: 'General',
            voyageId: null,
            ownerUserId: null,
        });
    });
});

/**
 * The 2026-09-08 vessel release decision, as the Vessel tab shows it: Release
 * beside Archive (enabled on a single-boat fleet), the centred release dialog
 * with reason radios and the typed-name gate for a sale, the result dialog,
 * released rows with Undo, and the MMSI claim banner with its two escapes.
 */
describe('vessel release dialogs', () => {
    const profile = {
        name: 'Serene Summer',
        type: 'sail' as const,
        length: 40,
        beam: 13,
        draft: 6,
        displacement: 20000,
        maxWaveHeight: 6,
        cruisingSpeed: 6,
        fuelCapacity: 0,
        waterCapacity: 0,
        mmsi: '503101240',
    };
    const settings = {
        vessel: profile,
        vesselUnits: { length: 'ft', beam: 'ft', draft: 'ft', displacement: 'lbs', volume: 'gal' },
        comfortParams: {},
    } as unknown as UserSettings;

    const fleetRow = (overrides: Record<string, unknown> = {}) => ({
        id: 'boat-1',
        owner_id: 'user-1',
        profile,
        revision: 1,
        updated_at: '2026-09-08T00:00:00.000Z',
        archived_at: null,
        is_active: true,
        mmsiClaimed: true,
        releasedAt: null,
        releaseReason: null,
        ...overrides,
    });

    const primeStore = (overrides: Record<string, unknown> = {}) => {
        for (const key of Object.keys(mocks.fleetStore)) delete mocks.fleetStore[key];
        Object.assign(mocks.fleetStore, {
            settings,
            vesselFleet: [fleetRow()],
            activeVesselId: 'boat-1',
            vesselFleetStatus: 'saved',
            releasedVessels: [],
            vesselClaimConflict: null,
            selectActiveVessel: vi.fn(),
            createVesselProfile: vi.fn(),
            archiveVesselProfile: vi.fn(),
            patchActiveVesselProfile: mocks.patchActiveVesselProfile,
            syncVesselFleet: vi.fn(),
            releaseVesselProfile: mocks.releaseVesselProfile,
            undoVesselRelease: mocks.undoVesselRelease,
            dismissVesselClaimConflict: mocks.dismissVesselClaimConflict,
            releaseBlockedReason: mocks.releaseBlockedReason,
            ...overrides,
        });
    };

    const renderTab = () => render(<VesselTab settings={settings} onSave={vi.fn()} />);

    const openRelease = () => {
        const opener = screen.getByRole('button', { name: 'Release Serene Summer' });
        opener.focus();
        fireEvent.click(opener);
        return opener;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // The tab advertises the cloud fleet only for a signed-in account.
        setAuthIdentityScope('user-1');
        primeStore();
        mocks.releaseBlockedReason.mockReturnValue(null);
        mocks.patchActiveVesselProfile.mockResolvedValue(undefined);
        mocks.crewQuery.count = 0;
        mocks.crewQuery.error = null;
        mocks.getCachedActiveVoyage.mockReturnValue(null);
        mocks.getActiveVoyage.mockResolvedValue(null);
        mocks.piStatus.mockReturnValue({ reachable: false, lastCheck: Date.now(), latencyMs: 0 });
        mocks.piPing.mockResolvedValue({ reachable: false, lastCheck: Date.now(), latencyMs: 0 });
        mocks.getPairing.mockReturnValue(null);
    });

    afterEach(() => {
        setAuthIdentityScope(null);
        mocks.fleetStore.settings = {};
    });

    it('offers Release on a single-boat fleet while Archive keeps its gate', () => {
        renderTab();
        expect(screen.getByRole('button', { name: 'Release Serene Summer' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Archive Serene Summer' })).toBeDisabled();
    });

    it("disables Release with the store's shore-side reason and shows it as helper text", () => {
        const gate = "You're recording a passage on her. Finish or pause it before releasing.";
        mocks.releaseBlockedReason.mockReturnValue(gate);
        renderTab();
        expect(screen.getByRole('button', { name: 'Release Serene Summer' })).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent(gate);
    });

    it('opens a centred, labelled, focus-trapped dialog with Keep her / Release and restores the opener', () => {
        renderTab();
        const opener = openRelease();

        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });
        // OverlayPortal into document.body, centred both ways — never a bottom sheet.
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog.className).toContain('fixed inset-0');
        expect(dialog.className).toContain('items-center');
        expect(dialog.className).toContain('justify-center');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'release-vessel-title');
        const panel = within(dialog).getByTestId('release-vessel-panel');
        expect(panel.className).toContain('max-h-[80dvh]');
        expect(panel.className).toContain('overflow-y-auto');

        const keep = within(dialog).getByRole('button', { name: 'Keep her' });
        expect(keep).toHaveFocus();
        expect(within(dialog).getByRole('button', { name: 'Release' })).toBeDisabled();

        // Tab from the last enabled control wraps to the first: the trap is live.
        fireEvent.keyDown(keep, { key: 'Tab' });
        expect(within(dialog).getByRole('radio', { name: "She's been sold" })).toHaveFocus();

        fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Release Serene Summer?' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(mocks.releaseVesselProfile).not.toHaveBeenCalled();
    });

    it('gates Release behind the typed name for a sale, but not for a finished delivery', () => {
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });
        const release = within(dialog).getByRole('button', { name: 'Release' });
        expect(within(dialog).getByRole('radio', { name: "She's been sold" })).toBeChecked();
        expect(release).toBeDisabled();

        const typed = within(dialog).getByRole('textbox', { name: 'Type her name to confirm' });
        fireEvent.change(typed, { target: { value: 'serene  summer ' } });
        expect(release).toBeEnabled();
        fireEvent.change(typed, { target: { value: 'Serene' } });
        expect(release).toBeDisabled();

        fireEvent.click(within(dialog).getByRole('radio', { name: 'Delivery finished' }));
        expect(release).toBeEnabled();
        expect(within(dialog).queryByRole('textbox', { name: 'Type her name to confirm' })).not.toBeInTheDocument();

        fireEvent.click(within(dialog).getByRole('radio', { name: 'Something else' }));
        expect(release).toBeEnabled();
    });

    it('shows the pre-read count and both advisories without holding the release', async () => {
        mocks.crewQuery.count = 3;
        mocks.getCachedActiveVoyage.mockReturnValue({ id: 'voyage-1', status: 'active', boat_id: 'boat-1' });
        mocks.getPairing.mockReturnValue({ deviceId: 'phone-1', publicKeySpki: 'spki-1' });
        mocks.piStatus.mockReturnValue({ reachable: true, lastCheck: Date.now(), latencyMs: 3, diaryRelayQueued: 4 });
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });

        await within(dialog).findByText(/Your crew \(3\) lose access/);
        expect(within(dialog).getByText('A passage is still active on this boat.')).toBeInTheDocument();
        expect(
            within(dialog).getByText(/4 diary entries on the Pi have not reached the cloud yet/),
        ).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('radio', { name: 'Something else' }));
        expect(within(dialog).getByRole('button', { name: 'Release' })).toBeEnabled();
    });

    it('never starts a Pi discovery sweep from the dialog: no pairing means no ping and no Pi line', async () => {
        // A stale reading would normally be refreshed, but ping() with no host
        // runs discover() — a LAN sweep that stores a host and raises the
        // pairing offer. Unpaired, the dialog must not touch the Pi at all.
        mocks.getPairing.mockReturnValue(null);
        mocks.piStatus.mockReturnValue({ reachable: true, lastCheck: 0, latencyMs: 3, diaryRelayQueued: 4 });
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });

        await waitFor(() => expect(mocks.getActiveVoyage).toHaveBeenCalled());
        await waitFor(() => expect(mocks.getPairing).toHaveBeenCalled());
        expect(mocks.piPing).not.toHaveBeenCalled();
        expect(within(dialog).queryByText(/on the Pi/)).not.toBeInTheDocument();
    });

    it('refreshes a stale reading from the paired Pi and quotes the fresh queued count', async () => {
        mocks.getPairing.mockReturnValue({ deviceId: 'phone-1', publicKeySpki: 'spki-1' });
        mocks.piStatus.mockReturnValue({ reachable: true, lastCheck: 0, latencyMs: 3, diaryRelayQueued: 9 });
        mocks.piPing.mockResolvedValue({ reachable: true, lastCheck: Date.now(), latencyMs: 3, diaryRelayQueued: 1 });
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });

        expect(
            await within(dialog).findByText(/1 diary entry on the Pi has not reached the cloud yet/),
        ).toBeInTheDocument();
        expect(mocks.piPing).toHaveBeenCalledOnce();
        expect(within(dialog).queryByText(/9 diary entries/)).not.toBeInTheDocument();
    });

    it('falls back to the generic sentence when the pre-reads fail', async () => {
        mocks.crewQuery.error = new Error('permission denied');
        mocks.getActiveVoyage.mockRejectedValue(new Error('offline'));
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });

        await waitFor(() => expect(mocks.getActiveVoyage).toHaveBeenCalled());
        expect(within(dialog).getByText(/^Releasing hands her on\. Your crew lose access,/)).toBeInTheDocument();
        expect(within(dialog).queryByText(/passage is still active/)).not.toBeInTheDocument();
        expect(within(dialog).queryByText(/on the Pi/)).not.toBeInTheDocument();
    });

    it('releases with the chosen reason and reports the counts plus the unmatched-Pi line', async () => {
        mocks.releaseVesselProfile.mockResolvedValue({
            released: true,
            remainingActiveBoats: 0,
            nextActiveBoatId: null,
            crewRemoved: 2,
            invitesRevoked: 1,
            relaysRemoved: 1,
            relaysUnmatched: 1,
            telemetryCleared: 1,
            publicPagesDisabled: 1,
        });
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });
        fireEvent.click(within(dialog).getByRole('radio', { name: 'Delivery finished' }));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Release' }));
        expect(mocks.releaseVesselProfile).toHaveBeenCalledWith('boat-1', 'delivery_complete');

        const result = await screen.findByRole('dialog', {
            name: 'Serene Summer released — 2 crew removed, 1 Pi unpaired, public page off.',
        });
        expect(result.className).toContain('items-center');
        expect(result.className).toContain('justify-center');
        expect(within(result).getByRole('status')).toHaveTextContent(
            '1 Pi could not be matched to a boat and is still paired to you. If it is aboard Serene Summer, forget it in Settings > Calypso and she will pair to her new skipper when they are aboard.',
        );
        expect(within(result).getByText(/Your fleet is empty now/)).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Release Serene Summer?' })).not.toBeInTheDocument();

        const done = within(result).getByRole('button', { name: 'Done' });
        expect(done).toHaveFocus();
        fireEvent.click(done);
        expect(screen.queryByRole('dialog', { name: /released —/ })).not.toBeInTheDocument();
    });

    it("keeps the dialog open and shows the store's sentence when the release is refused", async () => {
        const offline =
            'Releasing needs a connection — it disconnects crew, the Pi and the public page in the cloud. Nothing has changed.';
        mocks.releaseVesselProfile.mockRejectedValue(new Error(offline));
        renderTab();
        openRelease();
        const dialog = screen.getByRole('dialog', { name: 'Release Serene Summer?' });
        fireEvent.click(within(dialog).getByRole('radio', { name: 'Something else' }));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Release' }));

        expect(await within(dialog).findByRole('alert')).toHaveTextContent(offline);
        expect(screen.getByRole('dialog', { name: 'Release Serene Summer?' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: /released —/ })).not.toBeInTheDocument();
    });

    it('lists released hulls with Undo release and reports claim_lost when she comes back unclaimed', async () => {
        primeStore({
            vesselFleet: [],
            activeVesselId: null,
            releasedVessels: [
                {
                    boatId: 'boat-9',
                    name: 'Serene Summer',
                    releasedAt: '2026-09-08T12:00:00.000Z',
                    releaseReason: 'sold',
                },
            ],
        });
        mocks.undoVesselRelease.mockResolvedValue({ restored: true, claimLost: true });
        renderTab();

        const list = screen.getByRole('list', { name: 'Released vessels' });
        expect(within(list).getByRole('listitem')).toHaveTextContent('You released Serene Summer on 8 Sep 2026 (sold)');
        fireEvent.click(within(list).getByRole('button', { name: 'Undo release of Serene Summer' }));
        expect(mocks.undoVesselRelease).toHaveBeenCalledWith('boat-9');

        const result = await screen.findByRole('dialog', { name: 'Serene Summer is back in your fleet.' });
        expect(
            within(result).getByText('Crew, Pi and public page are not restored — invite, pair and enable them again.'),
        ).toBeInTheDocument();
        expect(within(result).getByRole('status')).toHaveTextContent(
            'Another Thalassa boat claimed her MMSI while she was released.',
        );
    });

    it('shows the MMSI claim banner centred with both escapes, and Save without MMSI clears the number', () => {
        primeStore({
            vesselFleet: [],
            activeVesselId: null,
            vesselClaimConflict: { vesselName: 'Serene Summer', mmsi: '503101240' },
        });
        renderTab();

        const banner = screen.getByRole('dialog', { name: 'Already on Thalassa' });
        expect(banner.className).toContain('items-center');
        expect(banner.className).toContain('justify-center');
        expect(banner).toHaveAttribute('aria-modal', 'true');
        expect(banner).toHaveTextContent(
            'Serene Summer (MMSI 503101240) is already on Thalassa. Joining her crew? Ask the skipper for a crew code. Bought her? Ask them to release her in Settings > Vessel.',
        );
        const crewCode = within(banner).getByRole('button', { name: 'Enter crew code' });
        expect(crewCode).toHaveFocus();
        expect(within(banner).getByRole('button', { name: 'Save without MMSI' })).toBeEnabled();

        fireEvent.click(within(banner).getByRole('button', { name: 'Save without MMSI' }));
        expect(mocks.patchActiveVesselProfile).toHaveBeenCalledWith({
            profile: expect.objectContaining({ mmsi: '' }),
        });
        expect(mocks.dismissVesselClaimConflict).toHaveBeenCalledOnce();
    });

    it('opens the crew-code form from the banner and dismisses on Escape', () => {
        primeStore({
            vesselFleet: [],
            activeVesselId: null,
            vesselClaimConflict: { vesselName: 'Serene Summer', mmsi: '503101240' },
        });
        renderTab();
        const banner = screen.getByRole('dialog', { name: 'Already on Thalassa' });

        fireEvent.click(within(banner).getByRole('button', { name: 'Enter crew code' }));
        expect(screen.getByRole('dialog', { name: 'Join a Vessel' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close vessel join form' }));
        expect(screen.queryByRole('dialog', { name: 'Join a Vessel' })).not.toBeInTheDocument();

        fireEvent.keyDown(within(banner).getByRole('button', { name: 'Enter crew code' }), { key: 'Escape' });
        expect(mocks.dismissVesselClaimConflict).toHaveBeenCalledOnce();
    });

    it("'Not now' snoozes the banner into an inline reminder until Show options, so typing never re-opens it", () => {
        // The mocked store keeps its conflict after dismiss — exactly what the
        // real store does one keystroke later, when the patch path bootstraps
        // again and re-confirms the same MMSI_CLAIMED.
        primeStore({
            vesselFleet: [],
            activeVesselId: null,
            vesselClaimConflict: { vesselName: 'Serene Summer', mmsi: '503101240' },
        });
        renderTab();
        fireEvent.click(
            within(screen.getByRole('dialog', { name: 'Already on Thalassa' })).getByRole('button', {
                name: 'Not now',
            }),
        );
        expect(mocks.dismissVesselClaimConflict).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog', { name: 'Already on Thalassa' })).not.toBeInTheDocument();

        const reminder = screen.getByText(/Serene Summer is already on Thalassa with this MMSI/);
        expect(reminder).toHaveAttribute('role', 'status');
        fireEvent.click(within(reminder).getByRole('button', { name: 'Show options' }));
        expect(screen.getByRole('dialog', { name: 'Already on Thalassa' })).toBeInTheDocument();
    });

    it('shows the inline advisory under the MMSI field only when the cloud says another boat holds it', () => {
        primeStore({ vesselFleet: [fleetRow({ mmsiClaimed: false })] });
        const claimedElsewhere = renderTab();
        expect(screen.getByText(/Another Thalassa boat already carries this MMSI/)).toBeInTheDocument();
        claimedElsewhere.unmount();

        primeStore();
        renderTab();
        expect(screen.queryByText(/already carries this MMSI/)).not.toBeInTheDocument();
    });
});
