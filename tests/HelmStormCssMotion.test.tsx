/**
 * The layer menu and the storm picker animate with CSS, not framer-motion
 * (build 126 bundle diet: framer-motion, motion-dom and motion-utils were
 * about 126 KB of the app's JavaScript for these two components alone).
 *
 * What must hold, motion or no motion:
 *   - the same entrances: tiles pop in one after another, the layer grid and
 *     the storm picker settle in, the scrim fades;
 *   - closing plays a short exit, and what is leaving is already out of the
 *     accessibility tree and takes no taps;
 *   - a skipper who asks the phone for reduced motion gets no movement at
 *     all: things appear and go at once, and the pulses hold still.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
import { StormPicker } from '../components/map/StormPicker';
import type { WeatherLayer } from '../components/map/mapConstants';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

vi.mock('../components/map/cmemsFeatureAvailability', () => ({
    isCmemsProductLayer: (layer: WeatherLayer) => ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'].includes(layer),
    isCmemsLayerAvailable: (layer: WeatherLayer) => ['currents', 'sst', 'chl'].includes(layer),
}));

const originalMatchMedia = window.matchMedia;

/** The phone's reduced-motion setting, as matchMedia reports it. */
function setReducedMotion(reduce: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: reduce && query.includes('prefers-reduced-motion: reduce'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
});
afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
});

function renderHelm(tactical: React.ComponentProps<typeof RadialHelmMenu>['tacticalState'] = {}) {
    return render(
        <RadialHelmMenu
            activeLayers={new Set<WeatherLayer>(['wind'])}
            toggleLayer={vi.fn()}
            selectInGroup={vi.fn()}
            tacticalState={{ onToggleLightning: vi.fn(), ...tactical }}
        />,
    );
}

const tiles = () => Array.from(document.querySelectorAll<HTMLElement>('[data-helm-category]'));
const scrim = () => document.querySelector<SVGElement>('[data-helm-scrim]');

describe('layer menu: CSS entrances in place of framer-motion', () => {
    it('pops the category tiles in one after another and fades the scrim in', () => {
        renderHelm();
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));

        const open = tiles();
        expect(open.length).toBeGreaterThan(1);
        open.forEach((tile, i) => {
            expect(tile).toHaveClass('helm-tile-in');
            expect(tile.style.getPropertyValue('--helm-i')).toBe(String(i));
        });
        expect(scrim()).toHaveClass('helm-scrim-in');
    });

    it('settles the layer grid in and pops each layer in turn', () => {
        renderHelm();
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Sky layers' }));

        expect(screen.getByRole('menu', { name: 'Sky layers' })).toHaveClass('helm-grid-in');
        screen.getAllByRole('menuitemcheckbox').forEach((item, i) => {
            expect(item).toHaveClass('helm-item-in');
            expect(item.style.getPropertyValue('--helm-i')).toBe(String(i));
        });
    });

    it('plays a short exit that is already out of the way, then leaves', () => {
        renderHelm();
        const fab = screen.getByRole('button', { name: 'Open layer menu' });
        fireEvent.click(fab);
        fireEvent.click(screen.getByRole('button', { name: 'Close layer menu' }));

        // Still painted for the exit, but gone for assistive tech and taps.
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
        const leaving = tiles();
        expect(leaving.length).toBeGreaterThan(0);
        for (const tile of leaving) {
            expect(tile).toHaveClass('helm-tile-out');
            expect(tile).toHaveAttribute('aria-hidden', 'true');
            expect(tile).toHaveAttribute('tabindex', '-1');
        }
        expect(scrim()).toHaveClass('helm-scrim-out');

        act(() => vi.advanceTimersByTime(1_000));
        expect(tiles()).toHaveLength(0);
        expect(scrim()).toBeNull();
    });

    it('reopening during the exit brings the same tiles straight back', () => {
        renderHelm();
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close layer menu' }));
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));

        expect(screen.getByRole('menu', { name: 'Map overlay categories' })).toBeInTheDocument();
        for (const tile of tiles()) {
            expect(tile).toHaveClass('helm-tile-in');
            expect(tile).not.toHaveAttribute('aria-hidden');
        }
        act(() => vi.advanceTimersByTime(1_000));
        expect(screen.getByRole('menu', { name: 'Map overlay categories' })).toBeInTheDocument();
    });

    it('with reduced motion, closing removes everything at once', () => {
        setReducedMotion(true);
        renderHelm();
        fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Sky layers' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close layer menu' }));

        expect(tiles()).toHaveLength(0);
        expect(scrim()).toBeNull();
        expect(document.querySelector('[data-helm-item]')).toBeNull();
    });

    it('pulses an active MOB with a CSS animation, not a script', () => {
        renderHelm({ onOpenMob: vi.fn(), mobActive: true });
        expect(screen.getByRole('button', { name: 'MOB active, open Man Overboard emergency' })).toHaveClass(
            'helm-mob-pulse',
        );
    });
});

