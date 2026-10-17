import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMapHubLayerVisibility } from '../components/map/useMapHubLayerVisibility';
import { buildTacticalState } from '../components/map/buildTacticalState';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
vi.mock('../components/map/useActiveCyclones', () => ({ useActiveCyclones: () => ({ cyclones: [] }) }));
vi.mock('../services/MobService', () => ({ MobService: { isActive: () => false, subscribe: () => () => {} } }));
afterEach(cleanup);
it('starts satellite wind off, lazy-loads after opt-in and pauses browse state on Plan', () => {
    const h = renderHook(({ plan }) => useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface: plan }), {
        initialProps: { plan: false },
    });
    expect(h.result.current.ascatVisible).toBe(false);
    expect(h.result.current.ascatLoaded).toBe(false);
    act(() => h.result.current.setAscatVisible(true));
    expect(h.result.current.browseAscatVisible).toBe(true);
    expect(h.result.current.ascatLoaded).toBe(true);
    h.rerender({ plan: true });
    expect(h.result.current.browseAscatVisible).toBe(false);
    act(() => h.result.current.setAscatVisible(false));
    expect(h.result.current.ascatLoaded).toBe(true);
});
it('offers one independent Sky toggle and counts/clears it exactly once', async () => {
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sky layers' }));
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Satellite wind, off' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Satellite wind, off' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Satellite wind, on' })).toHaveAttribute(
        'aria-checked',
        'true',
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all · 1 active' }));
    await waitFor(() =>
        expect(screen.getByRole('menuitemcheckbox', { name: 'Satellite wind, off' })).toHaveAttribute(
            'aria-checked',
            'false',
        ),
    );
    expect(toggle).toHaveBeenCalledExactlyOnceWith('none');
});
