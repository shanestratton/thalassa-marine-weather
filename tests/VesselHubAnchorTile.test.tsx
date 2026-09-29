/**
 * The Vessel page's Anchor tile tells the same story as the System status
 * box's Anchor watch row (review 2026-09-29). It used to know only this
 * phone's own watch and "a shore session exists", so:
 *
 *  (a) a watch only the Pi kept (the phone never joined shore, or left shore
 *      view) read "Up";
 *  (b) a paused watch read "Up";
 *  (c) a drag alarm reported by the Pi stayed a calm cyan "Down · Pi";
 *  (d) a shore session joined from another phone was credited to the Pi.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';

const NOW = Date.now();
const noShore = (): ShoreAlarmSnapshot => ({
    sessionCode: null,
    position: null,
    lastContactAt: null,
    stale: true,
    cause: null,
    muted: false,
    audioError: null,
});
const anchor = vi.hoisted(() => ({
    local: { state: 'idle', distanceFromAnchor: 0, swingRadius: 0, alarmTriggeredAt: null, alarmCause: null } as {
        state: string;
        distanceFromAnchor: number;
        swingRadius: number;
        alarmTriggeredAt: number | null;
        alarmCause: string | null;
    },
    shore: {} as ShoreAlarmSnapshot,
    piSession: null as string | null,
}));

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
    AnchorWatchService: {
        subscribe: (listener: (snapshot: unknown) => void) => {
            listener(anchor.local);
            return () => undefined;
        },
    },
}));
// The old tile read this; it is fed the same story so the old code gets a fair run.
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        onStateChange: (listener: (state: { role: string; sessionCode: string | null }) => void) => {
            listener({ role: anchor.shore.sessionCode ? 'shore' : 'idle', sessionCode: anchor.shore.sessionCode });
            return () => undefined;
        },
    },
}));
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: () => anchor.shore,
        subscribe: () => () => undefined,
    },
}));
vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { keepingSessionCode: () => anchor.piSession },
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: async () => [] }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../hooks/useVesselReadinessCounts', () => ({
    useVesselReadinessCounts: () => ({ overdueCount: 0, expiringDocsCount: 0, expiringEquipCount: 0 }),
}));
vi.mock('../hooks/useCloudTelemetry', () => ({ useCloudTelemetry: () => ({ latest: null, piPrimary: false }) }));
vi.mock('../hooks/useTripRoute', () => ({ useTripRoute: () => null }));
vi.mock('../components/nmea/useNmeaStore', () => ({
    useNmeaConnectionStatus: () => ({ status: 'disconnected' }),
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { getFeedStatus: () => 'unavailable' } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/routeTracer', () => ({ loadSavedTraces: () => [] }));
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

function liveShore(sessionCode: string, patch: Partial<ShoreAlarmSnapshot> = {}): ShoreAlarmSnapshot {
    return {
        ...noShore(),
        sessionCode,
        stale: false,
        lastContactAt: NOW,
        position: {
            type: 'position',
            vessel: { latitude: -20.27, longitude: 148.72, accuracy: 3, heading: 0, speed: 0, timestamp: NOW },
            anchor: { latitude: -20.27, longitude: 148.72, timestamp: NOW },
            distance: 18,
            swingRadius: 50,
            isAlarm: false,
            timestamp: NOW,
        },
        ...patch,
    };
}

function anchorTile() {
    render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
    return screen.getByRole('button', { name: /^Anchor watch, / });
}

afterEach(() => {
    cleanup();
    anchor.local = { state: 'idle', distanceFromAnchor: 0, swingRadius: 0, alarmTriggeredAt: null, alarmCause: null };
    anchor.shore = noShore();
    anchor.piSession = null;
});

describe('the Vessel Anchor tile', () => {
    it('reads Up only when nothing anywhere keeps a watch', () => {
        anchor.shore = noShore();
        const tile = anchorTile();
        expect(tile).toHaveAccessibleName('Anchor watch, up');
        expect(tile).toHaveTextContent(/Up$/);
    });

    it('(a) keeps the anchor down when only the Pi keeps the watch', () => {
        anchor.shore = noShore();
        anchor.piSession = 'PISESSION';
        const tile = anchorTile();
        expect(tile).toHaveAccessibleName('Anchor watch, down, watched by the Pi, no updates on this phone');
        expect(tile).toHaveTextContent('Down · Pi');
    });

    it('(b) says Paused, not Up, for a paused watch', () => {
        anchor.shore = noShore();
        anchor.local = { ...anchor.local, state: 'paused', swingRadius: 45 };
        const tile = anchorTile();
        expect(tile).toHaveAccessibleName('Anchor watch, down, watch paused');
        expect(tile).toHaveTextContent('Paused');
    });

    it('(c) turns a drag alarm reported by the Pi into DRAGGING', () => {
        anchor.shore = liveShore('PISESSION', { cause: 'drag' });
        anchor.piSession = 'PISESSION';
        const tile = anchorTile();
        expect(tile).toHaveAccessibleName('Anchor watch, dragging, watched by the Pi');
        expect(tile).toHaveTextContent('DRAGGING');
    });

    it('(d) does not credit the Pi with a watch kept by another device', () => {
        anchor.shore = liveShore('OTHERPHONE');
        const tile = anchorTile();
        expect(tile).toHaveAccessibleName('Anchor watch, down, watched from another device');
        expect(tile).toHaveTextContent('Down · Remote');
        expect(tile).not.toHaveTextContent('Pi');
    });

    // After a hand-off stopWatch() zeroes this phone's distance but keeps its
    // swing radius. The Drag Alarm card drew the boat on its anchor from those
    // leftovers: "0m of 45m swing" (final review 2026-09-29).
    it("draws the Pi's own drag report in the hero, never this phone's stopped watch", () => {
        anchor.local = { ...anchor.local, state: 'idle', distanceFromAnchor: 0, swingRadius: 45 };
        anchor.shore = liveShore('PISESSION', { cause: 'drag' });
        anchor.shore.position = { ...anchor.shore.position!, distance: 62, swingRadius: 50 };
        anchor.piSession = 'PISESSION';
        anchorTile();
        const arc = screen.getByLabelText(/m swing$/);
        expect(arc).toHaveAccessibleName('Anchor watch alarm, 62m of 50m swing');
        expect(screen.queryByLabelText(/0m of 45m swing/)).toBeNull();
    });

    it('hides the swing arc while the remote report is stale, leaving the status words', () => {
        anchor.local = { ...anchor.local, state: 'idle', distanceFromAnchor: 0, swingRadius: 45 };
        anchor.shore = liveShore('PISESSION', { cause: 'drag', stale: true });
        anchor.piSession = 'PISESSION';
        anchorTile();
        expect(screen.queryByLabelText(/m swing$/)).toBeNull();
    });

    it('still says Down · Pi for a healthy watch the Pi keeps', () => {
        anchor.shore = liveShore('PISESSION');
        anchor.piSession = 'PISESSION';
        const tile = anchorTile();
        expect(tile).toHaveAccessibleName('Anchor watch, down, watched by the Pi');
        expect(tile).toHaveTextContent('Down · Pi');
    });
});
