/**
 * GpsService — Unit Tests
 *
 * Tests web fallback methods (getCurrentPosition, watchPosition)
 * since Capacitor native bridge is mocked out in test setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canUseForegroundHighAccuracy, GpsService } from '../services/GpsService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { __resetPhoneLastFixForTests, storedPhoneFix } from '../services/phoneLastFix';

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
            expect(vi.mocked(navigator.geolocation.getCurrentPosition).mock.calls.at(-1)?.[2]?.timeout).toBe(5_000);
        });

        it('passes the caller freshness bound to the web geolocation provider', async () => {
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 1_234 });

            expect(pos).not.toBeNull();
            expect(vi.mocked(navigator.geolocation.getCurrentPosition).mock.calls.at(-1)?.[2]?.maximumAge).toBe(1_234);
        });

        it('rejects a web fix that was already older than the caller freshness bound', async () => {
            const staleTimestamp = Date.now() - 60_000;
            vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementationOnce((success) => {
                success({
                    coords: {
                        latitude: -27.4,
                        longitude: 153.1,
                        accuracy: 8,
                        altitude: null,
                        altitudeAccuracy: null,
                        heading: null,
                        speed: null,
                        toJSON: () => ({}),
                    },
                    timestamp: staleTimestamp,
                    toJSON: () => ({}),
                });
            });

            await expect(GpsService.getCurrentPosition({ staleLimitMs: 15_000 })).resolves.toBeNull();
        });

        it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
            'fails closed without calling geolocation for invalid staleLimitMs %s',
            async (staleLimitMs) => {
                await expect(GpsService.getCurrentPosition({ staleLimitMs })).resolves.toBeNull();
                expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
            },
        );

        it('accepts a newly acquired web fix when maximumAge is zero', async () => {
            vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementationOnce((success) => {
                success({
                    coords: {
                        latitude: -27.4,
                        longitude: 153.1,
                        accuracy: 8,
                        altitude: null,
                        altitudeAccuracy: null,
                        heading: null,
                        speed: null,
                        toJSON: () => ({}),
                    },
                    timestamp: Date.now(),
                    toJSON: () => ({}),
                });
            });

            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 0 });
            expect(pos?.latitude).toBe(-27.4);
            expect(vi.mocked(navigator.geolocation.getCurrentPosition).mock.calls.at(-1)?.[2]?.maximumAge).toBe(0);
        });

        it('keeps passive weather location silent when browser permission is not already granted', async () => {
            const originalPermissions = navigator.permissions;
            Object.defineProperty(navigator, 'permissions', {
                configurable: true,
                value: { query: vi.fn(async () => ({ state: 'prompt' })) },
            });

            try {
                await expect(GpsService.getCurrentPositionIfGranted()).resolves.toBeNull();
                expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
            } finally {
                Object.defineProperty(navigator, 'permissions', {
                    configurable: true,
                    value: originalPermissions,
                });
            }
        });

        it('allows passive weather location after browser permission was already granted', async () => {
            const originalPermissions = navigator.permissions;
            Object.defineProperty(navigator, 'permissions', {
                configurable: true,
                value: { query: vi.fn(async () => ({ state: 'granted' })) },
            });

            try {
                const pos = await GpsService.getCurrentPositionIfGranted({ staleLimitMs: 30_000 });
                expect(pos?.latitude).toBeCloseTo(-33.868, 2);
                expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledOnce();
            } finally {
                Object.defineProperty(navigator, 'permissions', {
                    configurable: true,
                    value: originalPermissions,
                });
            }
        });
    });

    describe('foreground permission policy', () => {
        it('never upgrades an Android approximate-only grant into a precise-location request', () => {
            expect(canUseForegroundHighAccuracy({ location: 'prompt', coarseLocation: 'granted' }, true)).toBe(false);
            expect(canUseForegroundHighAccuracy({ location: 'denied', coarseLocation: 'granted' }, true)).toBe(false);
        });

        it('uses high accuracy only when precise location is already granted and requested', () => {
            expect(canUseForegroundHighAccuracy({ location: 'granted', coarseLocation: 'granted' }, true)).toBe(true);
            expect(canUseForegroundHighAccuracy({ location: 'granted', coarseLocation: 'granted' }, false)).toBe(false);
        });
    });

    describe('watchPosition (web fallback)', () => {
        it('returns an unsubscribe function', () => {
            const unsub = GpsService.watchPosition(() => {});
            expect(typeof unsub).toBe('function');
            unsub(); // Should not throw
        });

        it('keeps a passive watch silent while browser permission is not already granted', async () => {
            const originalPermissions = navigator.permissions;
            Object.defineProperty(navigator, 'permissions', {
                configurable: true,
                value: { query: vi.fn(async () => ({ state: 'prompt' })) },
            });

            try {
                const unsub = GpsService.watchPosition(() => {});
                await vi.waitFor(() => expect(navigator.permissions.query).toHaveBeenCalledOnce());
                expect(navigator.geolocation.watchPosition).not.toHaveBeenCalled();
                unsub();
            } finally {
                Object.defineProperty(navigator, 'permissions', {
                    configurable: true,
                    value: originalPermissions,
                });
            }
        });

        it('starts a passive watch after browser permission was already granted', async () => {
            const originalPermissions = navigator.permissions;
            Object.defineProperty(navigator, 'permissions', {
                configurable: true,
                value: { query: vi.fn(async () => ({ state: 'granted' })) },
            });
            const callback = vi.fn();

            try {
                const unsub = GpsService.watchPosition(callback);
                await vi.waitFor(() => expect(navigator.geolocation.watchPosition).toHaveBeenCalledOnce());
                unsub();
            } finally {
                Object.defineProperty(navigator, 'permissions', {
                    configurable: true,
                    value: originalPermissions,
                });
            }
        });

        it('clears an already-granted passive watch on unsubscribe', async () => {
            const originalPermissions = navigator.permissions;
            Object.defineProperty(navigator, 'permissions', {
                configurable: true,
                value: { query: vi.fn(async () => ({ state: 'granted' })) },
            });

            try {
                const unsub = GpsService.watchPosition(() => {});
                await vi.waitFor(() => expect(navigator.geolocation.watchPosition).toHaveBeenCalledOnce());
                unsub();
                expect(navigator.geolocation.clearWatch).toHaveBeenCalledWith(1);
            } finally {
                Object.defineProperty(navigator, 'permissions', {
                    configurable: true,
                    value: originalPermissions,
                });
            }
        });
    });

    /**
     * Obs (Shane 2026-10-06: "If there is no gps from their phone then the
     * last known location with a clear message telling them that"): the
     * permission only chooses the message's words, and a watched fix is kept
     * for the launch that has none.
     */
    describe('for Obs: the permission, read silently, and the phone’s last fix', () => {
        async function withPermissions(permissions: unknown, run: () => Promise<void>) {
            const originalPermissions = navigator.permissions;
            Object.defineProperty(navigator, 'permissions', { configurable: true, value: permissions });
            try {
                await run();
            } finally {
                Object.defineProperty(navigator, 'permissions', { configurable: true, value: originalPermissions });
            }
        }

        it.each(['granted', 'denied', 'prompt'] as const)('reads %s without asking for anything', async (state) => {
            await withPermissions({ query: vi.fn(async () => ({ state })) }, async () => {
                await expect(GpsService.locationPermission()).resolves.toBe(state);
                expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
                expect(navigator.geolocation.watchPosition).not.toHaveBeenCalled();
            });
        });

        it('is unknown where the browser will not say, and never throws', async () => {
            await withPermissions(undefined, async () => {
                await expect(GpsService.locationPermission()).resolves.toBe('unknown');
            });
            await withPermissions(
                {
                    query: vi.fn(async () => {
                        throw new Error('unsupported');
                    }),
                },
                async () => {
                    await expect(GpsService.locationPermission()).resolves.toBe('unknown');
                },
            );
            expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
        });

        it('keeps a watched fix for the next launch, for this account only', async () => {
            localStorage.clear();
            setAuthIdentityScope('owner-ss');
            __resetPhoneLastFixForTests();
            const timestamp = Date.now();
            await withPermissions({ query: vi.fn(async () => ({ state: 'granted' })) }, async () => {
                const callback = vi.fn();
                const unsub = GpsService.watchPosition(callback);
                await vi.waitFor(() => expect(navigator.geolocation.watchPosition).toHaveBeenCalledOnce());
                const deliver = vi.mocked(navigator.geolocation.watchPosition).mock.calls[0][0];
                deliver({
                    coords: {
                        latitude: -27.5,
                        longitude: 153.1,
                        accuracy: 6,
                        altitude: null,
                        altitudeAccuracy: null,
                        heading: null,
                        speed: null,
                    },
                    timestamp,
                } as GeolocationPosition);
                unsub();
                expect(callback).toHaveBeenCalledOnce();
                expect(GpsService.getLastKnownPosition()).toMatchObject({ latitude: -27.5, longitude: 153.1 });
            });
            expect(storedPhoneFix()).toEqual({ lat: -27.5, lon: 153.1, timestamp });
            setAuthIdentityScope('someone-else');
            expect(storedPhoneFix()).toBeNull();
            setAuthIdentityScope(null);
        });
    });
});
