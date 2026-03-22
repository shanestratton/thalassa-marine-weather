/**
 * system — Unit tests for system utilities.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@capacitor/haptics', () => ({
    Haptics: { impact: vi.fn() },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));

import { triggerHaptic, getSystemUnits } from './system';

describe('triggerHaptic', () => {
    it('does not throw on web platform', async () => {
        await expect(triggerHaptic()).resolves.not.toThrow();
    });

    it('accepts style parameter', async () => {
        await expect(triggerHaptic('light')).resolves.not.toThrow();
        await expect(triggerHaptic('medium')).resolves.not.toThrow();
        await expect(triggerHaptic('heavy')).resolves.not.toThrow();
    });
});

describe('getSystemUnits', () => {
    it('returns a unit preferences object', () => {
        const units = getSystemUnits();
        expect(units).toBeDefined();
        expect(typeof units).toBe('object');
    });
});
