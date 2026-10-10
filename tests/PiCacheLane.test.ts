/**
 * piCache.lane: which way the app reaches the Pi right now (127-C-c).
 *
 * Licensed chart bytes may travel the boat's LAN only, so the chart code asks
 * the transport owner for its lane instead of reading the host ladder itself
 * (tests/BoatLinkPlaceWordsGuard: where the phone is belongs to boatLink).
 * The lane must agree with viaRemoteAccess and the live base in every state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { piCache } from '../services/PiCacheService';

interface Internals {
    _useRemote: boolean;
    status: { reachable: boolean };
}
const internals = piCache as unknown as Internals;
const saved = { useRemote: internals._useRemote, reachable: internals.status.reachable };

afterEach(() => {
    internals._useRemote = saved.useRemote;
    internals.status.reachable = saved.reachable;
});

describe('piCache.lane', () => {
    it('is null while the Pi is unreachable, whichever host was last used', () => {
        for (const useRemote of [false, true]) {
            internals._useRemote = useRemote;
            internals.status.reachable = false;
            expect(piCache.lane).toBeNull();
        }
    });

    it("is 'lan' on the boat's Wi-Fi and 'tailnet' once the health check turns to remote access", () => {
        internals.status.reachable = true;
        internals._useRemote = false;
        expect(piCache.lane).toBe('lan');
        expect(piCache.viaRemoteAccess).toBe(false);
        internals._useRemote = true;
        expect(piCache.lane).toBe('tailnet');
        expect(piCache.viaRemoteAccess).toBe(true);
    });
});
