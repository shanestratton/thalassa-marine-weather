import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * getFreshPosition must FAIL CLOSED.
 *
 * Its two fallback paths used to `return this._lastPosition` unconditionally —
 * handing back the very cache the age check had just rejected, with no bound on
 * how old it was. `_lastPosition` is never cleared, only overwritten, so a
 * device that had a fix hours ago and has none now would answer a request for a
 * 15-second position with the hours-old one, and the caller had no way to tell.
 *
 * Where that landed:
 *   - MobService asks with staleLimitMs 15_000 and marks the result as the
 *     man-overboard position. A stale fix sends the search to the wrong water.
 *   - AnchorWatchService asks with 5_000 to SET the anchor — the datum every
 *     subsequent drag alarm is measured against.
 *
 * Both already handle null (MOB refuses and logs; anchor watch throws), so
 * returning null is the safe answer and not a new failure mode.
 */

vi.mock('@transistorsoft/capacitor-background-geolocation', () => ({
    default: {
        getCurrentPosition: vi.fn(async () => {
            throw new Error('no fix');
        }),
    },
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

import { BgGeoManager } from '../services/BgGeoManager';

type Mutable = {
    _lastPosition: { latitude: number; longitude: number; receivedAt: number; timestamp: number } | null;
    isNativeSupported: () => boolean;
};

/** Reach past the public surface — the point is the cache's age, and there is
 *  no public setter for it. */
const mgr = BgGeoManager as unknown as Mutable;

function seedCache(ageMs: number) {
    mgr._lastPosition = {
        latitude: -27.4,
        longitude: 153.1,
        receivedAt: Date.now() - ageMs,
        timestamp: Date.now() - ageMs,
    };
}

describe('getFreshPosition honours its freshness bound on every path', () => {
    beforeEach(() => {
        mgr._lastPosition = null;
        mgr.isNativeSupported = () => false;
    });

    it('returns a cached fix that is inside the bound', async () => {
        seedCache(2_000);
        const pos = await BgGeoManager.getFreshPosition(15_000, 5);
        expect(pos).not.toBeNull();
        expect(pos?.latitude).toBe(-27.4);
    });

    it('returns NULL rather than an out-of-bound cache on the non-native path', async () => {
        // The MOB case: asked for 15s, cache is two hours old.
        seedCache(2 * 60 * 60 * 1000);
        const pos = await BgGeoManager.getFreshPosition(15_000, 5);
        expect(pos).toBeNull();
    });

    it('returns NULL rather than an out-of-bound cache when the platform fetch throws', async () => {
        mgr.isNativeSupported = () => true;
        seedCache(2 * 60 * 60 * 1000);
        const pos = await BgGeoManager.getFreshPosition(15_000, 5);
        expect(pos).toBeNull();
    });

    it('still serves an in-bound cache even when the platform fetch throws', async () => {
        mgr.isNativeSupported = () => true;
        seedCache(1_000);
        const pos = await BgGeoManager.getFreshPosition(15_000, 5);
        expect(pos?.latitude).toBe(-27.4);
    });

    it('respects the tight bound anchor watch uses to set the anchor', async () => {
        // AnchorWatchService asks for 5s. A 30s-old fix is not good enough to
        // become the datum every drag alarm is measured against.
        seedCache(30_000);
        expect(await BgGeoManager.getFreshPosition(5_000, 15)).toBeNull();
        // ...but the same fix satisfies a caller that asked for a minute.
        expect(await BgGeoManager.getFreshPosition(60_000, 15)).not.toBeNull();
    });
});
