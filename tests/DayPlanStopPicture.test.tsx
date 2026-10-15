/**
 * Plan Your Day, build 132 (132-PYD-9): the stop page's route picture and
 * shelter rose as drawn (components/dayPlanner/TodayStopPicture.tsx), and the
 * room the stop page gives the picture (TodayStopDetail's pictureHeight).
 *
 * A dot at her start, a pin at the stop, the wind, land from OpenStreetMap,
 * and the routed line only once routed: never a straight line. The plan comes
 * first: the picture takes only the room the plan leaves it. The sheet's own
 * tests (DayPlanTodaySheet.test.tsx) open it on a stop page. Fictional places.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ShelterRose, StopMap } from '../components/dayPlanner/TodayStopPicture';
import { pictureHeight } from '../components/dayPlanner/TodayStopDetail';
import type { Segment } from '../services/weather/shelter/shelterGeometry';

const START = { lat: -20, lon: 149 };
const STOP = { lat: -20, lon: 149.2, name: 'Fixture Bay' };
const SE_TRADE = { dirDeg: 135, loKts: 12, hiKts: 15 };
/** A small anticlockwise island between them (land on the left of the coast). */
const ISLAND: Segment[] = [
    [
        [149.08, -20.02],
        [149.12, -20.02],
    ],
    [
        [149.12, -20.02],
        [149.12, -19.98],
    ],
    [
        [149.12, -19.98],
        [149.08, -19.98],
    ],
    [
        [149.08, -19.98],
        [149.08, -20.02],
    ],
];

afterEach(cleanup);

describe('the route picture', () => {
    it('before a route: her start and the stop, the wind, and no line at all; no coastline, and it says so', () => {
        const { container } = render(
            <StopMap start={START} stop={STOP} route={null} coastline={null} wind={SE_TRADE} />,
        );
        expect(
            screen.getByRole('img', {
                name: "Map: your start (dot) and Fixture Bay (pin), wind SE 12–15 kn. Land not drawn: the coastline didn't load.",
            }),
        ).toBeTruthy();
        expect(container.querySelector('polyline, line')).toBeNull();
        expect(container.querySelectorAll('.today-pic-mark')).toHaveLength(2);
        // Grey where land is not known, never the sea's colour; and in words, in the band at its foot.
        expect(container.querySelector('rect')).toHaveClass('today-pic-none');
        expect(container.querySelector('.today-pic-sea, .today-pic-land')).toBeNull();
        expect(container.querySelector('.today-pic-band .today-pic-note')).toHaveTextContent('Land not loaded');
        // The wind on the way out, its arrow downwind (a south-easterly blows to the north-west), after the land's words.
        const wind = container.querySelector<SVGElement>('.today-pic-band svg.today-pic-wind')!;
        expect(wind.style.transform).toBe('rotate(315deg)');
        expect(wind.nextElementSibling).toHaveTextContent(/^SE 12–15 kn$/);
        expect(wind.previousElementSibling).toHaveClass('today-pic-note');
    });

    it('while the coastline is still being asked for: grey, and it says loading; the land comes in when it answers', () => {
        const { container, rerender } = render(
            <StopMap start={START} stop={STOP} route={null} coastline="loading" wind={SE_TRADE} />,
        );
        expect(
            screen.getByRole('img', {
                name: 'Map: your start (dot) and Fixture Bay (pin), wind SE 12–15 kn. Land not drawn yet: the coastline is still loading.',
            }),
        ).toBeTruthy();
        expect(container.querySelector('rect')).toHaveClass('today-pic-none');
        expect(container.querySelector('.today-pic-sea, .today-pic-land')).toBeNull();
        expect(container.querySelector('.today-pic-note')).toHaveTextContent(/^Land loading…$/);
        rerender(<StopMap start={START} stop={STOP} route={null} coastline={ISLAND} wind={SE_TRADE} />);
        expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/\. Land © OpenStreetMap\.$/);
        expect(container.querySelector('rect')).toHaveClass('today-pic-sea');
        expect(container.querySelector('path.today-pic-land')).not.toBeNull();
    });

    it('routed: the routed line, every point of it, over the land OpenStreetMap maps', () => {
        const route = [START, { lat: -20.05, lon: 149.1 }, STOP];
        const { container } = render(
            <StopMap start={START} stop={STOP} route={route} coastline={ISLAND} wind={SE_TRADE} />,
        );
        expect(
            screen.getByRole('img', { name: /^Map: your start \(dot\) and Fixture Bay \(pin\), the routed line, / }),
        ).toBeTruthy();
        expect(container.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3);
        expect(container.querySelector('rect')).toHaveClass('today-pic-sea');
        expect(container.querySelector('path.today-pic-land')!.getAttribute('d')).toMatch(/^M[\d.]+ \d+h/);
        expect(screen.getByText('Land © OpenStreetMap')).toBeTruthy();
    });

    it('no forecast: no wind drawn or said', () => {
        const { container, rerender } = render(
            <StopMap start={START} stop={STOP} route={null} coastline={[]} wind={null} />,
        );
        expect(container.querySelector('.today-pic-wind')).toBeNull();
        expect(screen.getByRole('img').getAttribute('aria-label')).not.toMatch(/wind/);
        // OpenStreetMap answered with no coast here: said, and grey, never open sea.
        expect(screen.getByText('No coast mapped here')).toBeTruthy();
        expect(container.querySelector('rect')).toHaveClass('today-pic-none');
        rerender(
            <StopMap start={START} stop={STOP} route={null} coastline={[]} wind={{ ...SE_TRADE, dirDeg: null }} />,
        );
        expect(container.querySelector('.today-pic-wind')).toBeNull();
    });
});

