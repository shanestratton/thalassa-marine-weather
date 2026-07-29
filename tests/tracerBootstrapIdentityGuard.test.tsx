import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Opening the tracer kicks off a network merge of the account's saved routes.
 * That merge is a round trip, so the skipper can sign out — or switch boats to
 * another account — while it is still in flight.
 *
 * Without an identity guard the late arrival wins and the picker fills with
 * the PREVIOUS account's routes, on a page that is now signed out. Every other
 * saved-routes path in this codebase captures the scope up front and drops the
 * result if it is stale; this pins the bootstrap to the same rule.
 */

const h = vi.hoisted(() => {
    let current = 'scope-A';
    let resolve: (v: unknown[]) => void = () => {};
    let promise: Promise<unknown[]> = Promise.resolve([]);
    return {
        get current() {
            return current;
        },
        signOut: () => {
            current = 'scope-B';
        },
        /** Fresh in-flight merge per test — no state shared between them. */
        reset: () => {
            current = 'scope-A';
            promise = new Promise<unknown[]>((r) => {
                resolve = r;
            });
        },
        land: (v: unknown[]) => resolve(v),
        pending: () => promise,
    };
});

vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ key: h.current, generation: 1 }),
    isAuthIdentityScopeCurrent: (s: { key: string }) => s.key === h.current,
}));
vi.mock('../services/routeTracer', () => ({ loadSavedTraces: () => [] }));
vi.mock('../services/savedRoutesSync', () => ({ syncSavedRoutes: () => h.pending() }));
vi.mock('../services/enc/cloudCellSync', () => ({ registerCloudCells: () => Promise.resolve() }));

import { useTracerSessionEffects } from '../components/map/useTracerSessionEffects';

function open(setSavedTraces: (t: never) => void) {
    return renderHook(() =>
        useTracerSessionEffects({
            coordCaptureMode: true,
            embedded: false,
            pickerMode: false,
            isPinView: false,
            setDepartureMs: vi.fn(),
            coordCaptureRef: { current: false },
            setPlotArmed: vi.fn(),
            setSavedTraces: setSavedTraces as never,
        }),
    );
}

describe('tracer bootstrap saved-routes merge', () => {
    it('adopts the merge while the same account is still signed in', async () => {
        h.reset();
        const writes: unknown[] = [];
        open((t) => writes.push(t));
        h.land([{ id: 'route-1' }]);
        await waitFor(() => expect(writes.some((w) => Array.isArray(w) && w.length === 1)).toBe(true));
    });

    it('drops a merge that lands after the account has changed', async () => {
        h.reset();
        const writes: unknown[] = [];
        open((t) => writes.push(t));

        // Sign out (or switch accounts) with the merge still in flight.
        h.signOut();
        h.land([{ id: 'previous-accounts-route' }]);

        // Give the promise chain every chance to land before asserting it did not.
        await new Promise((r) => setTimeout(r, 20));
        const merged = writes.filter((w) => Array.isArray(w) && w.length > 0);
        expect(merged).toEqual([]);
    });
});
