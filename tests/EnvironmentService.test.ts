/**
 * EnvironmentService — land/water detection tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Must import AFTER mock setup — constructor reads localStorage
let EnvironmentService: typeof import('../services/EnvironmentService').EnvironmentService;

describe('EnvironmentService', () => {
    beforeEach(async () => {
        localStorage.clear();
        vi.resetModules();
        const mod = await import('../services/EnvironmentService');
        EnvironmentService = mod.EnvironmentService;
    });

    describe('getState', () => {
        it('defaults to offshore', () => {
            const state = EnvironmentService.getState();
            expect(state.current).toBe('offshore');
            expect(state.detected).toBe('offshore');
            expect(state.mode).toBe('auto');
        });
    });

    describe('setMode', () => {
        it('manual onshore overrides detection', () => {
            EnvironmentService.setMode('onshore');
            expect(EnvironmentService.getState().current).toBe('onshore');
            expect(EnvironmentService.getState().mode).toBe('onshore');
        });

        it('manual offshore overrides detection', () => {
            EnvironmentService.setMode('offshore');
            expect(EnvironmentService.getState().current).toBe('offshore');
        });

        it('auto mode follows detection', () => {
            EnvironmentService.setMode('onshore');
            expect(EnvironmentService.getState().current).toBe('onshore');
            EnvironmentService.setMode('auto');
            // Should go back to detected (offshore by default)
            expect(EnvironmentService.getState().current).toBe('offshore');
        });
    });

    describe('onStateChange', () => {
        it('calls listener immediately with current state', () => {
            const cb = vi.fn();
            EnvironmentService.onStateChange(cb);
            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb.mock.calls[0][0].current).toBe('offshore');
        });

        it('unsubscribe stops updates', () => {
            const cb = vi.fn();
            const unsub = EnvironmentService.onStateChange(cb);
            unsub();
            EnvironmentService.setMode('onshore');
            // Should only have the initial call
            expect(cb).toHaveBeenCalledTimes(1);
        });
    });

    describe('updateWaterStatus', () => {
        it('detects offshore when on water', () => {
            // Need 2 confirmations (DEBOUNCE_CONFIRMATIONS = 2)
            EnvironmentService.updateWaterStatus(true);
            EnvironmentService.updateWaterStatus(true);
            expect(EnvironmentService.getState().detected).toBe('offshore');
            expect(EnvironmentService.getState().source).toBe('water_api');
        });

        it('detects onshore when on land', () => {
            EnvironmentService.updateWaterStatus(false);
            EnvironmentService.updateWaterStatus(false);
            expect(EnvironmentService.getState().detected).toBe('onshore');
        });
    });

    describe('updateFromWeatherData', () => {
        it('inland locationType → onshore', () => {
            EnvironmentService.updateFromWeatherData({ locationType: 'inland' });
            EnvironmentService.updateFromWeatherData({ locationType: 'inland' });
            expect(EnvironmentService.getState().detected).toBe('onshore');
            expect(EnvironmentService.getState().source).toBe('weather_type');
        });

        it('offshore locationType → offshore', () => {
            // First set to onshore to see a change
            EnvironmentService.setMode('auto');
            EnvironmentService.updateFromWeatherData({ locationType: 'offshore' });
            EnvironmentService.updateFromWeatherData({ locationType: 'offshore' });
            expect(EnvironmentService.getState().detected).toBe('offshore');
        });

        it('coastal + landlocked → onshore', () => {
            EnvironmentService.updateFromWeatherData({ locationType: 'coastal', isLandlocked: true });
            EnvironmentService.updateFromWeatherData({ locationType: 'coastal', isLandlocked: true });
            expect(EnvironmentService.getState().detected).toBe('onshore');
        });

        it('coastal + not landlocked → offshore', () => {
            EnvironmentService.updateFromWeatherData({ locationType: 'coastal', isLandlocked: false });
            // This matches current default (offshore), so it takes effect immediately
            expect(EnvironmentService.getState().detected).toBe('offshore');
        });

        it('elevation > 10m → onshore', () => {
            EnvironmentService.updateFromWeatherData({ elevation: 50 });
            EnvironmentService.updateFromWeatherData({ elevation: 50 });
            expect(EnvironmentService.getState().detected).toBe('onshore');
        });

        it('no useful data does not change state', () => {
            const before = EnvironmentService.getState();
            EnvironmentService.updateFromWeatherData({});
            expect(EnvironmentService.getState()).toEqual(before);
        });
    });

    describe('updateFromGPS', () => {
        it('high altitude → onshore', () => {
            EnvironmentService.updateFromGPS({ altitude: 50 });
            EnvironmentService.updateFromGPS({ altitude: 50 });
            expect(EnvironmentService.getState().detected).toBe('onshore');
        });

        it('low altitude → offshore', () => {
            EnvironmentService.updateFromGPS({ altitude: 2 });
            // Default is already offshore, so matches immediately
            expect(EnvironmentService.getState().detected).toBe('offshore');
        });

        it('ambiguous altitude (5-10m) does not change state', () => {
            EnvironmentService.updateFromGPS({ altitude: 7 });
            expect(EnvironmentService.getState().source).not.toBe('elevation');
        });
    });

    describe('persistence', () => {
        it('persists mode to localStorage', () => {
            EnvironmentService.setMode('onshore');
            const raw = localStorage.getItem('thalassa_environment');
            expect(raw).not.toBeNull();
            const parsed = JSON.parse(raw!);
            expect(parsed.mode).toBe('onshore');
        });
    });
});
