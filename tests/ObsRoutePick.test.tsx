/**
 * Pulling a route up on Obs (build 124, package HS).
 *
 * Before: picking ANY route in Layers → Routes switched the Passage overlay off
 * — even the route being followed, which left a strip running with no ghost,
 * waypoints or framing — and a route that was not followed got no HUD at all
 * (Shane, 2026-10-08: "the HUD is not working on the obs page when you pull up
 * a route????").
 *
 * Now, one rule: the HUD follows the route on screen.
 *   - Picking the FOLLOWED route keeps the overlay (and its HUD).
 *   - Picking any other route turns the overlay off, as before, and that route
 *     is previewed on the HUD until it is cleared or replaced.
 *   - Picking the running recording's own track keeps the overlay; another
 *     track turns it off and previews nothing (nothing lies ahead on it).
 * Pulling a route up opens the HUD; it never follows anything.
 *
 * Fictional passages in the Mediterranean and off New England: a global app.
 */
import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import {
    isFollowedRoutePick,
    pickObsRoute,
    pickObsTrack,
    useObsRoutePreview,
} from '../components/map/mapHub/obsRoutePick';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    __resetPassageHudForTests,
    getPassageHudPreviewRoute,
    isPassageHudOpen,
    setPassageHudOpen,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn, setPassageOverlay } from '../stores/chartPassageOverlay';
import type { VoyagePlan } from '../types';

const route = (id: string, label: string, points: { lat: number; lon: number }[]): RouteOrTrack => ({
    id,
    label,
    sublabel: 'Saved route',
    points,
    bbox: [
        Math.min(...points.map((p) => p.lon)),
        Math.min(...points.map((p) => p.lat)),
        Math.max(...points.map((p) => p.lon)),
        Math.max(...points.map((p) => p.lat)),
    ],
    timestamp: 0,
    distanceNm: 40,
    isLocal: true,
    kind: 'sea',
});

// Followed: Palma → Ibiza. Previewed: Newport RI → Block Island.
const FOLLOWED_POINTS = [
    { lat: 39.55, lon: 2.63 },
    { lat: 39.2, lon: 2.0 },
    { lat: 38.91, lon: 1.44 },
];
const FOLLOWED = route('voyage-balearics', 'Palma → Ibiza', FOLLOWED_POINTS);
const OTHER = route('saved-block-island', 'Newport → Block Island', [
    { lat: 41.48, lon: -71.33 },
    { lat: 41.3, lon: -71.45 },
    { lat: 41.17, lon: -71.58 },
]);
const PLAN = { origin: 'Palma', destination: 'Ibiza', waypoints: [] } as unknown as VoyagePlan;

function setters() {
    return {
        setActiveChartRoute: vi.fn(),
        setActiveChartTrack: vi.fn(),
        setPickedRoute: vi.fn(),
    };
}

beforeEach(() => {
    localStorage.clear();
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    useFollowRouteStore.getState().stopFollowing();
});
afterEach(() => {
    useFollowRouteStore.getState().stopFollowing();
});

describe('is this the followed route?', () => {
    const followed = { isFollowing: true, voyageId: 'voyage-balearics', routeCoords: FOLLOWED_POINTS };

    it('by its id, or by the very same line', () => {
        expect(isFollowedRoutePick(FOLLOWED, followed)).toBe(true);
        expect(isFollowedRoutePick({ ...FOLLOWED, id: 'saved-copy' }, followed)).toBe(true);
        expect(isFollowedRoutePick(OTHER, followed)).toBe(false);
        // A same-named route on a different line is a different route.
        const sameName: RouteOrTrack = { ...OTHER, label: FOLLOWED.label };
        expect(isFollowedRoutePick(sameName, followed)).toBe(false);
    });

    it('the followed line as the follow store keeps it: a repeated vertex in the saved trace is the same route', () => {
        // The Routes picker hands over the saved trace's raw points; the follow
        // store keeps sanitizeRouteCoordinates(points), which drops a
        // consecutive duplicate. Ids differ too ('saved:<trace>' vs the voyage).
        const raw = [FOLLOWED_POINTS[0], FOLLOWED_POINTS[1], { ...FOLLOWED_POINTS[1] }, FOLLOWED_POINTS[2]];
        useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-balearics', raw);
        expect(useFollowRouteStore.getState().routeCoords).toHaveLength(3);
        const picked = route('saved:trace-balearics', 'Palma → Ibiza', raw);
        expect(isFollowedRoutePick(picked, useFollowRouteStore.getState())).toBe(true);
        // And picking it keeps the overlay, with no preview.
        setPassageOverlay(true);
        pickObsRoute(picked, setters());
        expect(isPassageOverlayOn()).toBe(true);
    });

    it('never when nothing is being followed', () => {
        expect(isFollowedRoutePick(FOLLOWED, { ...followed, isFollowing: false })).toBe(false);
        expect(isFollowedRoutePick(FOLLOWED, { ...followed, routeCoords: [] })).toBe(false);
        expect(isFollowedRoutePick({ ...FOLLOWED, id: '' }, { ...followed, voyageId: '', routeCoords: [] })).toBe(
            false,
        );
    });
});

