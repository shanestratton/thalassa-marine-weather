import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DESK_MAP_BASE_OPTIONS,
    MAP_BASE_OPTIONS,
    MapBaseSelector,
    mapBaseVisibility,
    type MapBaseKind,
} from '../components/map/MapBaseSelector';
import { useMapBase } from '../components/map/useMapBase';
import { renderHook } from '@testing-library/react';

const triggerHaptic = vi.hoisted(() => vi.fn());
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic,
}));

function Harness({
    encCellCount = 9,
    onToggleEnc = vi.fn(),
    initial = 'relief',
}: {
    encCellCount?: number;
    onToggleEnc?: () => void;
    initial?: MapBaseKind;
}) {
    const [base, setBase] = useState<MapBaseKind>(initial);
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
    // Shane 2026-10-09: "remove the old satellite map". Hybrid (imagery with
    // roads and names) stays; the old stitched Satellite base is gone.
    it('offers Relief first, then Relief + Sat, Ocean and Hybrid, then the ENC row: no Satellite', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Relief' }));
        const menu = screen.getByRole('menu', { name: 'Map base' });
        const items = Array.from(menu.querySelectorAll('[role^="menuitem"]'));
        expect(items.map((item) => item.querySelector('.font-black')?.textContent)).toEqual([
            'Relief',
            'Relief + Sat',
            'Ocean',
            'Hybrid',
            'ENC charts',
        ]);
        expect(items[0]).toHaveAttribute('aria-checked', 'true');
        expect(items[4]).toHaveAttribute('role', 'menuitemcheckbox');
        expect(MAP_BASE_OPTIONS.map((option) => option.id)).not.toContain('satellite');
        expect(screen.queryByRole('menuitemradio', { name: /^Satellite / })).not.toBeInTheDocument();
    });

    it('keeps the labels short enough for the top-centre pill and every description to one plain line', () => {
        for (const option of MAP_BASE_OPTIONS) {
            expect(option.label.length).toBeLessThanOrEqual(12);
            expect(option.description.length).toBeLessThanOrEqual(34);
            expect(option.description).not.toMatch(/bathymetr|raster|GEBCO|vector/i);
        }
    });

    it('makes every base an explicit reachable choice', () => {
        render(<Harness />);

        // No beta wording on the chart at all (Shane 2026-08-06).
        expect(screen.queryByText(/beta/i)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Map base: Relief' }).parentElement).toHaveClass('z-700');
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Relief' }));
        expect(screen.getByRole('button', { name: 'Map base: Relief' }).parentElement).toHaveClass('z-9998');
        expect(screen.getByRole('menu', { name: 'Map base' })).not.toHaveTextContent('Visual background only');

        for (const option of MAP_BASE_OPTIONS) {
            const trigger = screen.queryByRole('menu', { name: 'Map base' })
                ? null
                : screen.getByRole('button', { name: /^Map base:/ });
            if (trigger) fireEvent.click(trigger);
            fireEvent.click(screen.getByRole('menuitemradio', { name: `${option.label} ${option.description}` }));
            expect(screen.getByRole('button', { name: `Map base: ${option.label}` })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: `Map base: ${option.label}` }).parentElement).toHaveClass(
                'z-700',
            );
        }
        expect(triggerHaptic).toHaveBeenCalled();
    });

    it('maps every choice onto its layer groups, imagery bases exclusive', () => {
        expect(mapBaseVisibility('relief')).toEqual({
            relief: true,
            landImagery: false,
            ocean: false,
            satellite: false,
            hybrid: false,
        });
        expect(mapBaseVisibility('reliefSat')).toEqual({
            relief: true,
            landImagery: true,
            ocean: false,
            satellite: false,
            hybrid: false,
        });
        expect(mapBaseVisibility('ocean')).toEqual({
            relief: false,
            landImagery: false,
            ocean: true,
            satellite: false,
            hybrid: false,
        });
        expect(mapBaseVisibility('satellite')).toEqual({
            relief: false,
            landImagery: false,
            ocean: false,
            satellite: true,
            hybrid: false,
        });
        expect(mapBaseVisibility('hybrid')).toEqual({
            relief: false,
            landImagery: false,
            ocean: false,
            satellite: false,
            hybrid: true,
        });
    });

    it('closes with Escape and restores focus to its trigger', () => {
        render(<Harness initial="hybrid" />);
        const trigger = screen.getByRole('button', { name: 'Map base: Hybrid' });
        fireEvent.click(trigger);
        fireEvent.keyDown(screen.getByRole('menuitemradio', { name: /Hybrid Imagery with roads and names/ }), {
            key: 'Escape',
        });

        expect(screen.queryByRole('menu', { name: 'Map base' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});

/**
 * The desk planner's menu (127-DESKMAP A2/B1): the same pill, its own bases
 * (Light, Relief + Sat, Hybrid), no ENC row, then the Seamarks switch.
 */
function DeskHarness({ onSeamarks = vi.fn() }: { onSeamarks?: () => void }) {
    const [base, setBase] = useState<MapBaseKind>('light');
    const [seamarks, setSeamarks] = useState(true);
    return (
        <MapBaseSelector
            visible
            value={base}
            onChange={setBase}
            options={DESK_MAP_BASE_OPTIONS}
            encRow={false}
            toggles={[
                {
                    id: 'seamarks',
                    label: 'Seamarks',
                    detail: 'OpenSeaMap community data, not verified',
                    on: seamarks,
                    onToggle: () => {
                        onSeamarks();
                        setSeamarks((on) => !on);
                    },
                },
            ]}
            encCellCount={3}
            encVisible={false}
            onToggleEnc={vi.fn()}
        />
    );
}

describe('MapBaseSelector on the desk', () => {
    it('lists Light, Relief + Sat and Hybrid, no ENC row, then Seamarks ON', () => {
        render(<DeskHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Light' }));
        const menu = screen.getByRole('menu', { name: 'Map base' });
        const items = Array.from(menu.querySelectorAll('[role^="menuitem"]'));
        expect(items.map((item) => item.querySelector('.font-black')?.textContent)).toEqual([
            'Light',
            'Relief + Sat',
            'Hybrid',
            'Seamarks',
        ]);
        expect(DESK_MAP_BASE_OPTIONS.map((o) => o.id)).toEqual(['light', 'reliefSat', 'hybrid']);
        expect(DESK_MAP_BASE_OPTIONS[0].description).toBe('Easiest to read · seabed is a guide, mean sea level');
        expect(screen.queryByText('ENC charts')).not.toBeInTheDocument();
        const seamarks = screen.getByRole('menuitemcheckbox', { name: /^Seamarks/ });
        expect(seamarks).toHaveAttribute('aria-checked', 'true');
        expect(seamarks).toHaveTextContent('OpenSeaMap community data, not verified');
        expect(seamarks).toHaveTextContent('ON');
    });

    it('reaches every row with the arrow keys, the switch included', () => {
        render(<DeskHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Light' }));
        const light = screen.getByRole('menuitemradio', { name: /^Light / });
        expect(light).toHaveFocus();
        const seen: string[] = [];
        for (let i = 0; i < 4; i++) {
            fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
            seen.push((document.activeElement as HTMLElement).querySelector('.font-black')?.textContent ?? '');
        }
        expect(seen).toEqual(['Relief + Sat', 'Hybrid', 'Seamarks', 'Light']);
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
        expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: /^Seamarks/ }));
    });

    it('a switch flips, closes the menu and hands focus back to the trigger, as the ENC row does', () => {
        const onSeamarks = vi.fn();
        render(<DeskHarness onSeamarks={onSeamarks} />);
        const trigger = screen.getByRole('button', { name: 'Map base: Light' });
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /^Seamarks/ }));
        expect(onSeamarks).toHaveBeenCalledOnce();
        expect(triggerHaptic).toHaveBeenCalledWith('light');
        expect(screen.queryByRole('menu', { name: 'Map base' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        fireEvent.click(trigger);
        const off = screen.getByRole('menuitemcheckbox', { name: /^Seamarks/ });
        expect(off).toHaveAttribute('aria-checked', 'false');
        expect(off).toHaveTextContent('OFF');
    });

    it('picks a base by its own row', () => {
        render(<DeskHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Light' }));
        fireEvent.click(screen.getByRole('menuitemradio', { name: /^Hybrid / }));
        expect(screen.getByRole('button', { name: 'Map base: Hybrid' })).toBeInTheDocument();
    });
});

describe('the Obs picker is unchanged (127-DESKMAP)', () => {
    it('four bases, the ENC row, no switches', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Map base: Relief' }));
        const menu = screen.getByRole('menu', { name: 'Map base' });
        expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
        expect(menu.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(1);
        expect(MAP_BASE_OPTIONS.map((o) => o.id)).toEqual(['relief', 'reliefSat', 'ocean', 'hybrid']);
        expect(MAP_BASE_OPTIONS.map((o) => o.id)).not.toContain('light');
    });

    it('does not accept a saved Light as the account’s Obs base', () => {
        const { result } = renderHook(() => useMapBase('light'));
        expect(result.current.mapBase).not.toBe('light');
        expect(result.current.explicit).toBe(false);
    });

    it('lights the relief group for Light, never imagery', () => {
        expect(mapBaseVisibility('light')).toEqual({
            relief: true,
            landImagery: false,
            ocean: false,
            satellite: false,
            hybrid: false,
        });
    });
});
