import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkModeStore } from '../../stores/networkModeStore';

describe('networkModeStore', () => {
    beforeEach(() => {
        useNetworkModeStore.setState({
            mode: 'standard',
            isSatelliteMode: false,
            maxSatelliteAreaDeg2: 400,
        });
    });

    describe('setMode', () => {
        it('sets standard mode', () => {
            useNetworkModeStore.getState().setMode('standard');
            expect(useNetworkModeStore.getState().mode).toBe('standard');
            expect(useNetworkModeStore.getState().isSatelliteMode).toBe(false);
        });

        it('sets satellite mode', () => {
            useNetworkModeStore.getState().setMode('satellite');
            expect(useNetworkModeStore.getState().mode).toBe('satellite');
            expect(useNetworkModeStore.getState().isSatelliteMode).toBe(true);
        });
    });

    describe('toggleMode', () => {
        it('toggles from standard to satellite', () => {
            useNetworkModeStore.getState().toggleMode();
            expect(useNetworkModeStore.getState().mode).toBe('satellite');
            expect(useNetworkModeStore.getState().isSatelliteMode).toBe(true);
        });

        it('toggles from satellite back to standard', () => {
            useNetworkModeStore.getState().setMode('satellite');
            useNetworkModeStore.getState().toggleMode();
            expect(useNetworkModeStore.getState().mode).toBe('standard');
            expect(useNetworkModeStore.getState().isSatelliteMode).toBe(false);
        });

        it('toggles twice returns to original', () => {
            useNetworkModeStore.getState().toggleMode();
            useNetworkModeStore.getState().toggleMode();
            expect(useNetworkModeStore.getState().mode).toBe('standard');
        });
    });

    describe('defaults', () => {
        it('starts in standard mode', () => {
            expect(useNetworkModeStore.getState().mode).toBe('standard');
        });

        it('starts with satellite mode false', () => {
            expect(useNetworkModeStore.getState().isSatelliteMode).toBe(false);
        });

        it('has max satellite area of 400 deg²', () => {
            expect(useNetworkModeStore.getState().maxSatelliteAreaDeg2).toBe(400);
        });
    });
});
