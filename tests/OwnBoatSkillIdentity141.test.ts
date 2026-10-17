import { afterEach, describe, expect, it } from 'vitest';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    OWN_BOAT_SKILL_CAPABILITY_KEY,
    setAuthIdentityScope,
} from '../services/authIdentityScope';
afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});
describe('unmounted private scorecard capability retirement', () => {
    it('clears only the previous owner capability through A/B/A, without loading Pi services', () => {
        const a = setAuthIdentityScope('owner-a');
        const aKey = authScopedStorageKey(OWN_BOAT_SKILL_CAPABILITY_KEY, a);
        const other = authScopedStorageKey('unrelated-private-data', a);
        localStorage.setItem(aKey, 'synthetic-capability');
        localStorage.setItem(other, 'retained');
        const b = setAuthIdentityScope('owner-b');
        expect(localStorage.getItem(aKey)).toBeNull();
        expect(localStorage.getItem(other)).toBe('retained');
        const bKey = authScopedStorageKey(OWN_BOAT_SKILL_CAPABILITY_KEY, b);
        localStorage.setItem(bKey, 'synthetic-other-capability');
        setAuthIdentityScope('owner-a');
        expect(localStorage.getItem(bKey)).toBeNull();
        expect(localStorage.getItem(aKey)).toBeNull();
    });
    it('preserves the same authenticated owner on a normal cold-start confirmation, then removes on logout', () => {
        const a = setAuthIdentityScope('owner-a');
        const key = authScopedStorageKey(OWN_BOAT_SKILL_CAPABILITY_KEY, a);
        localStorage.setItem(key, 'synthetic-capability');
        setAuthIdentityScope('owner-a');
        expect(getAuthIdentityScope()).toBe(a);
        expect(localStorage.getItem(key)).toBe('synthetic-capability');
        setAuthIdentityScope(null);
        expect(localStorage.getItem(key)).toBeNull();
    });
});