describe('the Routes picker', () => {
    it('picking the followed route keeps the Passage overlay, and opens the HUD', () => {
        useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-balearics', FOLLOWED_POINTS);
        setPassageOverlay(true);
        const set = setters();
        pickObsRoute(FOLLOWED, set);
        expect(isPassageOverlayOn()).toBe(true);
        expect(isPassageHudOpen()).toBe(true);
        expect(set.setActiveChartRoute).toHaveBeenCalledWith(FOLLOWED);
        expect(set.setActiveChartTrack).toHaveBeenCalledWith(null);
        expect(set.setPickedRoute).toHaveBeenCalledWith(FOLLOWED);
    });

    it('picking another route switches the overlay off and opens the HUD for its preview, following nothing', () => {
        useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-balearics', FOLLOWED_POINTS);
        setPassageOverlay(true);
        const followStoreWrites = vi.fn();
        const unsubscribe = useFollowRouteStore.subscribe(followStoreWrites);
        try {
            pickObsRoute(OTHER, setters());
        } finally {
            unsubscribe();
        }
        expect(isPassageOverlayOn()).toBe(false);
        expect(isPassageHudOpen()).toBe(true);
        expect(followStoreWrites).not.toHaveBeenCalled();
        expect(useFollowRouteStore.getState().voyageId).toBe('voyage-balearics');
    });

    it('with nothing followed, any pick is a preview: the overlay goes off, the HUD opens', () => {
        setPassageOverlay(true);
        pickObsRoute(FOLLOWED, setters());
        expect(isPassageOverlayOn()).toBe(false);
        expect(isPassageHudOpen()).toBe(true);
        expect(useFollowRouteStore.getState().isFollowing).toBe(false);
    });

    it('None clears the pick and the overlay, and leaves the HUD as it was', () => {
        setPassageOverlay(true);
        setPassageHudOpen(false);
        const set = setters();
        pickObsRoute(null, set);
        expect(set.setActiveChartRoute).toHaveBeenCalledWith(null);
        expect(set.setPickedRoute).toHaveBeenCalledWith(null);
        expect(set.setActiveChartTrack).not.toHaveBeenCalled();
        expect(isPassageOverlayOn()).toBe(false);
        expect(isPassageHudOpen()).toBe(false);
    });
});

describe('the Tracks picker', () => {
    const TRACK = route('rec-balearics', 'Palma → Ibiza (sailed)', FOLLOWED_POINTS.slice(0, 2));

    it('picking the running recording’s own track keeps the overlay', () => {
        setPassageOverlay(true);
        const set = setters();
        pickObsTrack(TRACK, { ...set, activeVoyageId: 'rec-balearics' });
        expect(isPassageOverlayOn()).toBe(true);
        expect(set.setActiveChartTrack).toHaveBeenCalledWith(TRACK);
        expect(set.setActiveChartRoute).toHaveBeenCalledWith(null);
        expect(set.setPickedRoute).toHaveBeenCalledWith(null);
    });

    it('while a route is followed, even the recording’s own track switches it off: the overlay draws the route', () => {
        // With a followed route the overlay draws the ROUTE, not the recording's
        // track, and the whole-route overview would pull the camera back off
        // the track the skipper asked to see (review, build 124 HS).
        useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-balearics', FOLLOWED_POINTS);
        setPassageOverlay(true);
        const set = setters();
        pickObsTrack(TRACK, { ...set, activeVoyageId: 'rec-balearics' });
        expect(isPassageOverlayOn()).toBe(false);
        expect(set.setActiveChartTrack).toHaveBeenCalledWith(TRACK);
        expect(useFollowRouteStore.getState().voyageId).toBe('voyage-balearics');
    });

    it('any other track switches it off, as before, and opens no preview', () => {
        setPassageOverlay(true);
        setPassageHudOpen(false);
        pickObsTrack(TRACK, { ...setters(), activeVoyageId: 'rec-elsewhere' });
        expect(isPassageOverlayOn()).toBe(false);
        expect(isPassageHudOpen()).toBe(false);
        pickObsTrack(TRACK, { ...setters(), activeVoyageId: null });
        expect(isPassageOverlayOn()).toBe(false);
    });
});

