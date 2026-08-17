/**
 * A saved route that exists in the account but not on this handset must still
 * be openable.
 *
 * The Route Tracer's library is localStorage, so a route traced on the iPad is
 * absent on the phone, and a route traced before a reinstall is absent on the
 * same phone afterwards. The Log page blocked those rows with "This route has
 * no saved trace on this device" and offered Route Tracer as the fix — which
 * reads the same store, so it could not open them either. A closed loop, and
 * the likeliest reason Shane's punters found a saved route simply
 * unfollowable (2026-08-17).
 *
 * The waypoints were never lost; saved_routes has them. These tests pin the
 * two properties that make fetching them safe: the id survives the hop, and a
 * route is never silently shortened.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));

import { decodeSavedRoutePoints, fetchSavedRoutePoints } from '../services/savedRoutePoints';
import { adoptServerRoute, loadSavedTraces } from '../services/routeTracer';

beforeEach(() => {
    localStorage.clear();
});

describe('decoding account geometry', () => {
    it('accepts a well-formed route', () => {
        expect(
            decodeSavedRoutePoints([
                [-27.2, 153.1],
                [-27.3, 153.2],
            ]),
        ).toEqual([
            { lat: -27.2, lon: 153.1 },
            { lat: -27.3, lon: 153.2 },
        ]);
    });

    it('rejects the WHOLE route when one pair is malformed, rather than shortening it', () => {
        // savedRoutesSync filters bad pairs and carries on, which is fine for
        // redrawing a list. It is not fine for a line somebody steers: a route
        // quietly two waypoints shorter is a different route, and the two it
        // dropped are the ones that went around something.
        expect(
            decodeSavedRoutePoints([
                [-27.2, 153.1],
                [null, 153.2],
                [-27.4, 153.3],
            ]),
        ).toBeNull();
        expect(
            decodeSavedRoutePoints([
                [-27.2, 153.1],
                [Number.NaN, 153.2],
            ]),
        ).toBeNull();
    });

    it('rejects anything that is not a route', () => {
        expect(decodeSavedRoutePoints(null)).toBeNull();
        expect(decodeSavedRoutePoints('a line')).toBeNull();
        expect(decodeSavedRoutePoints([])).toBeNull();
        expect(decodeSavedRoutePoints([[-27.2, 153.1]])).toBeNull(); // one point is not a route
    });
});

describe('adopting an account route onto this device', () => {
    const points = [
        { lat: -27.2, lon: 153.1 },
        { lat: -27.3, lon: 153.2 },
    ];

    it('keeps the account id — everything downstream is keyed by it', () => {
        // saveTrace's overwriteId cannot do this: it looks the id up locally,
        // finds nothing in exactly this case, and mints a fresh one — silently
        // detaching the copy from the voyage that pointed at it, so the follow
        // link and the Cast Off gate would both stop recognising the route.
        const id = '11111111-2222-4333-8444-555555555555';
        const adopted = adoptServerRoute(id, 'Newport → Peel', points);
        expect(adopted?.id).toBe(id);
        expect(loadSavedTraces().find((t) => t.id === id)?.points).toHaveLength(2);
    });

    it('carries NO verification across', () => {
        // The envelope is a claim about a specific boat's draft against a
        // specific chart library. Neither is necessarily true on the device
        // now holding it, so the route arrives unchecked and the tracer's own
        // gate decides. Inheriting a clearance here would be a false one.
        const adopted = adoptServerRoute('id-1', 'Route', points);
        expect(adopted).not.toBeNull();
        expect((adopted as unknown as { verification?: unknown }).verification).toBeUndefined();
    });

    it('replaces rather than duplicates when adopted twice', () => {
        adoptServerRoute('id-2', 'Route', points);
        adoptServerRoute('id-2', 'Route renamed', points);
        expect(loadSavedTraces().filter((t) => t.id === 'id-2')).toHaveLength(1);
        expect(loadSavedTraces().find((t) => t.id === 'id-2')?.name).toBe('Route renamed');
    });

    it('refuses a route that is not one', () => {
        expect(adoptServerRoute('id-3', 'Route', [{ lat: -27.2, lon: 153.1 }])).toBeNull();
        expect(adoptServerRoute('', 'Route', points)).toBeNull();
    });
});

describe('fetching when there is no account to fetch from', () => {
    it('says the waypoints are elsewhere, not that something went wrong', async () => {
        // A bare "couldn't load" invites retrying at anchor forever. The
        // skipper can act on knowing it needs a connection.
        const result = await fetchSavedRoutePoints('some-id');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/Connect to fetch/i);
    });

    it('does not even try without a route id', async () => {
        const result = await fetchSavedRoutePoints('   ');
        expect(result.ok).toBe(false);
    });
});
