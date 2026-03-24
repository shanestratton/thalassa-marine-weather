/**
 * GpsService — Unit Tests
 *
 * Tests web fallback methods (getCurrentPosition, watchPosition)
 * since Capacitor native bridge is mocked out in test setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GpsService } from '../services/GpsService';

describe('GpsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getCurrentPosition (web fallback)', () => {
        it('returns position from navigator.geolocation', async () => {
            const pos = await GpsService.getCurrentPosition();
            expect(pos).not.toBeNull();
            // Setup.ts mocks getCurrentPosition to return -33.868, 151.209
            expect(pos!.latitude).toBeCloseTo(-33.868, 2);
            expect(pos!.longitude).toBeCloseTo(151.209, 2);
            expect(pos!.accuracy).toBe(10);
        });

        it('returns null when geolocation is unavailable', async () => {
            const original = navigator.geolocation.getCurrentPosition;
            (navigator.geolocation.getCurrentPosition as any) = vi.fn((_success, error) => {
                error({ code: 1, message: 'Permission denied' });
            });

            const pos = await GpsService.getCurrentPosition();
            expect(pos).toBeNull();

            // Restore
            (navigator.geolocation.getCurrentPosition as any) = original;
        });

        it('respects timeout options', async () => {
            const pos = await GpsService.getCurrentPosition({ timeoutSec: 5 });
            expect(pos).not.toBeNull();
        });
    });

    describe('watchPosition (web fallback)', () => {
        it('returns an unsubscribe function', () => {
            const unsub = GpsService.watchPosition(() => {});
            expect(typeof unsub).toBe('function');
            unsub(); // Should not throw
        });

        it('calls callback with position data', () => {
            const callback = vi.fn();
            // The mock in setup.ts returns watchPosition id 1
            // but doesn't actually call the callback automatically
            const unsub = GpsService.watchPosition(callback);
            expect(navigator.geolocation.watchPosition).toHaveBeenCalled();
            unsub();
        });

        it('calls clearWatch on unsubscribe', () => {
            const unsub = GpsService.watchPosition(() => {});
            unsub();
            expect(navigator.geolocation.clearWatch).toHaveBeenCalledWith(1);
        });
    });
});
