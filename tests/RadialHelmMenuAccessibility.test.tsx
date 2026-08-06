import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

    it('does NOT duplicate MOB inside the layer menu', async () => {
        // Removed 2026-08-07 (Shane: "it already has a dedicated button on the
        // obs page"). The always-visible button above is the emergency
        // affordance; a second copy two taps deep added no reachability and
        // risked a skipper hunting the wrong one. Everything else in this fan
        // is a layer toggle — MOB was the only navigation action among them.
        const onOpenMob = vi.fn();
        render(
            <RadialHelmMenu
                activeLayers={new Set<WeatherLayer>()}
                toggleLayer={vi.fn()}
                selectInGroup={vi.fn()}
                tacticalState={{ onOpenMob, onToggleLightning: vi.fn() }}
            />,
        );

        // Drill into the Tactical category — MOB lived in that SUBMENU, not
        // the top tier. Asserting against tier 1 would pass trivially even
        // with MOB restored, which is exactly what an unverified regression
        // test looks like.
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Tactical/i }));
        const tacticalMenu = await screen.findByRole('menu', { name: /Tactical/i });
        expect(within(tacticalMenu).queryByText('MOB')).not.toBeInTheDocument();
        // The dedicated button must still be there, and still work.
        fireEvent.click(screen.getByRole('button', { name: 'Open Man Overboard emergency' }));
        expect(onOpenMob).toHaveBeenCalledOnce();
    });

    it('centres the MOB fab between the status and layer fabs on any device', () => {
        // The "i" fab sits at env(safe-area-inset-top) + 8px while this menu is
        // anchored at a fixed top-[192px], so the midpoint between them MOVES
        // with the notch. A constant offset (the old -top-16) could only be
        // right on one device class. Halving the inset keeps the two gaps
        // within half a pixel of each other for every value of the inset:
        //   gap above = 92.5 - inset/2, gap below = 92 - inset/2
        // Asserted against SOURCE, not the DOM: jsdom's CSSOM cannot parse
        // env() and silently drops the whole declaration, so `style.top` reads
        // back empty and a DOM assertion here would be checking nothing.
        const source = readFileSync(join(process.cwd(), 'components/map/RadialHelmMenu.tsx'), 'utf8');
        const mobButton = source.slice(source.indexOf("'Open Man Overboard emergency'"));
        expect(mobButton).toContain("top: 'calc(env(safe-area-inset-top) / 2 - 95px)'");
        // A constant Tailwind offset on THIS button would silently un-centre
        // it again. Scoped to its className, since sibling markup legitimately
        // uses -top-* for badge positioning.
        const className = mobButton.slice(mobButton.indexOf('className={`absolute'), mobButton.indexOf('animate='));
        expect(className).not.toMatch(/-top-\d/);
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
