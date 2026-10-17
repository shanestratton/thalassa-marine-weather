import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useSatellitePictureSelection } from '../components/map/useSatellitePictureSelection';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import { buildTacticalState, type BuildTacticalStateDeps } from '../components/map/buildTacticalState';
import type { WeatherLayer } from '../components/map/mapConstants';
afterEach(cleanup);

function useSelection(admitted = true, initiallyHourly = false) {
    const [hourly, setHourly] = React.useState(initiallyHourly);
    const toggle = React.useCallback(() => setHourly((value) => !value), []);
    return { ...useSatellitePictureSelection(admitted, hourly, toggle), hourly, setHourly };
}
it('starts off, refuses admission when false and does not reactivate on remount', () => {
    const h = renderHook(({ admitted }) => useSelection(admitted), { initialProps: { admitted: false } });
    act(() => h.result.current.toggleSharper());
    expect(h.result.current.sharperVisible).toBe(false);
    h.rerender({ admitted: true });
    expect(h.result.current.sharperVisible).toBe(false);
    act(() => h.result.current.toggleSharper());
    expect(h.result.current.sharperVisible).toBe(true);
    h.unmount();
    expect(renderHook(() => useSelection()).result.current.sharperVisible).toBe(false);
});
it('switches the real controlled hourly selection off for sharper and back on for explicit fallback', () => {
    const h = renderHook(() => useSelection(true, true));
    act(() => h.result.current.toggleSharper());
    expect([h.result.current.hourly, h.result.current.sharperVisible]).toEqual([false, true]);
    act(() => h.result.current.useHourly());
    expect([h.result.current.hourly, h.result.current.sharperVisible]).toEqual([true, false]);
    act(() => h.result.current.useHourly());
    expect(h.result.current.hourly).toBe(true);
});
it('honours non-menu hourly activation and never resurrects sharper when that layer later stops', () => {
    const h = renderHook(() => useSelection());
    act(() => h.result.current.toggleSharper());
    act(() => h.result.current.setHourly(true));
    expect([h.result.current.hourly, h.result.current.sharperVisible]).toEqual([true, false]);
    act(() => h.result.current.setHourly(false));
    expect(h.result.current.sharperVisible).toBe(false);
});
it.each(['satIR', 'none'] as const)('retires sharper for the existing %s weather action', (layer) => {
    const h = renderHook(() => useSelection());
    act(() => h.result.current.toggleSharper());
    act(() => h.result.current.weatherAction(layer));
    expect(h.result.current.sharperVisible).toBe(false);
});

function dependencies(): BuildTacticalStateDeps {
    return {
        aisVisible: false,
        setAisVisible: vi.fn(),
        cycloneVisible: false,
        setCycloneVisible: vi.fn(),
        squallVisible: false,
        setSquallVisible: vi.fn(),
        allCyclones: [],
        cyclonePickerPendingRef: { current: false },
        setStormPickerOpen: vi.fn(),
        setChokepointVisible: vi.fn(),
        seamarkVisible: false,
        setSeamarkVisible: vi.fn(),
        tideStationsVisible: false,
        setTideStationsVisible: vi.fn(),
        anchorageVisible: false,
        setAnchorageVisible: vi.fn(),
        lightningVisible: false,
        setLightningVisible: vi.fn(),
        weatherInspectMode: false,
        setWeatherInspectMode: vi.fn(),
        weather: {
            setActiveLayer: vi.fn(),
            activeLayers: new Set<WeatherLayer>(),
            toggleLayer: vi.fn(),
            mpaVisible: false,
            setMpaVisible: vi.fn(),
        },
        mobActive: false,
        setPage: vi.fn(),
    };
}
it('the actual builder/menu has one sharper action, one count and one clear alongside the original hourly item', async () => {
    const action = vi.fn(),
        weatherAction = vi.fn();
    function Menu() {
        const selection = useSelection();
        const state = buildTacticalState({
            ...dependencies(),
            sharperSatelliteVisible: selection.sharperVisible,
            onToggleSharperSatellite: () => {
                action();
                selection.toggleSharper();
            },
        });
        return (
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={(layer) => {
                    weatherAction(layer);
                    selection.weatherAction(layer);
                }}
                selectInGroup={vi.fn()}
                tacticalState={state}
            />
        );
    }
    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sky layers' }));
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Sat cloud, off' })).toHaveLength(1);
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Sharper sat, off' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sharper sat, off' }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Sharper sat, on' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all · 1 active' }));
    expect(action).toHaveBeenCalledTimes(2);
    expect(weatherAction).toHaveBeenCalledExactlyOnceWith('none');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Sharper sat, off' })).toHaveAttribute('aria-checked', 'false');
});
it('does not expose an unavailable sharper menu action while the original hourly satellite remains accessible', async () => {
    render(
        <RadialHelmMenu
            activeLayers={new Set()}
            toggleLayer={vi.fn()}
            selectInGroup={vi.fn()}
            tacticalState={buildTacticalState(dependencies())}
        />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sky layers' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: /Sharper sat/ })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Sat cloud, off' })).toBeInTheDocument();
});
