/**
 * The chart's orientation control (127-11b): the north arrow on Obs, its
 * chooser card, and the planner's compass rose as a button.
 *
 * Shane 2026-10-10: "oh, um add in the course up and north up etc. that is
 * cool to see as well" and "the desktop experience needs to be 2nd to none".
 * The arrow joins the zoom pair's wrapper and inherits its placement; one tap
 * on a turned chart puts it North up at once, one tap North up opens the
 * card. The choice is kept on this device, apart for Obs and the planner.
 * Positions are fictional (a made-up bay like the Chesapeake, a made-up
 * Solent-like pair of pins).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import type mapboxgl from 'mapbox-gl';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMapboxMap } from './helpers/fakeMapboxGl';
import { registerChartMap } from '../components/map/chartMapRegistry';
import { MapActionFabs } from '../components/map/MapActionFabs';
import { CompassRoseOverlay } from '../components/map/CompassRoseOverlay';
import { publishOwnshipMotion, type OwnshipMotion } from '../components/map/ownshipMotion';
import { chartOrientationView, orientationKey } from '../components/map/chartOrientation';

const BAY = { lat: 38.6, lon: -76.4 };
const metric = (value: number) => ({ value, lastUpdated: Date.now(), freshness: 'live' });
const busHeading = (heading: number): OwnshipMotion => ({
    lane: 'bus',
    lat: BAY.lat,
    lon: BAY.lon,
    at: Date.now(),
    heading: null,
    speed: null,
    instruments: { headingTrue: metric(heading), sog: metric(0) },
    maxAgeMs: 13_000,
});
const phoneAt = (kn: number): OwnshipMotion => ({
    lane: 'phone',
    lat: BAY.lat,
    lon: BAY.lon,
    at: Date.now(),
    heading: 47,
    speed: kn / 1.9438444924,
    instruments: {},
    maxAgeMs: 30_000,
});
const norm = (b: number) => ((b % 360) + 360) % 360;

function obs(active = true) {
    const view = render(
        <div>
            <div data-testid="chart" />
            <MapActionFabs onLocateMe={vi.fn()} onRecenter={vi.fn()} recenterDisabled={false} orientActive={active} />
        </div>,
    );
    const map = new FakeMapboxMap({ container: screen.getByTestId('chart') });
    let release = () => {};
    // Registered after mount, as on device: the parent's map effect runs last.
    act(() => {
        release = registerChartMap(map.container, map as unknown as mapboxgl.Map);
    });
    return { ...view, map, release };
}
const arrow = () => screen.getByRole('button', { name: /^Chart orientation:/ });
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
    localStorage.clear();
    publishOwnshipMotion(null);
});
afterEach(() => {
    cleanup();
    publishOwnshipMotion(null);
    vi.restoreAllMocks();
});

describe('the north arrow on Obs', () => {
    it('rides in the zoom pair’s wrapper: above + on a tall chart, left of + when short, right of + on the middle-left rail', () => {
        const { release } = obs();
        const button = arrow();
        const wrapper = button.closest('.thalassa-map-zoom') as HTMLElement;
        expect(wrapper).not.toBeNull();
        expect(within(wrapper).getByRole('group', { name: 'Map zoom' })).toBeInTheDocument();
        // The pair's own placement, unchanged (UX scorecard run 7).
        expect(wrapper.className).toContain('right-[max(16px,env(safe-area-inset-right))]');
        expect(wrapper.className).toContain('bottom-[calc(242px+env(safe-area-inset-bottom))]');
        expect(wrapper.className).toContain('[@media(orientation:landscape)_and_(max-height:600px)]:top-1/2');
        // Placed beside the pair without moving it (index.css .thalassa-orient-arrow:
        // left of "-", above "+" from 740 px tall, right of "+" on the left rail;
        // e2e/chart-warning.spec.ts measures it against every control).
        const slot = button.parentElement!;
        expect(slot.className).toBe('thalassa-orient-arrow');
        expect(slot.parentElement).toBe(wrapper);
        const css = readFileSync('index.css', 'utf8');
        expect(css).toMatch(
            /\.thalassa-orient-arrow \{\s*position: absolute;\s*bottom: 0;\s*right: calc\(100% \+ 8px\);/,
        );
        expect(css).toMatch(
            /@media \(min-height: 740px\) \{\s*\.thalassa-orient-arrow \{[^}]*bottom: calc\(100% \+ 8px\)/,
        );
        // 48 px like its neighbours, never under 44 (its look is in index.css too).
        expect(css).toMatch(
            /\.thalassa-orient-arrow > button \{[^}]*width: max\(44px, 3rem\);\s*height: max\(44px, 3rem\);/,
        );
        // Its colours stay utility classes, so the themes remap them as the rail's.
        expect(button.className).toContain('bg-slate-900/90');
        release();
    });

    it('North up: "N UP", in words, and one tap opens the card with four rows that say what each needs', () => {
        const { release } = obs();
        expect(arrow()).toHaveAccessibleName('Chart orientation: North up. Tap to choose');
        expect(arrow()).toHaveTextContent('N UP');
        fireEvent.click(arrow());
        const card = screen.getByRole('dialog', { name: 'Chart orientation' });
        const rows = within(card).getAllByRole('radio');
        expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual([
            'North up',
            'Course up',
            'Track up',
            'Heading up',
        ]);
        expect(rows[0]).toHaveAttribute('aria-checked', 'true');
        expect(rows[0]).toHaveTextContent('North at the top, like a paper chart');
        expect(rows[1]).toHaveTextContent('Needs a route on the chart and her position');
        expect(rows[2]).toHaveTextContent('Waits until she is making 1.5 kn');
        expect(rows[3]).toHaveTextContent('Needs a true heading from her compass');
        // Each row is a big target (56 px, index.css; measured in e2e/chart-warning.spec.ts).
        for (const row of rows) expect(row.className).toContain('thalassa-orient-row');
        expect(readFileSync('index.css', 'utf8')).toMatch(/\.thalassa-orient-row \{[^}]*min-height: 3\.5rem;/);
        release();
    });

    it('a pick is kept on this device and turns the chart; one tap on the turned chart puts it North up at once', () => {
        const { map, release } = obs();
        act(() => publishOwnshipMotion(busHeading(52)));
        fireEvent.click(arrow());
        const card = screen.getByRole('dialog', { name: 'Chart orientation' });
        const heading = within(card).getByRole('radio', { name: /^Heading up/ });
        expect(heading).toHaveTextContent('Her bow at the top, from her compass · 052°T');
        fireEvent.click(heading);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(localStorage.getItem(orientationKey('obs'))).toBe('heading');
        expect(norm(map.bearing)).toBeCloseTo(52, 3);
        expect(arrow()).toHaveAccessibleName('Chart orientation: Heading up, turned to 052 degrees. Tap for North up');
        expect(arrow()).toHaveTextContent('H UP');
        fireEvent.click(arrow());
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(localStorage.getItem(orientationKey('obs'))).toBe('north');
        expect(norm(map.bearing)).toBe(0);
        expect(localStorage.getItem(orientationKey('plan'))).toBeNull();
        release();
    });

    it('a mode that cannot be honoured yet holds North up, with an amber dot and the reason', () => {
        const { map, release } = obs();
        act(() => publishOwnshipMotion(phoneAt(0.4)));
        fireEvent.click(arrow());
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: /^Track up/ }));
        expect(arrow()).toHaveAccessibleName(
            'Chart orientation: Track up, holding North up: Waits until she is making 1.5 kn. Tap to choose',
        );
        expect(arrow().querySelector('i.bg-amber-400')).not.toBeNull();
        expect(norm(map.bearing)).toBe(0);
        // North up, so a tap opens the card (it says why), never a silent switch.
        fireEvent.click(arrow());
        expect(screen.getByRole('dialog', { name: 'Chart orientation' })).toBeInTheDocument();
        release();
    });

    it('the needle points at north on screen: rotate(−bearing), repainted in one frame on a turn', async () => {
        const { map, release } = obs();
        const needle = arrow().querySelector('svg g')!;
        expect(needle.getAttribute('transform')).toBe('rotate(0 12 12)');
        map.bearing = 37;
        map.fire('rotate');
        map.fire('rotate');
        await frame();
        expect(needle.getAttribute('transform')).toBe('rotate(-37 12 12)');
        release();
    });

    it('arrow keys move between the rows; Escape closes the card', () => {
        const { release } = obs();
        fireEvent.click(arrow());
        const rows = within(screen.getByRole('dialog')).getAllByRole('radio');
        rows[0].focus();
        fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
        expect(rows[1]).toHaveFocus();
        fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
        fireEvent.keyDown(rows[0], { key: 'ArrowUp' });
        expect(rows[3]).toHaveFocus();
        fireEvent.keyDown(rows[3], { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        release();
    });

    it('Obs hidden: no controller, nothing turns', () => {
        localStorage.setItem(orientationKey('obs'), 'heading');
        const { map, release } = obs(false);
        act(() => publishOwnshipMotion(busHeading(52)));
        expect(chartOrientationView().surface).toBeNull();
        expect(map.easeTo).not.toHaveBeenCalled();
        // Not even the needle listens while Obs is hidden (the zoom pair's own zoomend stays, as before).
        for (const type of ['rotate', 'moveend', 'idle', 'touchstart', 'mousedown'])
            expect(map.handlers.get(type) ?? []).toHaveLength(0);
        release();
    });
});

describe('the planner’s compass rose is the control there', () => {
    const pins = [
        { lat: 50.75, lon: -1.3 },
        { lat: 50.78, lon: -1.3 },
        { lat: 50.78, lon: -1.25 },
    ];
    function plan(selected: number | null) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const map = new FakeMapboxMap({ container });
        const mapRef = { current: map as unknown as mapboxgl.Map };
        const view = render(<CompassRoseOverlay mapRef={mapRef} mapReady pins={pins} selected={selected} />);
        return { ...view, map };
    }

    it('a button in the same locked box; its card offers North up and Course up on this leg', () => {
        plan(null);
        const rose = screen.getByRole('button', { name: /^Compass rose/ });
        expect(rose).toHaveAccessibleName('Compass rose: North up. Tap to choose the chart orientation');
        expect(rose.style.left).toBe('98px');
        expect(rose.style.width).toBe('116px');
        fireEvent.click(rose);
        const rows = within(screen.getByRole('dialog', { name: 'Chart orientation' })).getAllByRole('radio');
        expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(['North up', 'Course up on this leg']);
    });

    it('Course up on this leg turns the chart to the selected pin’s leg, kept apart from Obs', () => {
        const { map } = plan(1);
        fireEvent.click(screen.getByRole('button', { name: /^Compass rose/ }));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: /^Course up on this leg/ }));
        expect(norm(map.bearing)).toBeCloseTo(90, 0);
        expect(localStorage.getItem(orientationKey('plan'))).toBe('course');
        expect(localStorage.getItem(orientationKey('obs'))).toBeNull();
        expect(screen.getByRole('button', { name: /^Compass rose/ })).toHaveAccessibleName(
            'Compass rose: Course up on this leg, 090 degrees. Tap to choose the chart orientation',
        );
    });
});
