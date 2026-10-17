import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMapHubLayerVisibility } from '../components/map/useMapHubLayerVisibility';
import { buildTacticalState } from '../components/map/buildTacticalState';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
vi.mock('../components/map/useActiveCyclones', () => ({ useActiveCyclones: () => ({ cyclones: [] }) }));
vi.mock('../services/MobService', () => ({ MobService: { isActive: () => false, subscribe: () => () => {} } }));
afterEach(cleanup);
it('starts measured seas off, loads once after opt-in, and pauses browse state on Plan', () => {
    const h = renderHook(({ plan }) => useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface: plan }), {
        initialProps: { plan: false },
    });
    expect(h.result.current.measuredBuoysVisible).toBe(false);
    expect(h.result.current.measuredBuoysLoaded).toBe(false);
    act(() => h.result.current.setMeasuredBuoysVisible(true));
    expect(h.result.current.browseMeasuredBuoysVisible).toBe(true);
    expect(h.result.current.measuredBuoysLoaded).toBe(true);
    h.rerender({ plan: true });
    expect(h.result.current.browseMeasuredBuoysVisible).toBe(false);
    h.rerender({ plan: false });
    expect(h.result.current.browseMeasuredBuoysVisible).toBe(true);
    act(() => h.result.current.setMeasuredBuoysVisible(false));
    expect(h.result.current.measuredBuoysLoaded).toBe(true);
});
it('offers one independent sea toggle, counts once and clears once without a camera or privacy action', async () => {
    const toggle = vi.fn();
    function Menu() {
        const layers = useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface: false });
        const tacticalState = buildTacticalState({
            ...layers,
            weatherInspectMode: false,
            setWeatherInspectMode: vi.fn(),
            setPage: vi.fn(),
            weather: {
                activeLayers: new Set(),
                setActiveLayer: vi.fn(),
                toggleLayer: vi.fn(),
                mpaVisible: false,
                setMpaVisible: vi.fn(),
            },
        });
        return (
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={toggle}
                selectInGroup={vi.fn()}
                tacticalState={tacticalState}
            />
        );
    }
    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sea layers' }));
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Measured seas, off' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Measured seas, off' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Measured seas, on' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all · 1 active' }));
    await waitFor(() =>
        expect(screen.getByRole('menuitemcheckbox', { name: 'Measured seas, off' })).toHaveAttribute(
            'aria-checked',
            'false',
        ),
    );
    expect(toggle).toHaveBeenCalledExactlyOnceWith('none');
});
