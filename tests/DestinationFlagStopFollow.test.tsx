/**
 * The destination flag is the chart's own door to stop following (Shane
 * 2026-09-09: a green flag at Lady Musgrave "even though i do not have that
 * particular route plugged in" — and nowhere on the chart to ask what it was).
 * Tapping the flag or its chip fires onTap; MapHub turns that into a centred
 * "Stop following?" confirm.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    markers: [] as Array<{ element: HTMLElement; remove: ReturnType<typeof vi.fn> }>,
    watchPosition: vi.fn(() => vi.fn()),
}));

vi.mock('mapbox-gl', () => {
    class Marker {
        element: HTMLElement;
        remove = vi.fn();
        setLngLat = vi.fn().mockReturnThis();
        addTo = vi.fn().mockReturnThis();
        constructor(opts: { element: HTMLElement }) {
            this.element = opts.element;
            mocks.markers.push(this);
        }
    }
    return { default: { Marker }, Marker };
});
vi.mock('../services/GpsService', () => ({ GpsService: { watchPosition: mocks.watchPosition } }));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({}) } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { useDestinationFlag } from '../components/map/useDestinationFlag';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const PLAN = {
    origin: 'Newport',
    destination: 'Coral Sea',
    destinationCoordinates: { lat: -23.9, lon: 152.4 },
} as unknown as import('../types/navigation').VoyagePlan;

describe('destination flag — tappable', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper');
        mocks.markers.length = 0;
        useFollowRouteStore.setState({
            isFollowing: true,
            voyagePlan: PLAN,
            routeCoords: [
                { lat: -27.2, lon: 153.1 },
                { lat: -23.9, lon: 152.4 },
            ],
            startedAt: new Date().toISOString(),
            lastRefresh: new Date().toISOString(),
        });
    });
    afterEach(() => {
        cleanup();
        useFollowRouteStore.getState().stopFollowing();
    });

    it('names the destination for the screen reader and fires onTap from the flag and from its chip', () => {
        const onTap = vi.fn();
        const mapRef = { current: {} as never };
        renderHook(() => useDestinationFlag(mapRef, true, { onTap }));
        const flag = mocks.markers.at(-1)?.element;
        expect(flag).toBeDefined();
        expect(flag!.getAttribute('role')).toBe('button');
        expect(flag!.getAttribute('aria-label')).toBe('Following Coral Sea — tap to stop following');
        expect(flag!.style.pointerEvents).toBe('auto');
        act(() => {
            flag!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onTap).toHaveBeenCalledTimes(1);
        const chip = flag!.querySelector('.destination-flag-chip') as HTMLElement;
        expect(chip.style.pointerEvents).toBe('auto');
        act(() => {
            chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onTap).toHaveBeenCalledTimes(2);
        act(() => {
            flag!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(onTap).toHaveBeenCalledTimes(3);
    });

    it('mounts nothing when not following', () => {
        useFollowRouteStore.getState().stopFollowing();
        const mapRef = { current: {} as never };
        renderHook(() => useDestinationFlag(mapRef, true, { onTap: vi.fn() }));
        expect(mocks.markers.length).toBe(0);
    });
});