const cyclone: ActiveCyclone = {
    sid: 'WP182026',
    name: 'Typhoon Mawar',
    basin: 'WP',
    category: 4,
    categoryLabel: '4',
    currentPosition: { lat: 14.1, lon: 141.2, time: '2026-10-09T00:00:00Z', windKts: 120, pressureMb: 940 },
    track: [],
    forecastTrack: [],
    maxWindKts: 120,
    minPressureMb: 940,
    nature: 'TY',
};

function pickerProps(visible: boolean) {
    return {
        visible,
        cyclones: [cyclone],
        userLat: 13.44,
        userLon: 144.79,
        onSelect: vi.fn(),
        onClose: vi.fn(),
    };
}

describe('storm picker: CSS entrance and exit', () => {
    it('fades the backdrop and settles the dialog in', () => {
        render(<StormPicker {...pickerProps(true)} />);
        const dialog = screen.getByRole('dialog', { name: 'Active Cyclones' });
        expect(dialog).toHaveClass('storm-picker-dialog-in');
        expect(dialog.parentElement).toHaveClass('storm-picker-backdrop-in');
    });

    it('closes with a short exit that takes no taps, then unmounts', () => {
        const { rerender } = render(<StormPicker {...pickerProps(true)} />);
        rerender(<StormPicker {...pickerProps(false)} />);

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const backdrop = document.querySelector('.storm-picker-backdrop-out');
        expect(backdrop).not.toBeNull();
        expect(backdrop).toHaveAttribute('aria-hidden', 'true');

        act(() => vi.advanceTimersByTime(1_000));
        expect(document.querySelector('.storm-picker-backdrop-out')).toBeNull();
        expect(screen.queryByText('Active Cyclones')).toBeNull();
    });

    it('with reduced motion, closing unmounts at once', () => {
        setReducedMotion(true);
        const { rerender } = render(<StormPicker {...pickerProps(true)} />);
        rerender(<StormPicker {...pickerProps(false)} />);
        expect(screen.queryByText('Active Cyclones')).toBeNull();
    });
});

describe('the CSS honours reduced motion', () => {
    // Next to the two components, which import it: the chart's lazy CSS,
    // not the boot stylesheet.
    const css = readFileSync(join(process.cwd(), 'components/map/helmMotion.css'), 'utf8');
    const CLASSES = [
        'helm-scrim-in',
        'helm-scrim-out',
        'helm-tile-in',
        'helm-tile-out',
        'helm-grid-in',
        'helm-grid-out',
        'helm-item-in',
        'helm-pill-in',
        'helm-pill-out',
        'helm-glow-pulse',
        'helm-dot-pulse',
        'helm-mob-pulse',
        'storm-picker-backdrop-in',
        'storm-picker-backdrop-out',
        'storm-picker-dialog-in',
        'storm-picker-dialog-out',
    ];

    it('ships with the two components, not in the boot stylesheet', () => {
        const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
        expect(read('components/map/RadialHelmMenu.tsx')).toMatch(/^import '\.\/helmMotion\.css';$/m);
        expect(read('components/map/StormPicker.tsx')).toMatch(/^import '\.\/helmMotion\.css';$/m);
        expect(read('index.css')).not.toMatch(/\.(helm|storm-picker)-[a-z-]+-(in|out|pulse)\b|@keyframes helm-/);
    });

    it.each(CLASSES)('.%s is animated, and switched off under prefers-reduced-motion', (name) => {
        expect(css).toMatch(new RegExp(`\\.${name}\\s*[,{]`));
        const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(
            (m) => m[1],
        );
        expect(reduced.some((block) => new RegExp(`\\.${name}\\b[\\s\\S]*?animation: none`).test(block))).toBe(true);
    });
});
