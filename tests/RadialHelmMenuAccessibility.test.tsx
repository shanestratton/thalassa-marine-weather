import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import type { WeatherLayer } from '../components/map/mapConstants';

describe('RadialHelmMenu accessibility', () => {
    it('navigates both menu tiers and restores the helm trigger', async () => {
        render(<RadialHelmMenu activeLayers={new Set<WeatherLayer>()} toggleLayer={vi.fn()} selectInGroup={vi.fn()} />);

        const trigger = screen.getByRole('button', { name: 'Open layer menu' });
        trigger.focus();
        fireEvent.click(trigger);

        expect(screen.getByRole('menu', { name: 'Chart layer categories' })).toBeInTheDocument();
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
            expect(screen.queryByRole('menu', { name: 'Chart layer categories' })).not.toBeInTheDocument(),
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
});
