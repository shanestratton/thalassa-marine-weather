/**
 * The open layer menu rolls itself up after a spell without a touch.
 *
 * Shane 2026-09-08: "can we auto fold up the layer fab after say 10 seconds,
 * or 5 seconds of no use." Eight. Any touch inside the menu restarts the
 * clock, and folding does not steal focus.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELM_IDLE_FOLD_MS, RadialHelmMenu } from '../components/map/RadialHelmMenu';
import type { WeatherLayer } from '../components/map/mapConstants';

vi.mock('../components/map/cmemsFeatureAvailability', () => ({
    isCmemsProductLayer: (layer: WeatherLayer) => ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'].includes(layer),
    isCmemsLayerAvailable: (layer: WeatherLayer) => ['currents', 'sst', 'chl'].includes(layer),
}));

describe('the layer menu folds itself up when idle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const open = () => {
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                tacticalState={{ onOpenMob: vi.fn(), onToggleLightning: vi.fn() }}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();
    };

    it('folds after the idle window, not before', () => {
        open();
        act(() => vi.advanceTimersByTime(HELM_IDLE_FOLD_MS - 1_500));
        expect(screen.queryByRole('menu')).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(2_500));
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open layer menu' })).toBeInTheDocument();
    });

    it('a touch inside the menu restarts the clock', () => {
        open();
        act(() => vi.advanceTimersByTime(HELM_IDLE_FOLD_MS - 1_500));
        fireEvent.pointerMove(screen.getByRole('menu'));
        act(() => vi.advanceTimersByTime(HELM_IDLE_FOLD_MS - 1_500));
        expect(screen.queryByRole('menu')).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(2_500));
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('is a short spell, in the range Shane named', () => {
        expect(HELM_IDLE_FOLD_MS).toBeGreaterThanOrEqual(5_000);
        expect(HELM_IDLE_FOLD_MS).toBeLessThanOrEqual(10_000);
    });
});
