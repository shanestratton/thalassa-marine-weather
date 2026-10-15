/**
 * The Vessel page's menu is ONE box (Shane 2026-10-04: "the vessel page needs
 * to have one box around crew and float plan, boat binder, settings, nmea
 * gateway, boat network, and music. can you also order them in a better order
 * from most used to least"), and nothing on the page is folded away any more,
 * because the whole page fits one screen ("i prefer that all of the menu
 * itemed pages fit into one screen").
 *
 * Order, most used first: Crew & Float Plan (every passage, and its pending
 * invite badge is the menu's most urgent state), Boat Binder (stores,
 * maintenance, documents), NMEA Gateway (opened on most visits aboard, and its
 * live Connected / Aboard / Away state is worth a glance), Music, Settings,
 * then Boat Network, which is set up once.
 *
 * Crew & Float Plan has lifted out into a card of its own, above the box, with
 * a hue on its back (Shane 2026-10-13, 128-HUES: "ok the crew and float plan,
 * really needs its own card, can we make a nice card for it without having to
 * scroll up and down on the page, maybe a nice hue as well on the back of
 * it"). The other five stay in the one box, in their order.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const vessel = vi.hoisted(() => ({ name: 'Serene Summer', type: 'sail' }));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vessel },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: null, refreshData: vi.fn() }),
}));
vi.mock('../stores/uiStore', () => ({
    useUIStore: (select: (state: { isOffline: boolean }) => unknown) => select({ isOffline: true }),
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
vi.mock('../hooks/useVesselReadinessCounts', () => ({
    useVesselReadinessCounts: () => ({
        overdueCount: 0,
        expiredDocsCount: 0,
        expiringDocsCount: 0,
        expiringEquipCount: 0,
    }),
}));
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

function renderHub() {
    const onNavigate = vi.fn();
    render(<VesselHub onNavigate={onNavigate} settings={{}} onSave={vi.fn()} />);
    return onNavigate;
}

afterEach(() => {
    cleanup();
    localStorage.removeItem('thalassa_vessel_connections_open');
});

const ORDER = ['Crew & Float Plan', 'Boat Binder', 'NMEA Gateway', 'Music', 'Settings', 'Boat Network'];
const BOX = ORDER.slice(1);

describe('Vessel page menu box', () => {
    it('holds the other five rows in one box, most used first', () => {
        renderHub();
        const boxes = screen.getAllByTestId('vessel-hub-menu');
        expect(boxes).toHaveLength(1);
        const names = within(boxes[0])
            .getAllByRole('button')
            .map((button) => button.getAttribute('aria-label'));
        expect(names).toEqual(BOX);
    });

    it('gives Crew & Float Plan its own card above the box, with the crew hue on its back', () => {
        renderHub();
        const crew = screen.getByTestId('vessel-hub-crew');
        const box = screen.getByTestId('vessel-hub-menu');
        expect(
            within(crew)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual(['Crew & Float Plan']);
        // The one card hue (styles/card-hue.css) in the crew token, and the
        // menu rows' own typography: it is a one-row menu card.
        for (const name of ['card-hue', 'card-hue-crew', 'vessel-hub-menu', 'vessel-hub-crew']) {
            expect(crew.classList).toContain(name);
        }
        expect(box.classList).not.toContain('card-hue');
        // Above the box, the two side by side in one menu group.
        expect(crew.nextElementSibling).toBe(box);
        expect(crew.parentElement).toBe(screen.getByTestId('vessel-hub-menus'));
        expect(crew.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('names the two cards as one menu for VoiceOver', () => {
        renderHub();
        const menus = screen.getByTestId('vessel-hub-menus');
        const heading = within(menus).getByRole('heading', { level: 2, name: 'Vessel menu' });
        // The heading comes before both cards, so the rotor lands on it first.
        expect(
            heading.compareDocumentPosition(screen.getByTestId('vessel-hub-crew')) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it('folds nothing away: every row is reachable without expanding a group', () => {
        // A skipper who left it open on an old build must not find it closed.
        localStorage.setItem('thalassa_vessel_connections_open', '0');
        renderHub();
        expect(screen.queryByRole('button', { name: 'Connections & music' })).toBeNull();
        expect(screen.queryByTestId('vessel-hub-connections-contents')).toBeNull();
        for (const button of screen.getAllByRole('button')) {
            expect(button).not.toHaveAttribute('aria-expanded');
        }
        for (const name of ORDER) expect(screen.getByRole('button', { name })).toBeVisible();
    });

    it('keeps each row going where it went, with its subtitle', () => {
        const onNavigate = renderHub();
        const routes: [string, string][] = [
            ['Crew & Float Plan', 'crew'],
            ['Music', 'music'],
            ['Settings', 'settings'],
            ['NMEA Gateway', 'nmea'],
            ['Boat Network', 'avnav'],
        ];
        for (const [name, page] of routes) {
            fireEvent.click(screen.getByRole('button', { name }));
            expect(onNavigate).toHaveBeenLastCalledWith(page);
        }
        expect(screen.getByRole('button', { name: 'Crew & Float Plan' })).toHaveAccessibleDescription(
            'Readiness checks & cast off',
        );
        expect(screen.getByRole('button', { name: 'Music' })).toHaveAccessibleDescription('Apple Music & speakers');
        expect(screen.getByRole('button', { name: 'Boat Network' })).toHaveAccessibleDescription(
            'Boat computer, charts & devices',
        );
        // The Binder is a screen of its own, opened in place.
        fireEvent.click(screen.getByRole('button', { name: 'Boat Binder' }));
        expect(screen.getByRole('heading', { level: 1, name: 'Boat Binder' })).toBeInTheDocument();
    });

    it('separates the rows with dividers, not gaps', () => {
        renderHub();
        const box = screen.getByTestId('vessel-hub-menu');
        const rows = within(box).getAllByRole('button');
        expect(rows[0].getAttribute('aria-label')).toBe('Boat Binder');
        // The box opens on its first row: no divider left over from the crew row.
        expect(rows[0].previousElementSibling?.tagName ?? 'none').not.toBe('DIV');
        // Every row but the first follows a divider inside the same box.
        for (const row of rows.slice(1)) {
            expect(row.previousElementSibling?.tagName).toBe('DIV');
            expect(row.previousElementSibling?.getAttribute('role')).toBeNull();
            expect(row.parentElement).toBe(rows[0].parentElement);
        }
    });
});