describe('the shelter rose', () => {
    it('says which way the land shelters her', () => {
        const table = Array.from({ length: 36 }, (_, i) => (i >= 9 && i <= 18 ? 0.4 : 15));
        render(<ShelterRose table={table} />);
        expect(screen.getByRole('img', { name: 'Shelter rose: land close to the E, SE, S' })).toBeTruthy();
    });
});

/** A stop page as laid out, for pictureHeight: the room the card is given, the card, and any scroll. */
function page(o: { inner: number; card: number; over?: number; width?: number; row?: boolean; box?: number }) {
    const overlay = document.createElement('div');
    overlay.style.paddingTop = '16px';
    overlay.style.paddingBottom = '80px';
    const card = document.createElement('div');
    card.className = 'today-card';
    const body = document.createElement('div');
    body.className = 'today-body';
    const plan = document.createElement('div');
    plan.className = 'today-plan';
    overlay.append(card);
    card.append(body);
    body.append(plan);
    if (o.box) {
        const box = document.createElement('div');
        box.className = 'today-pic';
        Object.defineProperty(box, 'offsetHeight', { value: o.box });
        plan.append(box);
    }
    Object.defineProperty(overlay, 'clientHeight', { value: o.inner + 96 });
    Object.defineProperty(body, 'clientHeight', { value: 300 });
    Object.defineProperty(body, 'scrollHeight', { value: 300 + (o.over ?? 0) });
    Object.defineProperty(plan, 'clientWidth', { value: o.width ?? 296 });
    card.getBoundingClientRect = () => ({ height: o.card }) as DOMRect;
    if (o.row) body.style.flexDirection = 'row';
    return plan;
}

describe('the room the stop page gives the picture', () => {
    it('takes what the plan leaves, to 96 px on an SE', () => {
        // A 320 x 568's 472 px room, the page 380 tall: 92 px left.
        expect(pictureHeight(page({ inner: 472, card: 380 }))).toBe(92);
        expect(pictureHeight(page({ inner: 472, card: 300 }))).toBe(96);
    });

    it('grows with the room, to 140 px on a 430 x 932', () => {
        expect(pictureHeight(page({ inner: 754, card: 400, width: 378 }))).toBe(140);
    });

    it('never makes the page scroll: under 72 px left (too small for its words and the wind), it is not drawn', () => {
        expect(pictureHeight(page({ inner: 472, card: 400 }))).toBe(72);
        expect(pictureHeight(page({ inner: 472, card: 401 }))).toBe(0);
        expect(pictureHeight(page({ inner: 472, card: 440 }))).toBe(0);
    });

    it('keeps its size once drawn: the room it fills is its own', () => {
        expect(pictureHeight(page({ inner: 472, card: 472, box: 92 }))).toBe(92);
        // Then less room (a leave row's words grew): it gives way, and is gone under 72 px.
        expect(pictureHeight(page({ inner: 472, card: 472, box: 92, over: 10 }))).toBe(82);
        expect(pictureHeight(page({ inner: 472, card: 472, box: 92, over: 21 }))).toBe(0);
    });

    it('where the page scrolls without it (large text, long notes), it takes its full size in the scroll', () => {
        expect(pictureHeight(page({ inner: 472, card: 472, over: 30 }))).toBe(96);
    });

    it("in phone landscape's two columns it takes its size, in the facts' column", () => {
        expect(pictureHeight(page({ inner: 294, card: 294, row: true }))).toBe(96);
    });

    it('never wider than its column: half its width tall at most', () => {
        expect(pictureHeight(page({ inner: 754, card: 300, width: 150 }))).toBe(75);
    });

    it('with no page laid out, nothing', () => {
        expect(pictureHeight(document.createElement('div'))).toBe(0);
    });
});
