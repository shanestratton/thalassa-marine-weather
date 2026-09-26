/**
 * SystemStatusButton — smoke tests (631 LOC component)
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import type { NmeaConnectionStatus } from '../services/NmeaListenerService';
import type { NmeaStoreState } from '../services/NmeaStore';
import type { GpsPosition } from '../services/GpsService';
import type { GpsReceiverStatus } from '../services/GpsReceiverStatusService';
import type { ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';
import type { ShorePushReadiness } from '../services/AnchorWatchSyncService';
import { publishPassageHudInfo, setPassageSquallInfoVisible } from '../stores/passageHudInfoStore';

const instruments = vi.hoisted(() => ({
    store: {} as NmeaStoreState,
    direct: 'disconnected' as NmeaConnectionStatus,
    lastError: null as string | null,
    viaRemoteAccess: false,
    piReachable: false,
    storeListeners: new Set<(state: NmeaStoreState) => void>(),
    socketListeners: new Set<() => void>(),
    retain: vi.fn(),
    release: vi.fn(),
    phoneCallback: null as null | ((position: GpsPosition) => void),
    receiver: {} as GpsReceiverStatus,
}));
const shore = vi.hoisted(() => ({
    watch: {} as ShoreAlarmSnapshot,
    push: {} as ShorePushReadiness,
    listeners: new Set<() => void>(),
    pushListeners: new Set<(value: ShorePushReadiness) => void>(),
    refreshPushReadiness: vi.fn(),
    retryReminderAcknowledgement: vi.fn(),
}));
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: () => shore.watch,
        subscribe: (listener: () => void) => {
            shore.listeners.add(listener);
            return () => shore.listeners.delete(listener);
        },
        retryReminderAcknowledgement: shore.retryReminderAcknowledgement,
    },
}));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        getPushReadiness: () => shore.push,
        refreshPushReadiness: shore.refreshPushReadiness,
        onPushReadinessChange: (listener: (value: ShorePushReadiness) => void) => {
            shore.pushListeners.add(listener);
            return () => shore.pushListeners.delete(listener);
        },
    },
}));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => instruments.store,
        subscribe: (cb: (state: NmeaStoreState) => void) => {
            instruments.storeListeners.add(cb);
            return () => instruments.storeListeners.delete(cb);
        },
    },
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => instruments.direct,
        getLastError: () => instruments.lastError,
        getConnectionInfo: () => ({ deviceLabel: 'Yacht Devices YDWG-02' }),
        onStatusChange: (cb: () => void) => {
            instruments.socketListeners.add(cb);
            return () => instruments.socketListeners.delete(cb);
        },
    },
}));
vi.mock('../services/CloudTelemetryService', () => ({
    CloudTelemetryService: { retain: instruments.retain, release: instruments.release },
    CLOUD_TELEMETRY_LIVE_MAX_AGE_MS: 60_000,
}));
vi.mock('../services/PiTelemetryService', () => ({ PI_TELEMETRY_LIVE_MAX_AGE_MS: 20_000 }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        get viaRemoteAccess() {
            return instruments.viaRemoteAccess;
        },
        getStatus: () => ({ reachable: instruments.piReachable }),
        onStatusChange: () => () => {},
        ping: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../services/n2kStatus', () => ({
    n2kStatus: {
        getStatus: () => ({ reachable: false, health: null, summary: null, pathsSeen: 0, pathsTotal: 0 }),
        onStatusChange: () => () => {},
        start: vi.fn(),
        refresh: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        watchPosition: (callback: (position: GpsPosition) => void) => {
            instruments.phoneCallback = callback;
            return () => {
                instruments.phoneCallback = null;
            };
        },
    },
}));
vi.mock('../services/GpsReceiverStatusService', () => ({
    GpsReceiverStatusService: {
        getStatus: () => instruments.receiver,
        refresh: async () => instruments.receiver,
    },
}));
vi.mock('../components/NmeaRateSparkline', () => ({
    NmeaRateSparkline: ({ label }: { label: string }) => <div>{label}</div>,
}));

const getTrackingStatus = vi.hoisted(() => vi.fn());
const followRouteState = vi.hoisted(() => ({
    isFollowing: false,
    voyagePlan: null as { origin?: string; destination?: string } | null,
    routeChanged: false,
    isRefreshing: false,
    stopFollowing: vi.fn(),
    acceptRouteChange: vi.fn(),
    dismissRouteChange: vi.fn(),
    refreshRoute: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        isTracking: vi.fn().mockReturnValue(false),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getActiveVoyage: vi.fn().mockReturnValue(null),
        getTrackingStatus,
        getGpsStatus: vi.fn().mockReturnValue({ hasExternalGps: false, source: 'none' }),
        getGpsNavData: vi.fn().mockReturnValue({ sogKts: null }),
        onTrackingChange: vi.fn().mockReturnValue(vi.fn()),
    },
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        isWatching: vi.fn().mockReturnValue(false),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
        getSnapshot: vi.fn().mockReturnValue(null),
    },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: vi.fn().mockReturnValue({ latitude: 0, longitude: 0 }),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
}));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: () => followRouteState,
}));

import { SystemStatusButton } from '../components/SystemStatusButton';

describe('SystemStatusButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shore.watch = {
            sessionCode: null,
            position: null,
            lastContactAt: null,
            stale: true,
            cause: null,
            muted: false,
            audioError: null,
        };
        shore.push = { status: 'inactive', reason: null, checkedAt: null };
        shore.listeners.clear();
        shore.pushListeners.clear();
        shore.refreshPushReadiness.mockResolvedValue(undefined);
        shore.retryReminderAcknowledgement.mockResolvedValue(undefined);
        instruments.storeListeners.clear();
        instruments.socketListeners.clear();
        instruments.direct = 'disconnected';
        instruments.lastError = null;
        instruments.viaRemoteAccess = false;
        instruments.piReachable = false;
        instruments.phoneCallback = null;
        instruments.receiver = {
            active: false,
            kind: 'phone',
            label: 'Phone GPS',
            detail: 'No external receiver',
            isNmea: false,
            satellites: null,
            hdop: null,
            avgAccuracy: null,
            qualityLabel: null,
            deviceName: null,
        };
        instruments.store = emptyInstrumentState();
        setAuthIdentityScope(null);
        localStorage.clear();
        getTrackingStatus.mockReturnValue({ isTracking: false, isMoving: false });
        followRouteState.isFollowing = false;
        followRouteState.voyagePlan = null;
        followRouteState.routeChanged = false;
        followRouteState.isRefreshing = false;
    });

    afterEach(() => {
        cleanup();
        publishPassageHudInfo(null);
        setPassageSquallInfoVisible(false);
        vi.useRealTimers();
        setAuthIdentityScope(null);
        localStorage.clear();
    });

    it('renders without crashing', () => {
        const { container } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('combines the boat receiver connection and diagnostics once, keeping weather and phone distinct', () => {
        seedPi('lan');
        const now = Date.now();
        instruments.store.satellites = { value: 32, lastUpdated: now, freshness: 'live' };
        instruments.receiver = {
            ...instruments.receiver,
            active: true,
            kind: 'vessel-nmea',
            label: 'On-board GPS',
            detail: 'Live via the Pi · DGPS · 32 sats · HDOP 0.7',
            qualityLabel: 'DGPS',
        };
        openStatus();
        const boat = within(screen.getByRole('region', { name: 'Boat GPS · Pi LAN' }));
        expect(screen.getAllByRole('heading', { name: 'Boat GPS · Pi LAN' })).toHaveLength(1);
        expect(boat.getByText('Live via the Pi')).toBeVisible();
        expect(boat.getByText('32')).toBeVisible();
        expect(screen.queryByText('On-board GPS')).not.toBeInTheDocument();
        expect(screen.queryByText('32 sats')).not.toBeInTheDocument();
        expect(screen.getByText('Weather position')).toBeVisible();
        expect(screen.getByRole('region', { name: 'Phone location' })).toBeVisible();
        expect(within(screen.getByTestId('gps-quality-panel')).getByTestId('gps-source-row')).toBeVisible();
    });

    it('keeps the receiver waiting state inside the single Boat GPS section before the first fix', () => {
        instruments.receiver = {
            ...instruments.receiver,
            active: true,
            kind: 'vessel-nmea',
            label: 'On-board GPS',
            detail: 'Yacht Devices YDWG-02 connected · Waiting for GPS position',
        };
        openStatus();
        const boat = within(screen.getByRole('region', { name: 'Boat GPS' }));
        expect(boat.getByText(/Waiting for GPS position/)).toBeVisible();
        expect(boat.getByText('Position time unavailable')).toBeVisible();
        expect(boat.getAllByText('Not reported')).toHaveLength(3);
        expect(screen.queryByText('On-board GPS')).not.toBeInTheDocument();
    });

    it('retains an external iPhone receiver identity in the separate phone section', () => {
        instruments.receiver = {
            ...instruments.receiver,
            active: true,
            kind: 'ios-accessory',
            label: 'Bad Elf GPS Pro',
            detail: 'Connected to iPhone · iPhone GPS currently in use',
        };
        openStatus();
        const phone = within(screen.getByRole('region', { name: 'Phone location' }));
        expect(phone.getByText('Bad Elf GPS Pro · Connected to iPhone · iPhone GPS currently in use')).toBeVisible();
        expect(screen.queryByRole('region', { name: /Boat GPS/ })).not.toBeInTheDocument();
    });

    it('moves fresh Shore Watch details into the info panel with a reduced-motion-aware blue halo', () => {
        seedShoreWatch();
        const navigate = vi.fn();
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={navigate} />);
        const opener = screen.getByRole('button', { name: /Shore Watch: Receiving vessel data/ });
        expect(opener).toHaveAttribute('data-shore-status', 'blue');
        expect(opener).toHaveClass('from-sky-400');
        expect(screen.getByTestId('system-status-halo')).toHaveClass('motion-safe:animate-pulse');
        expect(screen.queryByRole('region', { name: 'Shore Watch status' })).not.toBeInTheDocument();
        fireEvent.click(opener);
        const panel = within(screen.getByRole('region', { name: 'Shore Watch status' }));
        expect(panel.getByText('Receiving vessel data')).toBeInTheDocument();
        expect(panel.getByText(/Sound still depends on phone settings and delivery/)).toBeInTheDocument();
        fireEvent.click(panel.getByRole('button', { name: 'View Shore Watch' }));
        expect(navigate).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('goes amber while waiting, red for lost contact, and returns to normal after leaving', () => {
        shore.watch = { ...shore.watch, sessionCode: 'WATCHSESSION' };
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        const opener = screen.getByRole('button', { name: /Systems and GPS source/ });
        expect(opener).toHaveClass('from-amber-400');
        expect(opener).toHaveAccessibleName(/Waiting for vessel data/);
        emitShoreWatch({ cause: 'contact-lost', muted: true });
        expect(opener).toHaveClass('from-red-400');
        expect(opener).toHaveAccessibleName(/Vessel connection lost/);
        fireEvent.click(opener);
        expect(screen.getByRole('region', { name: 'Shore Watch status' })).toHaveTextContent(
            'In-app sound is silenced',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Close system status' }));
        emitShoreWatch({ sessionCode: null });
        expect(opener).not.toHaveAttribute('data-shore-status');
        expect(opener).toHaveClass('from-sky-400');
        expect(screen.queryByTestId('system-status-halo')).toBeNull();
    });

    it('keeps notification safety details collapsed until requested in the info panel', () => {
        seedShoreWatch();
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Systems and GPS source/ }));
        const panel = within(screen.getByRole('region', { name: 'Shore Watch status' }));
        const summary = panel.getByText('Notifications & safety');
        const registration = panel.getByText('Notification registration does not confirm delivery.');
        expect(summary).toBeVisible();
        expect(summary).toHaveAttribute('tabindex', '0');
        expect(registration).not.toBeVisible();
        expect(panel.getByText(/Phone notifications registered/)).toBeVisible();
        expect(panel.queryByRole('button', { name: 'Retry notifications' })).not.toBeInTheDocument();

        fireEvent.click(summary);
        expect(registration).toBeVisible();
        expect(panel.getByText(/Ordinary notifications do not bypass Silent mode/)).toBeVisible();
        expect(panel.getByText(/Focus, volume and notification settings/)).toBeVisible();
        expect(panel.getByText(/roughly every 1–2 minutes/)).toHaveTextContent('not an uninterrupted alarm');
        expect(panel.getByText(/bundled 24-second siren/)).toHaveTextContent('may not play in full');
        expect(panel.getByText(/Both the boat and phone need power and internet/)).toHaveTextContent(
            '24 hours; start a new watch to continue',
        );

        fireEvent.click(summary);
        expect(registration).not.toBeVisible();
    });

    it('does not conflate fresh vessel data with permission to deliver phone notifications', () => {
        seedShoreWatch();
        shore.push = { status: 'unavailable', reason: 'Notifications denied', checkedAt: Date.now() };
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        const opener = screen.getByRole('button', { name: /Systems and GPS source/ });
        expect(opener).toHaveAttribute('data-shore-status', 'blue');
        fireEvent.click(opener);
        expect(screen.getByText('Notifications denied')).toHaveClass('text-amber-300');
        expect(screen.getByText('Notifications denied')).toBeVisible();
        expect(screen.getByText('Notification registration does not confirm delivery.')).not.toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Retry notifications' }));
        expect(shore.refreshPushReadiness).toHaveBeenCalledOnce();
        act(() => {
            shore.push = { status: 'checking', reason: null, checkedAt: null };
            shore.pushListeners.forEach((listener) => listener(shore.push));
        });
        expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
        expect(screen.getByText('Checking background notifications…')).toBeVisible();
        emitShoreWatch({ stale: true });
        expect(opener).toHaveAttribute('data-shore-status', 'yellow');
        expect(screen.getByText('Waiting for fresh vessel data')).toBeInTheDocument();
    });

    it('keeps a failed reminder acknowledgement actionable without claiming remote reminders stopped', () => {
        seedShoreWatch();
        shore.watch = {
            ...shore.watch,
            cause: 'drag',
            muted: true,
            reminderError: 'Phone reminders could not be stopped. Retry when connected.',
        };
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Systems and GPS source/ }));
        expect(screen.getByRole('alert')).toHaveTextContent('Phone reminders could not be stopped');
        fireEvent.click(screen.getByRole('button', { name: 'Retry stopping phone reminders' }));
        expect(shore.retryReminderAcknowledgement).toHaveBeenCalledOnce();
        emitShoreWatch({ reminderPending: true, reminderError: null });
        expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled();
        expect(screen.getByText(/Confirming that repeating notifications are stopped/)).toBeInTheDocument();
        emitShoreWatch({ reminderPending: false, reminderError: null });
        expect(screen.queryByRole('button', { name: 'Retry stopping phone reminders' })).not.toBeInTheDocument();
    });

    it('shows boat satellites and fix quality separately from the phone’s reported metre accuracy', () => {
        vi.useFakeTimers();
        seedPi('lan');
        const now = Date.now();
        instruments.store.latitude = { value: -27.2, lastUpdated: now, freshness: 'live' };
        instruments.store.longitude = { value: 153.1, lastUpdated: now, freshness: 'live' };
        instruments.store.satellites = { value: 25, lastUpdated: now, freshness: 'live' };
        instruments.store.hdop = { value: 0.7, lastUpdated: now, freshness: 'live' };
        instruments.store.gpsFixQuality = 2;
        instruments.store.gpsFixQualityUpdatedAt = now;
        render(<SystemStatusButton currentView="map" onNavigateAnchor={vi.fn()} />);
        act(() =>
            instruments.phoneCallback?.({
                latitude: -27.4,
                longitude: 153.2,
                accuracy: 4.2,
                altitude: null,
                heading: null,
                speed: 0,
                timestamp: now,
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: /Systems and GPS source/ }));
        const boat = within(screen.getByRole('region', { name: 'Boat GPS · Pi LAN' }));
        expect(boat.getByText('Position just now')).toBeInTheDocument();
        expect(boat.getByText('25')).toBeInTheDocument();
        expect(boat.getByText('Differential GPS')).toBeInTheDocument();
        expect(boat.getByText('Not reported')).toBeInTheDocument();
        expect(boat.getByText('HDOP (geometry): 0.7')).toBeInTheDocument();
        expect(boat.queryByText('±4.2 m')).toBeNull();
        const phone = within(screen.getByRole('region', { name: 'Phone location' }));
        expect(phone.getByText('±4.2 m')).toBeInTheDocument();
        expect(phone.getByText('Not exposed')).toBeInTheDocument();
    });

    it('retires stale receiver metrics independently of fresh coordinates while the info page stays open', () => {
        vi.useFakeTimers();
        seedPi('lan');
        const now = Date.now();
        instruments.store.satellites = { value: 25, lastUpdated: now, freshness: 'live' };
        instruments.store.gpsAccuracyM = { value: 1.2, lastUpdated: now, freshness: 'live' };
        openStatus();
        expect(screen.getByText('25')).toBeInTheDocument();
        expect(screen.getByText('±1.2 m')).toBeInTheDocument();
        act(() => {
            vi.advanceTimersByTime(14_000);
        });
        const boat = within(screen.getByRole('region', { name: 'Boat GPS · Pi LAN' }));
        expect(boat.queryByText('25')).toBeNull();
        expect(boat.queryByText('±1.2 m')).toBeNull();
        expect(boat.getAllByText('Stale')).toHaveLength(2);
        fireEvent.click(screen.getByRole('button', { name: 'Close system status' }));
        expect(instruments.storeListeners.size).toBe(1);
    });

    it('opens forecast details and the squall key from the existing blue info button, and closes normally', () => {
        publishPassageHudInfo({
            moment: 'Sun 15:25 · +4.7 h',
            modelLabel: 'ECMWF',
            note: 'Chart rain ends +3.4 h',
            ownTime: ['squalls'],
            joining: true,
            credited: ['DWD', 'ECMWF', 'UK Met Office', 'JMA', 'Météo-France', 'Open-Meteo'],
            windCoverageHours: 46,
            rainCoverageHours: 3.4,
        });
        setPassageSquallInfoVisible(true);
        render(<SystemStatusButton currentView="map" onNavigateAnchor={vi.fn()} />);
        expect(screen.queryByTestId('passage-hud-info')).toBeNull();
        const opener = screen.getByRole('button', { name: /^Systems and GPS source/ });
        fireEvent.click(opener);
        expect(screen.getByTestId('route-scrub-credit')).toHaveTextContent('Météo-France, Open-Meteo');
        expect(screen.getByTestId('route-scrub-note')).toHaveTextContent('Chart rain ends +3.4 h');
        expect(screen.getByTestId('route-scrub-join')).toHaveTextContent('unchecked estimate');
        expect(screen.getByRole('contentinfo', { name: 'Squall intensity legend' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close system status' }));
        expect(screen.queryByTestId('passage-hud-info')).toBeNull();
        fireEvent.click(opener);
        expect(screen.getByTestId('route-scrub-note')).toHaveTextContent('Chart rain ends +3.4 h');
    });

    it('renders when no systems active (hidden)', () => {
        const { container } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        // Component may be empty when no systems are active
        expect(container).toBeDefined();
    });

    it('does not surface a cached active voyage as a duplicate system', () => {
        setAuthIdentityScope('status-owner');
        localStorage.setItem(
            authScopedStorageKey('thalassa_active_voyage'),
            JSON.stringify({
                id: 'active-voyage',
                user_id: 'status-owner',
                vessel_id: 'vessel-1',
                voyage_name: 'Brisbane to Gladstone',
                departure_port: 'Brisbane',
                destination_port: 'Gladstone',
                departure_time: null,
                eta: null,
                crew_count: 1,
                status: 'active',
                weather_master_id: 'status-owner',
                notes: null,
                created_at: '2026-07-26T00:00:00.000Z',
                updated_at: '2026-07-26T00:00:00.000Z',
            }),
        );

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);

        // Since 2026-09-08 the button is always present: it is where the punter
        // finds which GPS the app is reading, and that is never nothing.
        expect(screen.getByRole('button', { name: 'Systems and GPS source' })).toBeInTheDocument();
        // Nothing active: no count, so the look matches the spoken state.
        expect(screen.queryByTestId('system-status-count')).toBeNull();
    });

    it('keeps the controllable following-route status', () => {
        followRouteState.isFollowing = true;
        followRouteState.voyagePlan = { origin: 'Brisbane, QLD', destination: 'Gladstone, QLD' };

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /^Systems and GPS source: 1 active/ }));

        expect(screen.getByText('Following Route')).toBeInTheDocument();
        // Named for the row it belongs to. Every SystemRow action button used
        // to carry the same hard-coded "View signal propagation forecast",
        // which described none of them and made two buttons share one
        // accessible name.
        fireEvent.click(screen.getByRole('button', { name: 'Stop Following Route' }));
        expect(followRouteState.stopFollowing).toHaveBeenCalledOnce();
    });

    it('shows the count badge from one active system, matching the spoken count', () => {
        followRouteState.isFollowing = true;
        followRouteState.voyagePlan = { origin: 'Brisbane, QLD', destination: 'Gladstone, QLD' };

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        expect(screen.getByRole('button', { name: /^Systems and GPS source: 1 active/ })).toBeInTheDocument();
        expect(screen.getByTestId('system-status-count')).toHaveTextContent(/^1$/);
    });

    it('gives every row action its own accessible name', () => {
        followRouteState.isFollowing = true;
        followRouteState.voyagePlan = { origin: 'Brisbane, QLD', destination: 'Gladstone, QLD' };

        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /^Systems and GPS source: 1 active/ }));

        // The inactive NMEA row offers View (not an invented fault); the route row
        // offers Stop. Two buttons, two names — a screen reader can tell them
        // apart, and so can a query.
        expect(screen.getByRole('button', { name: 'View NMEA Backbone' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop Following Route' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View signal propagation forecast' })).not.toBeInTheDocument();
    });

    it('contains the active-system modal and restores focus after Escape', () => {
        getTrackingStatus.mockReturnValue({
            isTracking: true,
            isMoving: false,
            currentIntervalMs: 5_000,
            isRapidMode: true,
        });
        render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        const opener = screen.getByRole('button', { name: /^Systems and GPS source/ });
        opener.focus();
        fireEvent.click(opener);

        const close = screen.getByRole('button', { name: 'Close system status' });
        expect(screen.getByRole('dialog', { name: 'System Status' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'System Status' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it.each(['lan', 'cloud'] as const)(
        'recognises fresh Pi %s instruments despite an idle/failed phone socket',
        (via) => {
            seedPi(via);
            instruments.direct = 'error';
            instruments.lastError = 'The old gateway socket failed.';
            openStatus();

            expect(
                screen.getByText(via === 'lan' ? 'Connected via the Pi' : 'Receiving instruments via the Pi · cloud'),
            ).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Fix NMEA Backbone' })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'View NMEA Backbone' })).not.toBeInTheDocument();
            expect(screen.queryByText('GPS sentences / sec')).not.toBeInTheDocument();
            expect(screen.queryByText('All NMEA / sec')).not.toBeInTheDocument();
        },
    );

    it('recognises the paired Pi over tailnet', () => {
        seedPi('lan');
        instruments.viaRemoteAccess = true;
        openStatus();
        expect(screen.getByText(/Connected via the Pi.*tailnet/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Fix NMEA Backbone' })).not.toBeInTheDocument();
    });

    it('ages a stalled feed without new samples, then recovers from a store notification', async () => {
        vi.useFakeTimers();
        seedPi('cloud');
        openStatus();
        expect(screen.queryByRole('button', { name: 'View NMEA Backbone' })).not.toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(65_000);
        });
        expect(screen.getByRole('button', { name: 'View NMEA Backbone' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Fix NMEA Backbone' })).not.toBeInTheDocument();

        act(() => {
            seedPi('cloud');
            instruments.storeListeners.forEach((cb) => cb(instruments.store));
        });
        expect(screen.getByText('Receiving instruments via the Pi · cloud')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'View NMEA Backbone' })).not.toBeInTheDocument();
    });

    it.each(['quiet', 'phone', 'health-only'])('does not claim a backbone connection from %s evidence', (kind) => {
        if (kind !== 'health-only') seedPi('cloud');
        if (kind === 'quiet') instruments.store.sog.value = null;
        if (kind === 'phone') instruments.store.remote!.source = 'device';
        instruments.piReachable = true;
        openStatus();
        expect(screen.getByRole('button', { name: 'View NMEA Backbone' })).toBeInTheDocument();
        expect(screen.queryByText(/Receiving instruments via the Pi/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Fix NMEA Backbone' })).not.toBeInTheDocument();
    });

    it('keeps Fix for a real direct gateway fault and updates immediately when it connects', () => {
        instruments.direct = 'error';
        instruments.lastError = 'No route to that network. Raw diagnostic follows.';
        openStatus();
        expect(screen.getByText('No route to that network.')).toBeInTheDocument();
        const navigate = vi.fn();
        window.addEventListener('thalassa:navigate', navigate);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Fix NMEA Backbone' }));
            expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ detail: { tab: 'nmea' } }));
        } finally {
            window.removeEventListener('thalassa:navigate', navigate);
        }
        act(() => {
            instruments.direct = 'connected';
            instruments.store.connectionStatus = 'connected';
            instruments.socketListeners.forEach((cb) => cb());
        });
        expect(screen.queryByRole('button', { name: 'Fix NMEA Backbone' })).not.toBeInTheDocument();
        expect(screen.getByText(/waiting for instrument/i)).toBeInTheDocument();
        expect(screen.getByText('GPS sentences / sec')).toBeInTheDocument();
    });

    it('retains the shared cloud reader only while open and unsubscribes on unmount', () => {
        const { unmount } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        expect(instruments.retain).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /Systems and GPS source/ }));
        expect(instruments.retain).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole('button', { name: 'Close system status' }));
        expect(instruments.release).toHaveBeenCalledOnce();
        unmount();
        expect(instruments.storeListeners.size).toBe(0);
        expect(instruments.socketListeners.size).toBe(0);
    });

    it('releases its cloud interest if the header unmounts with the modal still open', () => {
        const { unmount } = render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Systems and GPS source/ }));
        unmount();
        expect(instruments.retain).toHaveBeenCalledOnce();
        expect(instruments.release).toHaveBeenCalledOnce();
        expect(instruments.storeListeners.size).toBe(0);
        expect(instruments.socketListeners.size).toBe(0);
    });

    it('rechecks stale readings immediately on foreground without waiting for the next poll', () => {
        vi.useFakeTimers();
        seedPi('cloud');
        openStatus();
        const hidden = vi.spyOn(document, 'hidden', 'get');
        try {
            hidden.mockReturnValue(true);
            vi.setSystemTime(Date.now() + 65_000);
            hidden.mockReturnValue(false);
            fireEvent(document, new Event('visibilitychange'));
            expect(screen.getByRole('button', { name: 'View NMEA Backbone' })).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Fix NMEA Backbone' })).not.toBeInTheDocument();
        } finally {
            hidden.mockRestore();
        }
    });
});

function emptyInstrumentState(): NmeaStoreState {
    const metric = () => ({ value: null, lastUpdated: 0, freshness: 'dead' as const });
    return {
        tws: metric(),
        twa: metric(),
        twaSigned: metric(),
        heel: metric(),
        pitch: metric(),
        twd: metric(),
        aws: metric(),
        awa: metric(),
        stw: metric(),
        heading: metric(),
        headingTrue: metric(),
        depth: metric(),
        sog: metric(),
        cog: metric(),
        waterTemp: metric(),
        rudder: metric(),
        rpm: metric(),
        voltage: metric(),
        latitude: metric(),
        longitude: metric(),
        hdop: metric(),
        satellites: metric(),
        depthSource: null,
        depthReference: null,
        depthOffsetM: null,
        gpsFixQuality: null,
        gpsFixQualityUpdatedAt: 0,
        gpsSource: null,
        gpsAccuracyM: metric(),
        connectionStatus: 'disconnected',
        remote: null,
        lastAnyUpdate: 0,
    };
}

function seedPi(via: 'lan' | 'cloud') {
    const now = Date.now();
    instruments.store = emptyInstrumentState();
    instruments.store.connectionStatus = 'remote';
    instruments.store.remote = {
        source: 'pi',
        via,
        deviceLabel: 'calypso',
        reportedAt: now,
        receivedAt: now,
        positionSampleAt: now,
    };
    // A vessel alongside is still connected: zero is a valid reading.
    instruments.store.sog = { value: 0, lastUpdated: now, freshness: 'live' };
    instruments.store.lastAnyUpdate = now;
}

function openStatus() {
    render(<SystemStatusButton currentView="dashboard" onNavigateAnchor={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Systems and GPS source/ }));
}

function seedShoreWatch() {
    const now = Date.now();
    shore.watch = {
        ...shore.watch,
        sessionCode: 'WATCHSESSION',
        stale: false,
        lastContactAt: now,
        position: {
            type: 'position',
            vessel: { latitude: -20.1, longitude: 148.8, accuracy: 3, heading: 0, speed: 0, timestamp: now },
            anchor: { latitude: -20.1, longitude: 148.8, timestamp: now },
            distance: 10,
            swingRadius: 50,
            isAlarm: false,
            timestamp: now,
        },
    };
    shore.push = { status: 'ready', reason: null, checkedAt: now };
}

function emitShoreWatch(patch: Partial<ShoreAlarmSnapshot>) {
    shore.watch = { ...shore.watch, ...patch };
    act(() => shore.listeners.forEach((listener) => listener()));
}