describe('the preview the chart publishes for the HUD', () => {
    function useChart(publishes: boolean) {
        const [active, setActive] = useState<RouteOrTrack | null>(null);
        const [picked, setPicked] = useState<RouteOrTrack | null>(null);
        const preview = useObsRoutePreview({ activeChartRoute: active, pickedRoute: picked, publishes, allowed: true });
        return { preview, setActive, setPicked };
    }

    it('publishes a picked route that is not followed, and clears it when it leaves the chart', () => {
        const view = renderHook(() => useChart(true));
        expect(getPassageHudPreviewRoute()).toBeNull();
        act(() => {
            view.result.current.setActive(OTHER);
            view.result.current.setPicked(OTHER);
        });
        expect(view.result.current.preview).toBe(OTHER);
        expect(getPassageHudPreviewRoute()).toEqual({ id: OTHER.id, label: OTHER.label, points: OTHER.points });
        expect(getPassageHudPreviewRoute()?.points).toBe(OTHER.points);
        // The Passage overlay put the followed line on screen instead: no preview.
        act(() => view.result.current.setActive(FOLLOWED));
        expect(getPassageHudPreviewRoute()).toBeNull();
        act(() => view.result.current.setActive(OTHER));
        expect(getPassageHudPreviewRoute()?.id).toBe(OTHER.id);
        act(() => view.result.current.setActive(null));
        expect(getPassageHudPreviewRoute()).toBeNull();
    });

    it('never previews the followed route itself', () => {
        useFollowRouteStore.getState().startFollowing(PLAN, 'voyage-balearics', FOLLOWED_POINTS);
        const view = renderHook(() => useChart(true));
        act(() => {
            view.result.current.setActive(FOLLOWED);
            view.result.current.setPicked(FOLLOWED);
        });
        expect(view.result.current.preview).toBeNull();
        expect(getPassageHudPreviewRoute()).toBeNull();
        // …until it stops being followed: then the line on screen is just a route.
        act(() => useFollowRouteStore.getState().stopFollowing());
        expect(getPassageHudPreviewRoute()?.id).toBe(FOLLOWED.id);
    });

    it('an account change clears the preview, and the chart agrees with the strip', () => {
        const view = renderHook(() => useChart(true));
        act(() => {
            view.result.current.setActive(OTHER);
            view.result.current.setPicked(OTHER);
        });
        expect(view.result.current.preview).toBe(OTHER);
        act(() => setAuthIdentityScope('another-skipper'));
        expect(getPassageHudPreviewRoute()).toBeNull();
        expect(view.result.current.preview).toBeNull();
        // A new pick under the new account previews again.
        const fresh = { ...OTHER, id: 'saved-block-island-2' };
        act(() => {
            view.result.current.setActive(fresh);
            view.result.current.setPicked(fresh);
        });
        expect(view.result.current.preview).toBe(fresh);
        expect(getPassageHudPreviewRoute()?.id).toBe('saved-block-island-2');
        act(() => setAuthIdentityScope(null));
        expect(getPassageHudPreviewRoute()).toBeNull();
    });

    it('an embedded or pin-view chart never touches the HUD’s preview', () => {
        const main = renderHook(() => useChart(true));
        act(() => {
            main.result.current.setActive(OTHER);
            main.result.current.setPicked(OTHER);
        });
        const embedded = renderHook(() => useChart(false));
        act(() => {
            embedded.result.current.setActive(FOLLOWED);
            embedded.result.current.setPicked(FOLLOWED);
        });
        embedded.unmount();
        expect(getPassageHudPreviewRoute()?.id).toBe(OTHER.id);
        main.unmount();
        expect(getPassageHudPreviewRoute()).toBeNull();
    });
});

describe('MapHub wiring (source pins)', () => {
    const hub = readFileSync('components/map/MapHub.tsx', 'utf8');

    it('both pickers go through the shared pick rules', () => {
        expect(hub).toMatch(/onSelect=\{\(item\) =>\s*pickObsRoute\(item, \{/);
        expect(hub).toMatch(/onSelect=\{\(item\) =>\s*pickObsTrack\(item, \{/);
        // No unconditional overlay-off after a pick any more.
        expect(hub).not.toMatch(/setActiveChartRoute\(item\);\s*if \(item\) setActiveChartTrack\(null\);/);
    });

    it('the preview counts as a HUD on the chart and draws its forecast boat without the Passage overlay', () => {
        expect(hub).toContain('useObsRoutePreview({');
        expect(hub.replace(/\s+/g, ' ')).toMatch(
            /const passageHudOnChart = \(hasRecording \|\| \(isFollowingRoute && followedRouteCoords\.length >= 2\) \|\| obsRoutePreview !== null\) &&/,
        );
        expect(hub).toContain(
            'useRouteGhostMarker(mapRef, mapReady && !planningSurface && (passageOverlay || obsRoutePreview !== null));',
        );
    });
});
