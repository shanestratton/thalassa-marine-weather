import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useMapHubLayerVisibility } from '../components/map/useMapHubLayerVisibility';
import { buildTacticalState } from '../components/map/buildTacticalState';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import ObsCreditsRollup from '../components/map/ObsCreditsRollup';
import { SAT_IR_FULL_COVERAGE } from '../components/map/satelliteImagery';
import type { WeatherLayer } from '../components/map/mapConstants';
vi.mock('../components/map/useActiveCyclones', () => ({ useActiveCyclones: () => ({ cyclones: [] }) }));
vi.mock('../services/MobService', () => ({ MobService: { isActive: () => false, subscribe: () => () => {} } }));
afterEach(cleanup);
it('keeps all four optional layers default-OFF and pauses their browse state on planning surfaces', () => {
    const h = renderHook(
        ({ planningSurface }) => useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface }),
        { initialProps: { planningSurface: false } },
    );
    expect([
        h.result.current.facilitiesVisible,
        h.result.current.communityNotesVisible,
        h.result.current.receiverCoverageVisible,
        h.result.current.boatPresenceVisible,
        h.result.current.boatPresenceControlsOpen,
    ]).toEqual([false, false, false, false, false]);
    act(() => {
        h.result.current.setFacilitiesVisible(true);
        h.result.current.setCommunityNotesVisible(true);
        h.result.current.setReceiverCoverageVisible(true);
        h.result.current.setBoatPresenceVisible(true);
    });
    expect([
        h.result.current.browseFacilitiesVisible,
        h.result.current.browseCommunityNotesVisible,
        h.result.current.browseReceiverCoverageVisible,
        h.result.current.browseBoatPresenceVisible,
    ]).toEqual([true, true, true, true]);
    h.rerender({ planningSurface: true });
    expect([
        h.result.current.browseFacilitiesVisible,
        h.result.current.browseCommunityNotesVisible,
        h.result.current.browseReceiverCoverageVisible,
        h.result.current.browseBoatPresenceVisible,
    ]).toEqual([false, false, false, false]);
});
it('composes the real builder/menu once per layer and clears all four without opening privacy or reusing AIS consent', async () => {
    const opens = vi.fn(),
        weatherToggle = vi.fn();
    function Menu() {
        const layers = useMapHubLayerVisibility({ mapRef: { current: null }, planningSurface: false });
        const state = buildTacticalState({
            ...layers,
            weatherInspectMode: false,
            setWeatherInspectMode: vi.fn(),
            setPage: vi.fn(),
            setBoatPresenceControlsOpen: (v) => {
                opens();
                layers.setBoatPresenceControlsOpen(v);
            },
            weather: {
                setActiveLayer: vi.fn(),
                activeLayers: new Set<WeatherLayer>(),
                toggleLayer: vi.fn(),
                mpaVisible: false,
                setMpaVisible: vi.fn(),
            },
        });
        return (
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={weatherToggle}
                selectInGroup={vi.fn()}
                tacticalState={state}
            />
        );
    }
    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Sea layers$/ }));
    for (const label of ['Facilities', 'Community notes']) {
        const item = screen.getAllByRole('menuitemcheckbox', { name: `${label}, off` });
        expect(item).toHaveLength(1);
        fireEvent.click(item[0]);
    }
    fireEvent.click(screen.getByRole('menuitem', { name: /^Live layers$/ }));
    expect(screen.getAllByRole('menuitemcheckbox', { name: 'Thalassa boats, off' })).toHaveLength(1);
    expect(screen.getAllByRole('menuitemcheckbox', { name: /Who.s listening, off/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Thalassa boats, off' }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Who.s listening, off/ })).toHaveAttribute(
        'aria-checked',
        'false',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'AIS, off' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Who.s listening, off/ }));
    expect(screen.getByRole('menuitem', { name: 'Clear all · 4 active' })).toBeInTheDocument();
    expect(opens).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all · 4 active' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Thalassa boats, off' })).toHaveAttribute(
        'aria-checked',
        'false',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: /Who.s listening, off/ })).toHaveAttribute(
        'aria-checked',
        'false',
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /^Sea layers$/ }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Facilities, off' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Community notes, off' })).toHaveAttribute(
        'aria-checked',
        'false',
    );
    expect(weatherToggle).toHaveBeenCalledOnce();
    expect(weatherToggle).toHaveBeenCalledWith('none');
    expect(opens).not.toHaveBeenCalled();
});
it('retains all three new source notices inside one existing credits row', () => {
    const props = {
        rain: null,
        wind: null,
        cmems: [],
        lightning: false,
        ais: false,
        onToggleSatellite: () => {},
        satellite: {
            status: 'off' as const,
            frameTimeMs: null,
            frameCount: 0,
            coverage: SAT_IR_FULL_COVERAGE,
            playing: false,
            following: false,
        },
    };
    render(
        <ObsCreditsRollup
            {...props}
            facilities={{ state: 'unavailable', count: 0, partial: true, cachedOnly: false }}
            boatPresence={{ active: true, publishing: false, text: 'Viewing only; position not shared' }}
            receiverCoverage={{ state: 'held', partial: false, cells: 0, asOf: null }}
        />,
    );
    expect(screen.getAllByTestId('obs-credits-rollup')).toHaveLength(1);
    expect(within(screen.getByTestId('obs-credits-rollup')).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Credits; layer status needs review' }));
    expect(screen.getAllByRole('region', { name: 'Facilities source' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Thalassa boats source' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Receiver coverage source' })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Thalassa boats source' })).toHaveTextContent('0.05° cells');
    expect(screen.getByRole('region', { name: 'Receiver coverage source' })).toHaveTextContent('Fixed 2° cells');
});
