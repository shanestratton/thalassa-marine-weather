/**
 * Layer menu tile geometry and FAB state (UX scorecard run 6).
 *
 * The category tiles were 60 px on a circular arc, which left 5–8 px between
 * neighbours on the diagonals; the FAB rotated into a diamond when open; and
 * its corner showed a count that read as unread alerts. These pin the fixes:
 * tiles at least 10 px apart, clear of the FAB and of the rail column, a
 * square FAB, and the shared corner dot. Run 7 widened the tiles to 108 px for
 * a contents caption, and keeps the focus ring for keyboard use only.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RadialHelmMenu, categoryHint } from '../components/map/RadialHelmMenu';
import { CORNER_STATUS_DOT_CLASS } from '../components/map/cornerStatusDot';
import type { WeatherLayer } from '../components/map/mapConstants';

vi.mock('../components/map/cmemsFeatureAvailability', () => ({
    isCmemsProductLayer: (layer: WeatherLayer) => ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld'].includes(layer),
    isCmemsLayerAvailable: (layer: WeatherLayer) => ['currents', 'sst', 'chl'].includes(layer),
}));

type Box = { left: number; right: number; top: number; bottom: number };

/** Tile boxes in the FAB container's coordinates (the container IS the 48 px FAB box). */
function tileBoxes(): Box[] {
    return screen.getAllByRole('menuitem').flatMap((tile) => {
        if (!tile.hasAttribute('data-helm-category')) return [];
        const width = parseFloat(tile.style.width);
        const height = parseFloat(tile.style.height);
        const right = 48 - parseFloat(tile.style.right);
        const top = parseFloat(tile.style.top);
        return [{ left: right - width, right, top, bottom: top + height }];
    });
}

const gap = (a: Box, b: Box) => Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom);

function renderMenu(activeLayers = new Set<WeatherLayer>(), openDetail = 1) {
    render(
        <RadialHelmMenu
            activeLayers={activeLayers}
            toggleLayer={vi.fn()}
            selectInGroup={vi.fn()}
            tacticalState={{ onOpenMob: vi.fn(), onToggleLightning: vi.fn(), onToggleAis: vi.fn() }}
            chartsState={{
                sources: [{ id: 'routes', label: 'Routes', iconKind: 'generic', enabled: false, onToggle: vi.fn() }],
            }}
        />,
    );
    // detail 1: a tap. A keyboard activation of the FAB arrives as detail 0.
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }), { detail: openDetail });
}

afterEach(() => {
    cleanup();
});

