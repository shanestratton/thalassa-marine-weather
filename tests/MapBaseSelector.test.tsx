import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapBaseSelector, mapBaseVisibility, type MapBaseKind } from '../components/map/MapBaseSelector';

const triggerHaptic = vi.hoisted(() => vi.fn());
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic,
}));

function Harness({ encCellCount = 9, onToggleEnc = vi.fn() }: { encCellCount?: number; onToggleEnc?: () => void }) {
    const [base, setBase] = useState<MapBaseKind>('hybrid');
    const [enc, setEnc] = useState(true);
    return (
        <MapBaseSelector
            visible
            value={base}
            onChange={setBase}
            encCellCount={encCellCount}
            encVisible={enc}
            onToggleEnc={() => {
                onToggleEnc();
                setEnc((on) => !on);
            }}
        />
    );
}

beforeEach(() => triggerHaptic.mockClear());

describe('MapBaseSelector', () => {
    it('makes Hybrid, Satellite, and Ocean explicit reachable choices', () => {
        render(<Harness />);

        // No beta wording on the chart at all (Shane 2026-08-06).
        expect(screen.queryByText(/beta/i)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Hybrid' }));
        // The "Visual background only — ENC safety layers stay above it."
        // header is gone (Shane 2026-09-05). The ENC row below says the same
        // thing by being switchable, which is more use than a caption.
        expect(screen.getByRole('menu', { name: 'Map base' })).not.toHaveTextContent('Visual background only');
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Satellite Clean aerial imagery/ }));
        expect(screen.getByRole('button', { name: 'Map base: Satellite' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Map base: Satellite' }));
        fireEvent.click(screen.getByRole('menuitemradio', { name: /Ocean Bathymetry background/ }));
        expect(screen.getByRole('button', { name: 'Map base: Ocean' })).toBeInTheDocument();
        expect(triggerHaptic).toHaveBeenCalled();
    });

    it('maps every choice to exactly one raster base', () => {
        expect(mapBaseVisibility('hybrid')).toEqual({ hybrid: true, satellite: false, ocean: false });
        expect(mapBaseVisibility('satellite')).toEqual({ hybrid: false, satellite: true, ocean: false });
        expect(mapBaseVisibility('ocean')).toEqual({ hybrid: false, satellite: false, ocean: true });
    });

    it('closes with Escape and restores focus to its trigger', () => {
        render(<Harness />);
        const trigger = screen.getByRole('button', { name: 'Map base: Hybrid' });
        fireEvent.click(trigger);
        fireEvent.keyDown(screen.getByRole('menuitemradio', { name: /Hybrid Imagery with place names/ }), {
            key: 'Escape',
        });

        expect(screen.queryByRole('menu', { name: 'Map base' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
