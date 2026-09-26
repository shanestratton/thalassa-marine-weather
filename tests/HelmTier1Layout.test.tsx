/**
 * Layer menu tile geometry and FAB state (UX scorecard run 6).
 *
 * The category tiles were 60 px on a circular arc, which left 5–8 px between
 * neighbours on the diagonals; the FAB rotated into a diamond when open; and
 * its corner showed a count that read as unread alerts. These pin the fixes:
 * 64 px tiles at least 10 px apart, clear of the FAB and of the rail column,
 * a square FAB, and the shared corner dot.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RadialHelmMenu } from '../components/map/RadialHelmMenu';
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

function renderMenu(activeLayers = new Set<WeatherLayer>()) {
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
    fireEvent.click(screen.getByRole('button', { name: 'Open layer menu' }));
}

afterEach(() => {
    cleanup();
});

describe('layer menu tiles', () => {
    it('are 64 px, at least 10 px apart, and clear of the FAB and the rail column', () => {
        renderMenu();
        const boxes = tileBoxes();
        expect(boxes).toHaveLength(4);
        for (const box of boxes) {
            expect(box.right - box.left).toBe(64);
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