describe('layer menu tiles', () => {
    it('are 108 x 64 px, at least 10 px apart, and clear of the FAB and the rail column', () => {
        renderMenu();
        const boxes = tileBoxes();
        expect(boxes).toHaveLength(4);
        for (const box of boxes) {
            // 108 wide since run 7, to carry a contents caption; still 64 tall.
            expect(box.right - box.left).toBe(108);
            expect(box.bottom - box.top).toBe(64);
            // Left of the rail column (MOB above the FAB, vessel search below).
            expect(box.right).toBeLessThanOrEqual(-10);
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                expect(gap(boxes[i], boxes[j]), `tiles ${i} and ${j}`).toBeGreaterThanOrEqual(10);
            }
        }
    });

    it('names the old Tactical category for what it holds', () => {
        renderMenu();
        expect(screen.getByRole('menuitem', { name: 'Live layers' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: /Tactical/i })).not.toBeInTheDocument();
    });

    it('captions each tile with what is inside it (UX scorecard run 7)', () => {
        renderMenu();
        const caption = (name: string) => screen.getByRole('menuitem', { name }).textContent;
        // Lightning + AIS are the Live items this render offers.
        expect(caption('Live layers')).toContain('AIS · lightning');
        expect(caption('Sky layers')).toContain('Wind · rain');
        expect(caption('Routes overlays')).toContain('Routes');
    });

    it('builds captions from the items present, acronyms kept, within one line', () => {
        const item = (id: string, label: string) => ({ id, label, icon: null });
        expect(
            categoryHint({
                id: 'tactical',
                items: [
                    item('lightning', 'Lightning'),
                    item('squall', 'Squall'),
                    item('cyclones', 'Storms'),
                    item('ais', 'AIS'),
                ],
            }),
        ).toBe('Storms · AIS');
        // No tides: the next pair that fits one 12 px line.
        expect(
            categoryHint({
                id: 'sea',
                items: [item('anchorages', 'Anchorages'), item('currents', 'Currents'), item('sst', 'SST')],
            }),
        ).toBe('Currents · SST');
        expect(categoryHint({ id: 'sea', items: [item('tides', 'Tides')] })).toBe('Tides');
        expect(categoryHint({ id: 'charts', items: [] })).toBe('');
    });

    it('shows the focus ring only after a key press, not after a tap', () => {
        renderMenu();
        const live = screen.getByRole('menuitem', { name: 'Live layers' });
        expect(live.className).toContain('focus-visible:outline-none!');
        fireEvent.keyDown(live, { key: 'ArrowRight' });
        const afterKey = screen.getByRole('menuitem', { name: 'Live layers' });
        expect(afterKey.className).toContain('focus-visible:outline-solid!');
        expect(afterKey.className).not.toContain('outline-dashed');
    });

    it('shows the focus ring at once when the FAB is opened from the keyboard', () => {
        renderMenu(new Set<WeatherLayer>(), 0);
        expect(screen.getByRole('menuitem', { name: 'Live layers' }).className).toContain(
            'focus-visible:outline-solid!',
        );
    });

    it('closes when the scrim is tapped (no pointer capture steals the click)', () => {
        renderMenu();
        const scrim = document.querySelector('[data-helm-scrim]');
        expect(scrim).not.toBeNull();
        fireEvent.pointerDown(scrim!, { pointerId: 1 });
        fireEvent.click(scrim!);
        expect(screen.getByRole('button', { name: 'Open layer menu' })).toBeInTheDocument();
    });

    it('cuts the licence credits out of the scrim', () => {
        const credit = document.createElement('div');
        credit.setAttribute('data-map-credit', '');
        credit.getBoundingClientRect = () => ({ left: 100, top: 60, width: 180, height: 28 }) as DOMRect;
        document.body.appendChild(credit);
        try {
            renderMenu();
            const hole = document.querySelector('[data-helm-scrim] mask rect[fill="black"]');
            // Padded 10 px each side, past the soft edge.
            expect(hole?.getAttribute('x')).toBe('90');
            expect(hole?.getAttribute('y')).toBe('50');
            expect(hole?.getAttribute('width')).toBe('200');
            expect(hole?.getAttribute('height')).toBe('48');
        } finally {
            credit.remove();
        }
    });

    it('cuts out a credit that appears while the menu is open', async () => {
        // A layer switched on from the stay-open menu brings its own credit.
        renderMenu();
        expect(document.querySelector('[data-helm-scrim] mask rect[fill="black"]')).toBeNull();
        const credit = document.createElement('div');
        credit.setAttribute('data-map-credit', '');
        credit.getBoundingClientRect = () => ({ left: 40, top: 70, width: 120, height: 20 }) as DOMRect;
        document.body.appendChild(credit);
        try {
            await waitFor(() => {
                const hole = document.querySelector('[data-helm-scrim] mask rect[fill="black"]');
                expect(hole?.getAttribute('x')).toBe('30');
                expect(hole?.getAttribute('y')).toBe('60');
                expect(hole?.getAttribute('width')).toBe('140');
                expect(hole?.getAttribute('height')).toBe('40');
            });
        } finally {
            credit.remove();
        }
    });

    it('marks itself open so the own-ship badge can stand aside', () => {
        renderMenu();
        const fab = screen.getByRole('button', { name: 'Close layer menu' });
        expect(fab.closest('.radial-helm-menu')).toHaveClass('radial-helm-open');
        fireEvent.click(fab);
        expect(fab.closest('.radial-helm-menu')).not.toHaveClass('radial-helm-open');
    });

    it('drops a row in short landscape, where MOB sits beside the FAB', () => {
        const portraitTops = (() => {
            renderMenu();
            const tops = tileBoxes().map((box) => box.top);
            cleanup();
            return tops;
        })();
        const original = window.matchMedia;
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: query.includes('orientation: landscape'),
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
        try {
            renderMenu();
            const landscapeTops = tileBoxes().map((box) => box.top);
            expect(landscapeTops).toEqual(portraitTops.map((top) => top + 74));
            // MOB's landscape band ends 28 px below the FAB centre (52 px down
            // the container); every tile starts clear of it.
            for (const top of landscapeTops) expect(top).toBeGreaterThanOrEqual(52 + 10);
        } finally {
            window.matchMedia = original;
        }
    });
});

describe('layer FAB', () => {
    it('stays square when open and shows the shared dot, not a count', () => {
        renderMenu(new Set<WeatherLayer>(['wind', 'rain']));
        const fab = screen.getByRole('button', { name: 'Close layer menu' });
        expect(fab.style.transform).not.toMatch(/rotate/);
        expect(fab.textContent).toBe('');
        const dot = fab.querySelector('span[aria-hidden="true"].rounded-full');
        expect(dot?.className).toBe(CORNER_STATUS_DOT_CLASS);
    });
});
