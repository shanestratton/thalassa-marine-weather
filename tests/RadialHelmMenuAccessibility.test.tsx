import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import type { WeatherLayer } from '../components/map/mapConstants';

// Keep this accessibility suite focused on the two-tier keyboard contract.
// Production feature ownership is covered separately by the committed public-
// beta profile tests; a clean CI checkout intentionally has no local `.env`.
vi.mock('../components/map/cmemsFeatureAvailability', () => ({
    isCmemsProductLayer: (layer: WeatherLayer) => ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'].includes(layer),
    isCmemsLayerAvailable: (layer: WeatherLayer) => ['currents', 'sst', 'chl'].includes(layer),
}));

describe('RadialHelmMenu accessibility', () => {
    it('keeps a one-tap MOB emergency entry visible without opening the layer menu', () => {
        const onOpenMob = vi.fn();
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                tacticalState={{ onOpenMob }}
            />,
        );

        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Open Man Overboard emergency' }));
        expect(onOpenMob).toHaveBeenCalledOnce();
    });

    it('makes an active MOB state explicit on the direct chart entry', () => {
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                tacticalState={{ mobActive: true, onOpenMob: vi.fn() }}
            />,
        );

        expect(screen.getByRole('button', { name: 'Open active Man Overboard emergency' })).toBeInTheDocument();
    });

    it('navigates both menu tiers and restores the helm trigger', async () => {
        render(<RadialHelmMenu activeLayers={new Set<WeatherLayer>()} toggleLayer={vi.fn()} selectInGroup={vi.fn()} />);

        const trigger = screen.getByRole('button', { name: 'Open layer menu' });
        trigger.focus();
        fireEvent.click(trigger);

        expect(screen.getByRole('menu', { name: 'Map overlay categories' })).toBeInTheDocument();
        const sea = screen.getByRole('menuitem', { name: 'Sea layers' });
        const sky = screen.getByRole('menuitem', { name: 'Sky layers' });
        await waitFor(() => expect(sea).toHaveFocus());

        fireEvent.keyDown(sea, { key: 'ArrowDown' });
        expect(sky).toHaveFocus();
        fireEvent.click(sky);

        expect(screen.getByRole('menu', { name: 'Sky layers' })).toBeInTheDocument();
        const firstLayer = screen.getAllByRole('menuitemcheckbox')[0];
        await waitFor(() => expect(firstLayer).toHaveFocus());
        expect(firstLayer).toHaveAttribute('aria-checked', 'false');

        fireEvent.keyDown(firstLayer, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('menu', { name: 'Sky layers' })).not.toBeInTheDocument());
        await waitFor(() => expect(sky).toHaveFocus());

        fireEvent.keyDown(sky, { key: 'Escape' });
        await waitFor(() =>
            expect(screen.queryByRole('menu', { name: 'Map overlay categories' })).not.toBeInTheDocument(),
        );
        expect(trigger).toHaveFocus();
    });

    it('closes and restores focus after a keyboard user selects a layer', async () => {
        const selectInGroup = vi.fn();
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={selectInGroup}
            />,
        );

        const trigger = screen.getByRole('button', { name: 'Open layer menu' });
        trigger.focus();
        fireEvent.click(trigger);
        const sea = screen.getByRole('menuitem', { name: 'Sea layers' });
        await waitFor(() => expect(sea).toHaveFocus());
        fireEvent.click(sea);

        const firstLayer = screen.getAllByRole('menuitemcheckbox')[0];
        await waitFor(() => expect(firstLayer).toHaveFocus());
        fireEvent.click(firstLayer);

        expect(selectInGroup).toHaveBeenCalledOnce();
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
        expect(trigger).toHaveFocus();
    });

    it('names a routes-and-tracks-only category honestly', async () => {
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                chartsState={{
                    sources: [
                        { id: 'routes', label: 'Routes', iconKind: 'generic', enabled: false, onToggle: vi.fn() },
                        { id: 'tracks', label: 'Tracks', iconKind: 'generic', enabled: false, onToggle: vi.fn() },
                    ],
                }}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        const routes = screen.getByRole('menuitem', { name: 'Routes overlays' });
        expect(screen.queryByRole('menuitem', { name: 'Charts sources' })).not.toBeInTheDocument();
        fireEvent.click(routes);

        expect(screen.getByRole('menu', { name: 'Routes overlays' })).toHaveTextContent('2 overlays');
        expect(screen.getByRole('menuitemcheckbox', { name: 'Routes, off' })).toBeInTheDocument();
        expect(screen.getByRole('menuitemcheckbox', { name: 'Tracks, off' })).toBeInTheDocument();
    });

    it('exposes a neutral MPA toggle in the mixed map-items category', () => {
        const onToggleMpa = vi.fn();
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                chartsState={{
                    sources: [
                        { id: 'mpa', label: 'MPAs', iconKind: 'generic', enabled: false, onToggle: onToggleMpa },
                        { id: 'routes', label: 'Routes', iconKind: 'generic', enabled: false, onToggle: vi.fn() },
                        { id: 'tracks', label: 'Tracks', iconKind: 'generic', enabled: false, onToggle: vi.fn() },
                    ],
                }}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Map items' }));

        expect(screen.getByRole('menu', { name: 'Map items' })).toHaveTextContent('3 items');
        const mpa = screen.getByRole('menuitemcheckbox', { name: 'MPAs, off' });
        expect(screen.getByRole('menuitemcheckbox', { name: 'Routes, off' })).toBeInTheDocument();
        expect(screen.getByRole('menuitemcheckbox', { name: 'Tracks, off' })).toBeInTheDocument();
        fireEvent.click(mpa);

        expect(onToggleMpa).toHaveBeenCalledOnce();
    });

    it('keeps the Charts label when genuine chart sources are present', () => {
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                chartsState={{
                    sources: [{ id: 'sk-au', label: 'o-charts', iconKind: 'avnav', enabled: true, onToggle: vi.fn() }],
                }}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        expect(screen.getByRole('menuitem', { name: 'Charts sources' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Routes overlays' })).not.toBeInTheDocument();
    });
});
