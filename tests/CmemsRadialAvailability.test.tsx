import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeatherLayer } from '../components/map/mapConstants';

const availability = vi.hoisted(() => ({
    flags: {
        currents: false,
        waves: false,
        sst: false,
        chl: false,
        seaice: false,
        mld: false,
    } as Record<string, boolean>,
}));

vi.mock('../components/map/cmemsFeatureAvailability', () => ({
    isCmemsProductLayer: (layer: string) => ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'].includes(layer),
    isCmemsLayerAvailable: (layer: string) =>
        availability.flags[layer] === true && !['waves', 'seaice', 'mld'].includes(layer),
}));

import { RadialHelmMenu } from '../components/map/RadialHelmMenu';

function openSeaMenu() {
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sea layers' }));
}

describe('CMEMS radial availability', () => {
    beforeEach(() => {
        for (const layer of Object.keys(availability.flags)) availability.flags[layer] = false;
    });

    it('never exposes any product whose exact flag is false', () => {
        const view = render(
            <RadialHelmMenu activeLayers={new Set<WeatherLayer>()} toggleLayer={vi.fn()} selectInGroup={vi.fn()} />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        expect(screen.queryByRole('menuitem', { name: 'Sea layers' })).not.toBeInTheDocument();
        expect(screen.queryAllByRole('menuitemcheckbox')).toHaveLength(0);

        view.unmount();
        availability.flags.currents = true;
        availability.flags.sst = true;
        availability.flags.chl = true;
        // Even a true internal flag does not unpark Shane's deferred products.
        availability.flags.waves = true;
        availability.flags.seaice = true;
        availability.flags.mld = true;
        render(<RadialHelmMenu activeLayers={new Set<WeatherLayer>()} toggleLayer={vi.fn()} selectInGroup={vi.fn()} />);
        openSeaMenu();

        expect(screen.getByRole('menuitemcheckbox', { name: 'Currents, off' })).toBeInTheDocument();
        expect(screen.getByRole('menuitemcheckbox', { name: 'SST, off' })).toBeInTheDocument();
        expect(screen.getByRole('menuitemcheckbox', { name: 'Chlorophyll, off' })).toBeInTheDocument();
        for (const label of ['Waves', 'Sea Ice', 'MLD']) {
            expect(screen.queryByRole('menuitemcheckbox', { name: `${label}, off` })).not.toBeInTheDocument();
        }
    });
});
