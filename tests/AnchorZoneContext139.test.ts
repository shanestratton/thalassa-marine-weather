import { beforeEach, describe, expect, it, vi } from 'vitest';
const vessel = vi.hoisted(() => {
    let state: { activeVesselId: string | null | undefined } = { activeVesselId: 'a' };
    const listeners = new Set<(next: typeof state, previous: typeof state) => void>();
    return {
        getState: () => state,
        subscribe: (fn: (next: typeof state, previous: typeof state) => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        set: (id: string | null | undefined) => {
            const previous = state;
            state = { activeVesselId: id };
            for (const listener of listeners) listener(state, previous);
        },
    };
});
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: vessel }));
import { anchorSafeZoneContextKey } from '../services/anchorSafeZoneContext';
import { setAuthIdentityScope } from '../services/authIdentityScope';
beforeEach(() => {
    setAuthIdentityScope('a');
    vessel.set('a');
});
describe('manual anchor-area edit context', () => {
    it('retires original account and vessel A/B/A leases synchronously', () => {
        const first = anchorSafeZoneContextKey();
        setAuthIdentityScope('b');
        setAuthIdentityScope('a');
        expect(anchorSafeZoneContextKey()).not.toBe(first);
        const second = anchorSafeZoneContextKey();
        vessel.set('b');
        vessel.set('a');
        expect(anchorSafeZoneContextKey()).not.toBe(second);
    });
    it('treats missing and null vessel ids as the same empty selection', () => {
        vessel.set(null);
        const first = anchorSafeZoneContextKey();
        vessel.set(undefined);
        expect(anchorSafeZoneContextKey()).toBe(first);
    });
});
