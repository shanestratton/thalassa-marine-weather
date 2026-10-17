/**
 * Boat Binder badges tell the truth, and reach the Vessel page (131-B12;
 * binder audit BH-1, EQ-3, BH-2, BH-4, BH-10).
 *
 * The badges count only what is really due, by the cards' own rules on the
 * skipper's local day: papers split into '1 expired · 1 expiring', and only
 * warranties ending in the next 30 days, never one that ended years ago. The
 * most urgent count shows on the Vessel page's Boat Binder row. And a binder
 * page's return mark no longer sends a later tap on the Vessel tab to the
 * Binder.
 *
 * The counting hook itself (the database wait, the phone's count first) is
 * tested in tests/useVesselReadinessCounts.test.ts. Fictional papers and gear.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';
import type { VesselReadinessCounts } from '../hooks/useVesselReadinessCounts';

const mocks = vi.hoisted(() => ({
    previousView: 'dashboard' as string | undefined,
    counts: {
        overdueCount: 0,
        expiredDocsCount: 0,
        expiringDocsCount: 0,
        expiringEquipCount: 0,
    } as VesselReadinessCounts,
}));
const vessel = vi.hoisted(() => ({ name: 'Serene Summer', type: 'sail' }));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel }, updateSettings: vi.fn() }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: null, refreshData: vi.fn() }),
}));
vi.mock('../stores/uiStore', () => ({
    useUIStore: (select: (state: { isOffline: boolean; previousView: string | undefined }) => unknown) =>
        select({ isOffline: true, previousView: mocks.previousView }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (state: { user: null }) => unknown) => select({ user: null }),
}));
vi.mock('../stores/settingsStore', () => ({ refreshSkipperClaim: vi.fn(async () => undefined) }));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        watchPosition: () => () => undefined,
        getCurrentPositionIfGranted: async () => null,
    },
}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: () => null,
    getActiveVoyage: async () => null,
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { subscribe: () => () => undefined },
}));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: { onStateChange: () => () => undefined },
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: async () => [] }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../hooks/useVesselReadinessCounts', () => ({ useVesselReadinessCounts: () => mocks.counts }));
vi.mock('../hooks/useCloudTelemetry', () => ({ useCloudTelemetry: () => ({ latest: null, piPrimary: false }) }));
vi.mock('../hooks/useTripRoute', () => ({ useTripRoute: () => null }));
vi.mock('../components/nmea/useNmeaStore', () => ({
    useNmeaConnectionStatus: () => ({ status: 'disconnected' }),
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { getFeedStatus: () => 'unavailable' } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/savedTraceStore', () => ({ loadSavedTraces: () => [] }));
vi.mock('../services/savedRoutesSync', () => ({ syncSavedRoutes: async () => [] }));
vi.mock('../stores/PassageStore', () => ({
    PassageStore: {
        getState: () => ({ hasRoute: false, arriveLat: null, arriveLon: null, totalDistanceNM: 0 }),
        subscribe: () => () => undefined,
    },
}));
vi.mock('../components/vesselHub/usePendingCrewInvites', () => ({ usePendingCrewInvites: () => 0 }));
vi.mock('../components/vesselHub/useGuardianTileState', () => ({
    useGuardianTileState: () => ({ guardianArmed: false, guardianNearby: 0 }),
}));
vi.mock('../components/vesselHub/useTripLogActive', () => ({ useTripLogActive: () => false }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));

import { VesselHub } from '../components/VesselHub';
import { binderBadge, documentsDueStatus } from '../components/vesselHub/binderBadge';
import { markBinderReturn, openedFromBinder, takeBinderReturn } from '../components/vesselHub/binderReturn';
import {
    documentExpiryStatus,
    documentsDue,
    warrantiesEndingSoon,
    warrantyEndingSoon,
} from '../services/vessel/binderDue';
import { getExpiryStatus } from '../components/vessel/documents/SwipeableDocCard';
import { SwipeableInventoryCard } from '../components/vessel/inventory/SwipeableInventoryCard';
import { authScopedStorageKey } from '../services/authIdentityScope';

const RETURN_KEY = () => authScopedStorageKey('thalassa_boat_binder_return');
const NOTHING_DUE: VesselReadinessCounts = {
    overdueCount: 0,
    expiredDocsCount: 0,
    expiringDocsCount: 0,
    expiringEquipCount: 0,
};

function renderHub() {
    const onNavigate = vi.fn();
    render(<VesselHub onNavigate={onNavigate} settings={{}} onSave={vi.fn()} />);
    return onNavigate;
}

const row = (name: string) => screen.getByRole('button', { name });
const badgeOf = (name: string) => row(name).querySelector('.hub-row-badge');

beforeEach(() => {
    mocks.previousView = 'dashboard';
    mocks.counts = { ...NOTHING_DUE };
    sessionStorage.clear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    sessionStorage.clear();
});

describe("what is due, by the cards' own rules on the local day", () => {
    // Noon on 15 October 2026, on this phone's clock.
    const NOW = new Date(2026, 9, 15, 12, 0);

    it('reads every paper exactly as its card does', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        for (const expiry of [
            '2019-03-01',
            '2026-10-14',
            '2026-10-15',
            '2026-10-15T00:00:00+00:00',
            '2026-11-13',
            '2026-11-14',
            '2027-06-01',
            null,
            'not a date',
        ]) {
            expect(getExpiryStatus(expiry), String(expiry)).toBe(documentExpiryStatus(expiry));
        }
        expect(documentExpiryStatus('2026-10-15')).toBe('warning'); // valid all its last day
        expect(documentExpiryStatus('2026-10-14')).toBe('expired');
        expect(documentExpiryStatus('2026-11-13')).toBe('warning'); // 29 days
        expect(documentExpiryStatus('2026-11-14')).toBe('valid'); // 30 days
    });

    it('splits papers into expired and expiring, an old lapse still expired', () => {
        const papers = [
            { expiry_date: '2019-03-01' }, // insurance that lapsed years ago
            { expiry_date: '2026-10-01' },
            { expiry_date: '2026-10-20' },
            { expiry_date: '2027-06-01' },
            { expiry_date: null },
        ];
        expect(documentsDue(papers, NOW)).toEqual({ expired: 2, expiring: 1 });
    });

    it('counts a warranty only while it is ending: in force today, over within 30 days', () => {
        expect(warrantyEndingSoon('2019-03-01', NOW)).toBe(false); // ended years ago
        expect(warrantyEndingSoon('2026-10-14', NOW)).toBe(false); // ended yesterday
        expect(warrantyEndingSoon('2026-10-15', NOW)).toBe(true); // its last day
        expect(warrantyEndingSoon('2026-10-15T00:00:00+00:00', NOW)).toBe(true); // the synced form
        expect(warrantyEndingSoon('2026-11-13', NOW)).toBe(true); // 29 days
        expect(warrantyEndingSoon('2026-11-14', NOW)).toBe(false); // 30 days
        expect(warrantyEndingSoon(null, NOW)).toBe(false);
        expect(
            warrantiesEndingSoon(
                [
                    { warranty_expiry: '2019-03-01' },
                    { warranty_expiry: '2026-10-20' },
                    { warranty_expiry: '2028-01-01' },
                    { warranty_expiry: null },
                ],
                NOW,
            ),
        ).toBe(1);
    });
});

describe('the binder badges in words', () => {
    it('puts the most urgent count first: overdue, then expired papers, then expiring, then warranties', () => {
        const all = { overdueCount: 2, expiredDocsCount: 1, expiringDocsCount: 3, expiringEquipCount: 4 };
        expect(binderBadge(all)).toEqual({ count: 2, status: '2 maintenance tasks overdue', urgent: true });
        expect(binderBadge({ ...all, overdueCount: 0 })).toEqual({
            count: 1,
            status: '1 document expired',
            urgent: true,
        });
        expect(binderBadge({ ...all, overdueCount: 0, expiredDocsCount: 0 })).toEqual({
            count: 3,
            status: '3 documents expiring',
            urgent: false,
        });
        expect(binderBadge({ ...NOTHING_DUE, expiringEquipCount: 1 })).toEqual({
            count: 1,
            status: '1 warranty ending soon',
            urgent: false,
        });
        expect(binderBadge({ ...NOTHING_DUE, overdueCount: 1 })?.status).toBe('1 maintenance task overdue');
        expect(binderBadge({ ...NOTHING_DUE, expiringEquipCount: 2 })?.status).toBe('2 warranties ending soon');
        expect(binderBadge(NOTHING_DUE)).toBeNull();
    });

    it("words the Documents row as the Documents header does: '1 expired · 1 expiring'", () => {
        expect(documentsDueStatus(1, 1)).toBe('1 expired · 1 expiring');
        expect(documentsDueStatus(2, 0)).toBe('2 expired');
        expect(documentsDueStatus(0, 3)).toBe('3 expiring');
        expect(documentsDueStatus(0, 0)).toBeNull();
    });
});

describe("the Vessel page's Boat Binder row", () => {
    it('carries the most urgent count, in red when something is past due', () => {
        mocks.counts = { overdueCount: 2, expiredDocsCount: 1, expiringDocsCount: 1, expiringEquipCount: 1 };
        renderHub();
        expect(row('Boat Binder')).toHaveAccessibleDescription('2 maintenance tasks overdue');
        expect(badgeOf('Boat Binder')).toHaveTextContent('2');
        expect(badgeOf('Boat Binder')?.className).toContain('bg-red-500/30');
    });

    it('says an expired paper when nothing is overdue', () => {
        mocks.counts = { ...NOTHING_DUE, expiredDocsCount: 1, expiringEquipCount: 3 };
        renderHub();
        expect(row('Boat Binder')).toHaveAccessibleDescription('1 document expired');
        expect(badgeOf('Boat Binder')).toHaveTextContent('1');
        expect(badgeOf('Boat Binder')?.className).toContain('bg-red-500/30');
    });

    it('is amber for what is only coming up', () => {
        mocks.counts = { ...NOTHING_DUE, expiringEquipCount: 1 };
        renderHub();
        expect(row('Boat Binder')).toHaveAccessibleDescription('1 warranty ending soon');
        expect(badgeOf('Boat Binder')?.className).toContain('bg-amber-500/30');
    });

    it('says what it holds, with no badge, when nothing is due', () => {
        renderHub();
        expect(row('Boat Binder')).toHaveAccessibleDescription('Inventory & reference');
        expect(badgeOf('Boat Binder')).toBeNull();
    });
});

describe('inside the Boat Binder', () => {
    it("splits the Documents row into '1 expired · 1 expiring', red once one has expired", () => {
        mocks.counts = { ...NOTHING_DUE, expiredDocsCount: 1, expiringDocsCount: 1 };
        renderHub();
        fireEvent.click(row('Boat Binder'));
        expect(row('Documents')).toHaveAccessibleDescription('1 expired · 1 expiring');
        expect(badgeOf('Documents')).toHaveTextContent('2');
        expect(badgeOf('Documents')?.className).toContain('bg-red-500/30');
    });

    it('keeps a paper only expiring amber, not red', () => {
        mocks.counts = { ...NOTHING_DUE, expiringDocsCount: 1 };
        renderHub();
        fireEvent.click(row('Boat Binder'));
        expect(row('Documents')).toHaveAccessibleDescription('1 expiring');
        expect(badgeOf('Documents')?.className).toContain('bg-amber-500/30');
    });

    it('says a warranty ending soon on the Equipment row, and nothing when none is', () => {
        mocks.counts = { ...NOTHING_DUE, expiringEquipCount: 1 };
        renderHub();
        fireEvent.click(row('Boat Binder'));
        expect(row('Equipment')).toHaveAccessibleDescription('1 warranty ending soon');
        cleanup();
        mocks.counts = { ...NOTHING_DUE };
        renderHub();
        fireEvent.click(row('Boat Binder'));
        expect(row('Equipment')).toHaveAccessibleDescription('Register & warranties');
        expect(row('Documents')).toHaveAccessibleDescription('Legal papers');
        expect(badgeOf('Documents')).toBeNull();
    });
});

describe('back to the Binder, and only straight back (BH-10)', () => {
    const binderOnScreen = () => screen.queryByRole('heading', { level: 1, name: 'Boat Binder' });

    it('marks the page the binder opens', () => {
        const onNavigate = renderHub();
        fireEvent.click(row('Boat Binder'));
        fireEvent.click(row("Ship's Stores"));
        expect(onNavigate).toHaveBeenLastCalledWith('inventory');
        expect(sessionStorage.getItem(RETURN_KEY())).toBe('inventory');
    });

    it('reopens the binder on the way straight back from that page', () => {
        markBinderReturn('inventory');
        mocks.previousView = 'inventory';
        renderHub();
        expect(binderOnScreen()).toBeInTheDocument();
        expect(sessionStorage.getItem(RETURN_KEY())).toBeNull();
    });

    it('opens the Vessel page, not the binder, when Stores was left by the tab bar', () => {
        // Binder → Ship's Stores → the Glass tab. Later, the Vessel tab.
        markBinderReturn('inventory');
        mocks.previousView = 'dashboard';
        renderHub();
        expect(binderOnScreen()).toBeNull();
        expect(row('Boat Binder')).toBeInTheDocument();
        // The mark is spent: it can't send a later visit to the binder either.
        expect(sessionStorage.getItem(RETURN_KEY())).toBeNull();
        cleanup();
        mocks.previousView = 'inventory';
        renderHub();
        expect(binderOnScreen()).toBeNull();
    });

    it("never reopens the binder for a page it didn't open", () => {
        markBinderReturn('documents');
        mocks.previousView = 'nmea';
        renderHub();
        expect(binderOnScreen()).toBeNull();
    });

    it('takes the mark once, and never without one', () => {
        expect(takeBinderReturn('inventory')).toBe(false);
        expect(takeBinderReturn(undefined)).toBe(false);
        markBinderReturn('maintenance');
        expect(takeBinderReturn('maintenance')).toBe(true);
        expect(takeBinderReturn('maintenance')).toBe(false);
    });

    it('Import GPX names the Binder only when the binder opened it just now, and forgets a leftover mark', () => {
        markBinderReturn('gpx-import');
        expect(openedFromBinder('gpx-import', 'vessel')).toBe(true);
        // Opened from Plan's Import GPX, with the mark of an earlier binder visit.
        expect(openedFromBinder('gpx-import', 'voyage')).toBe(false);
        expect(sessionStorage.getItem(RETURN_KEY())).toBeNull();
        expect(openedFromBinder('gpx-import', 'vessel')).toBe(false);

        const gpx = readFileSync('components/vessel/GpxImportPage.tsx', 'utf8');
        expect(gpx).toContain("openedFromBinder('gpx-import', arrivedFrom)");
        expect(gpx).toContain('readParentCrumb(previousView)');
        expect(gpx).not.toContain("=== '1'");
    });
});

describe("Ship's Stores card: the one low-stock rule (131-B14's isLowStock)", () => {
    const item = (quantity: number, min_quantity: number): InventoryItem =>
        ({
            id: `s-${quantity}-${min_quantity}`,
            user_id: 'skipper-1',
            barcode: null,
            item_name: 'Spare impeller',
            description: null,
            category: 'Engine',
            quantity,
            min_quantity,
            unit: 'whole',
            location_zone: null,
            location_specific: null,
            expiry_date: null,
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
        }) as InventoryItem;

    it.each([
        [2, 2, true], // at the minimum
        [1, 2, true], // under it
        [3, 2, false],
        [0, 0, false], // empty, but no minimum is set
    ])('%s held against a minimum of %s reads Low: %s', (quantity, minimum, low) => {
        render(
            <SwipeableInventoryCard item={item(quantity, minimum)} units="metric" isExpanded={false} onTap={vi.fn()} />,
        );
        expect(screen.queryByText('Low') !== null).toBe(low);
    });

    it('asks isLowStock rather than a rule of its own', () => {
        const card = readFileSync('components/vessel/inventory/SwipeableInventoryCard.tsx', 'utf8');
        expect(card).toContain("import { isLowStock } from '../../../services/vessel/inventoryStats';");
        expect(card).toContain('const isLow = isLowStock(item);');
        expect(card).not.toMatch(/item\.quantity\s*<=\s*item\.min_quantity/);
    });
});
