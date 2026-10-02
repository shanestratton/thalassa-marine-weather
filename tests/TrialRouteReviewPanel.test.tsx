import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrialRouteReviewPanel } from '../components/autorouting/TrialRouteReviewPanel';
import type { TrialRouteReview } from '../services/autoroutingReview';
import type { TraceIssue } from '../services/routeTracer';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import { TRIAL_GRADE_COLORS } from '../services/autoroutingReview';
import { NEEDS_TIDE_AMBER } from '../components/map/inshoreRouteState';
import type { RouteRedStretch } from '../components/map/routeRedReasons';
import {
    buildTrialDisplayWaypoints,
    displayWaypointForPathIndex,
    type TrialDisplayWaypoint,
} from '../services/autoroutingDisplayWaypoints';

const trackIssue = (offsetM: number): TraceIssue => ({
    severity: 'caution',
    message: `${offsetM} m from charted track — review alignment`,
    at: { lat: -27, lon: 153 + offsetM / 100_000 },
    chartTrack: { id: 'newport-entrance', label: 'Newport entrance leads', kind: 'leading-line', offsetM },
});
const reviewOf = (issues: TraceIssue[][]): TrialRouteReview => ({
    phase: 'complete',
    legs: issues.map((list) => ({
        incomplete: false,
        verdict: {
            grade: list.some((issue) => issue.severity === 'danger') ? 'danger' : list.length ? 'caution' : 'clear',
            issues: list,
            minDepthM: 8,
            minAt: null,
            needsTide: false,
            nudge: null,
            nudgeTo: null,
        },
    })),
});
function renderPanel(review: TrialRouteReview, selected = 0, route?: AutoroutingTrialRoute) {
    const coordinates = Array.from(
        { length: review.legs.length + 1 },
        (_, index) => [153 + index * 0.001, -27] as [number, number],
    );
    const props = {
        coordinates,
        // Dense fixtures keep the original per-leg regressions separate from
        // the sparse presentation cases below.
        waypoints: coordinates.map(
            (point, index): TrialDisplayWaypoint => ({
                coordinates: point,
                pathIndex: index,
                distanceM: index * 100,
                kind: index === 0 ? 'departure' : index === coordinates.length - 1 ? 'destination' : 'turn',
            }),
        ),
        review,
        route,
        selected,
        onSelect: vi.fn(),
        onFocus: vi.fn(),
        onStop: vi.fn(),
        onRecheck: vi.fn(),
    };
    return { ...render(<TrialRouteReviewPanel {...props} />), props };
}

function cleanupAndRender(props: ReturnType<typeof renderPanel>['props'], redStretches: RouteRedStretch[]) {
    cleanup();
    render(<TrialRouteReviewPanel {...props} redStretches={redStretches} />);
}

describe('trial route chart-track advisory groups', () => {
    it('keeps original points and hazard inspection when a sparse summary is unsupported', () => {
        const hazard = { lat: 0, lon: 30 };
        const review = reviewOf([[{ severity: 'danger', message: 'Unresolved original leg', at: hazard }]]);
        const { props, rerender } = renderPanel(review);
        rerender(
            <TrialRouteReviewPanel
                {...props}
                coordinates={[
                    [0, 0],
                    [180, 0],
                ]}
                waypoints={undefined}
            />,
        );
        expect(screen.getByRole('alert')).toHaveTextContent('Showing all original route points for inspection');
        expect(screen.getByRole('list', { name: 'Proposal waypoints' }).children).toHaveLength(2);
        expect(screen.queryByText(/Corners \+ every 50 NM/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Unresolved original leg ↗' }));
        expect(props.onFocus).toHaveBeenLastCalledWith(hazard);
    });

    it('shows one track summary with affected ranges while retaining every hazard and local locator', () => {
        const rock = { lat: -27.002, lon: 153.002 };
        const wreck = { lat: -27.003, lon: 153.003 };
        const danger = (mark: typeof rock): TraceIssue => ({
            severity: 'danger',
            message: 'obstruction near route',
            mark,
        });
        const review = reviewOf([[trackIssue(50)], [trackIssue(90), danger(rock)], [danger(wreck)], [trackIssue(60)]]);
        Object.assign(review.legs[1]!.verdict, { minDepthM: 1.2, needsTide: true });
        review.legs[1]!.incomplete = true;
        const { props } = renderPanel(review);

        const grouped = screen.getByRole('region', { name: 'Chart track advisories' });
        expect(within(grouped).getAllByRole('listitem')).toHaveLength(1);
        expect(grouped).toHaveTextContent('Track 1 · Newport entrance leads');
        expect(grouped).toHaveTextContent('Up to 90 m from charted track');
        expect(grouped).toHaveTextContent('Detailed route segments 1–2, 4');
        expect(screen.queryByText(trackIssue(50).message)).not.toBeInTheDocument();
        expect(screen.queryByText(trackIssue(90).message)).not.toBeInTheDocument();
        expect(screen.getByText('Leg 2→3: danger · 1.2 m least · checks incomplete')).toBeInTheDocument();
        expect(
            screen.getByText('Needs tide — no tidal clearance or departure window established.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('2 danger · 2 caution · 1 incomplete');

        const hazards = screen.getAllByRole('button', { name: 'obstruction near route ↗' });
        expect(hazards).toHaveLength(2);
        fireEvent.click(hazards[0]);
        expect(props.onFocus).toHaveBeenLastCalledWith(rock);
        fireEvent.click(hazards[1]);
        expect(props.onFocus).toHaveBeenLastCalledWith(wreck);

        fireEvent.click(screen.getByRole('button', { name: 'Locate track 1: Newport entrance leads' }));
        expect(props.onSelect).toHaveBeenLastCalledWith(2);
        expect(props.onFocus).toHaveBeenLastCalledWith(trackIssue(90).at);
        fireEvent.click(screen.getByRole('button', { name: 'Locate track 1 near segment 4' }));
        expect(props.onFocus).toHaveBeenLastCalledWith(trackIssue(60).at);
    });

    it('groups across waypoint pages and opens the affected page without losing its hazard', () => {
        const issues: TraceIssue[][] = Array.from({ length: 24 }, () => []);
        issues[0] = [trackIssue(50)];
        issues[22] = [
            trackIssue(140),
            { severity: 'danger', message: 'shallow charted depth', at: { lat: -27, lon: 153.022 } },
        ];
        const review = reviewOf(issues);
        const { props, rerender } = renderPanel(review);
        expect(screen.getByRole('region', { name: 'Chart track advisories' })).toHaveTextContent(
            'Detailed route segments 1, 23',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Locate track 1: Newport entrance leads' }));
        expect(props.onSelect).toHaveBeenCalledWith(23);
        expect(props.onFocus).toHaveBeenCalledWith(trackIssue(140).at);

        rerender(<TrialRouteReviewPanel {...props} selected={23} />);
        expect(screen.getByRole('button', { name: 'Locate track 1 near segment 23' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'shallow charted depth ↗' })).toBeInTheDocument();
        expect(screen.getByText('Leg 23→24: danger · 8.0 m least')).toBeInTheDocument();
    });

    it('leaves old unstructured advisories and all dangers in their original leg rows', () => {
        const legacy: TraceIssue = {
            severity: 'caution',
            message: '80 m off the lead — steer to the transit',
            at: { lat: -27, lon: 153 },
        };
        const danger: TraceIssue = { ...trackIssue(90), severity: 'danger' };
        renderPanel(reviewOf([[legacy], [legacy, danger]]));
        expect(screen.queryByRole('region', { name: 'Chart track advisories' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: `${legacy.message} ↗` })).toHaveLength(2);
        expect(screen.getByRole('button', { name: `${danger.message} ↗` })).toBeInTheDocument();
    });
});

describe("the router's notes and its line colours (2026-10-01)", () => {
    const route = (overrides: Partial<AutoroutingTrialRoute> = {}): AutoroutingTrialRoute => ({
        id: 'thalassa-route',
        provider: 'Thalassa',
        createdAt: '2026-10-01T01:00:00Z',
        coordinates: [
            [153, -27],
            [153.001, -27],
            [153.002, -27],
        ],
        warnings: [
            'Proposal only: not cleared for navigation.',
            'Bridges and power lines not checked on this chart — known bridges are.',
        ],
        engine: {
            stateMask: ['danger', 'green'],
            cellsUsed: ['OC-99-SYN001'],
            distanceNM: 0.1,
            elapsedMs: 10,
            backstop: 'verified',
        },
        ...overrides,
    });

    // Round 2 (Shane's field route, 2026-10-02): the summary said "4 route
    // notes · review required" over a list headed something else. The list
    // now carries the same words and count, and says where each note applies.
    it('lists every note whole under the same words as the summary count, before the checks, with no provider report', () => {
        const review = reviewOf([[], []]);
        const original = structuredClone(review);
        renderPanel(review, 0, route());
        const notes = screen.getByRole('region', { name: 'Route notes' });
        expect(within(notes).getByRole('heading')).toHaveTextContent('2 route notes · what this route must say');
        expect(
            within(notes)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual(route().warnings.map((note) => `Whole route · ${note}`));
        expect(
            notes.compareDocumentPosition(screen.getByText('Waypoints & local chart checks')) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(screen.queryByRole('region', { name: /provider report/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Locate provider finding/ })).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('0 danger · 0 caution · 0 incomplete');
        expect(screen.getByText('Leg 1→2: no issue found · 8.0 m least')).toBeVisible();
        expect(review).toEqual(original);
    });

    it("explains the router's five colours, and that the checks credit no tide", () => {
        renderPanel(reviewOf([[], []]), 0, route());
        const legend = screen.getByRole('region', { name: 'Route line colours' });
        expect(
            within(legend)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual([
            // Red is not only water no tide clears (2026-10-01 review): a
            // land crossing, decision-1 water and needs-tide water before
            // the tide chips load are red too.
            'Red · land, shallow or unchecked — read the route notes',
            'Amber · a tide clears it',
            'Amber dots · survey quality',
            'Yellow · marked channel',
            'Teal · deep water',
        ]);
        expect(within(legend).getAllByRole('listitem')[1].querySelector('span')).toHaveStyle({
            background: NEEDS_TIDE_AMBER,
        });
        expect(legend).toHaveTextContent('The chart checks below credit no tide');
    });

    it('drops the legend when the line is not in the router colours: unverified or edited', () => {
        const unverified = route();
        unverified.engine!.stateMask = null;
        const { unmount } = renderPanel(reviewOf([[], []]), 0, unverified);
        expect(screen.queryByRole('region', { name: 'Route line colours' })).not.toBeInTheDocument();
        unmount();
        const { engine: _engine, ...original } = route();
        renderPanel(reviewOf([[], []]), 0, {
            ...original,
            localEdit: { revision: 1, checksInvalidated: 'engine', waypointIndices: [1], originalProposal: original },
        });
        expect(screen.queryByRole('region', { name: 'Route line colours' })).not.toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Route notes' })).toHaveTextContent(
            'From the original route, before waypoint edits · historical, not checks of this line.',
        );
    });

    it('says which leg a note about a pin belongs to', () => {
        renderPanel(
            reviewOf([[], []]),
            0,
            route({
                warnings: [
                    'Proposal only: not cleared for navigation.',
                    'The route starts ~80 m from your departure pin; the water before it could not be reached.',
                    'The route ends ~60 m short of your destination pin; the water beyond could not be reached.',
                ],
            }),
        );
        const items = within(screen.getByRole('region', { name: 'Route notes' })).getAllByRole('listitem');
        expect(items.map((item) => item.textContent?.split(' · ')[0])).toEqual(['Whole route', 'Leg 1→2', 'Leg 2→3']);
        expect(screen.getByRole('heading', { name: /^3 route notes/ })).toBeInTheDocument();
    });

    // Round 2 (Shane's field route, 2026-10-02): legs 3→4→5→6 red on the
    // map, and each leg's check said "no issue found" with nothing saying why.
    it('names, under its leg, every stretch the map draws red — and where to look', () => {
        const stretch = {
            startSeg: 1,
            startT: 0.2,
            endSeg: 1,
            endT: 0.6,
            lengthM: 42,
            at: { lat: -27, lon: 153.0014 },
            why: 'charted 2.0 m — shallower than the 2.9 m this boat needs; no tide data here shows a tide that clears it',
        };
        const { props } = renderPanel(reviewOf([[], []]), 0, route());
        cleanupAndRender(props, [stretch]);
        expect(screen.getByText('Leg 1→2: no issue found · 8.0 m least')).toBeVisible();
        expect(
            screen.getByText('Leg 2→3: the chart check found no issue · 8.0 m least · drawn red on the map, why below'),
        ).toBeVisible();
        const why = screen.getByRole('button', {
            name: `Red on the map (40 m): ${stretch.why} ↗`,
        });
        expect(why).toHaveStyle({ color: TRIAL_GRADE_COLORS.danger });
        fireEvent.click(why);
        expect(props.onFocus).toHaveBeenCalledWith(stretch.at);
        expect(props.onSelect).toHaveBeenCalledWith(2);
    });

    it('keeps a local danger red whatever the router said', () => {
        renderPanel(reviewOf([[{ severity: 'danger', message: 'Insufficient charted depth' }], []]), 0, route());
        expect(screen.getByText('Insufficient charted depth')).toHaveStyle({ color: TRIAL_GRADE_COLORS.danger });
        expect(screen.getByText('Leg 1→2: danger · 8.0 m least')).toBeVisible();
    });
});

describe('sparse waypoint review retains the complete route checks', () => {
    const coordinates = Array.from({ length: 1000 }, (_, index) => [(index / 999) * 4, 0] as [number, number]);
    const sparseProps = (review: TrialRouteReview | null) => ({
        coordinates,
        review,
        selected: 0,
        onSelect: vi.fn(),
        onFocus: vi.fn(),
        onStop: vi.fn(),
        onRecheck: vi.fn(),
    });

    it('shows six waypoint cards for a straight 240 NM route without reducing the checked segment total', () => {
        const review = reviewOf(Array.from({ length: 999 }, () => []));
        const original = structuredClone({ review, coordinates });
        const props = sparseProps(review);
        const { rerender } = render(<TrialRouteReviewPanel {...props} />);
        expect(within(screen.getByRole('list', { name: 'Proposal waypoints' })).getAllByRole('listitem')).toHaveLength(
            6,
        );
        expect(screen.getByText(/6 waypoints · 1000 detailed route points/)).toBeVisible();
        expect(screen.getByRole('status')).toHaveTextContent('999/999 checked segments');
        expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
        expect(screen.getByText(/Corners \+ every 50 NM/)).toBeVisible();
        expect({ review, coordinates }).toEqual(original);

        rerender(<TrialRouteReviewPanel {...props} review={null} />);
        expect(screen.getByRole('status')).toHaveTextContent('Checking 0/999 detailed route segments');
        expect(within(screen.getByRole('list', { name: 'Proposal waypoints' })).getAllByRole('listitem')).toHaveLength(
            6,
        );
    });

    it('aggregates every hidden segment danger, minimum depth and tide requirement with exact locators', () => {
        const review = reviewOf(Array.from({ length: 999 }, () => []));
        const rock = { lat: 0.001, lon: 2.224 };
        review.legs[555]!.verdict = {
            ...review.legs[555]!.verdict,
            grade: 'danger',
            minDepthM: 1.2,
            needsTide: true,
            nudge: 'Inspect this obstruction on the current chart.',
            issues: [
                { severity: 'danger', message: 'Rock inside original route corridor', mark: rock },
                { severity: 'danger', message: 'Unlocated source obstruction' },
            ],
        };
        review.legs[555]!.incomplete = true;
        const original = structuredClone(review);
        const props = sparseProps(review);
        render(<TrialRouteReviewPanel {...props} />);
        const arrivingIndex = displayWaypointForPathIndex(buildTrialDisplayWaypoints(coordinates), 556);
        const rows = within(screen.getByRole('list', { name: 'Proposal waypoints' })).getAllByRole('listitem');
        const row = rows[arrivingIndex];
        expect(row).toHaveTextContent('danger · 1.2 m least · checks incomplete');
        expect(within(row).getByText(`● ${arrivingIndex + 1}`)).toHaveStyle({ color: TRIAL_GRADE_COLORS.danger });
        expect(row).toHaveTextContent('Segment 556');
        expect(row).toHaveTextContent('Needs tide — no tidal clearance or departure window established.');
        expect(row).toHaveTextContent('Inspect this obstruction on the current chart.');
        expect(within(row).getByText('Unlocated source obstruction')).toHaveStyle({ color: TRIAL_GRADE_COLORS.danger });
        fireEvent.click(within(row).getByRole('button', { name: 'Rock inside original route corridor ↗' }));
        expect(props.onSelect).toHaveBeenLastCalledWith(arrivingIndex);
        expect(props.onFocus).toHaveBeenLastCalledWith(rock);
        expect(screen.getByRole('status')).toHaveTextContent(
            '1 danger · 0 caution · 1 incomplete · 999/999 checked segments',
        );
        expect(review).toEqual(original);
    });

    it('does not paint an arriving waypoint green when one hidden segment is unchecked', () => {
        const review = reviewOf(Array.from({ length: 999 }, () => []));
        review.legs[555] = null;
        render(<TrialRouteReviewPanel {...sparseProps(review)} />);
        const arrivingIndex = displayWaypointForPathIndex(buildTrialDisplayWaypoints(coordinates), 556);
        const row = within(screen.getByRole('list', { name: 'Proposal waypoints' })).getAllByRole('listitem')[
            arrivingIndex
        ];
        expect(within(row).getByText(`● ${arrivingIndex + 1}`)).toHaveStyle({ color: TRIAL_GRADE_COLORS.unchecked });
        expect(row).toHaveTextContent('unchecked · 8.0 m least known');
        expect(screen.getByRole('status')).toHaveTextContent('1 incomplete · 998/999 checked segments');
    });

    it.each(['incomplete', 'missing-depth', 'needs-tide', 'stale', 'error'] as const)(
        'keeps a sparse arriving card non-green for %s even when raw grades were clear',
        (condition) => {
            const review = reviewOf(Array.from({ length: 999 }, () => []));
            if (condition === 'incomplete') review.legs[555]!.incomplete = true;
            if (condition === 'missing-depth') review.legs[555]!.verdict.minDepthM = null;
            if (condition === 'needs-tide') review.legs[555]!.verdict.needsTide = true;
            if (condition === 'stale' || condition === 'error') review.phase = condition;
            render(<TrialRouteReviewPanel {...sparseProps(review)} />);
            const arrivingIndex = displayWaypointForPathIndex(buildTrialDisplayWaypoints(coordinates), 556);
            const row = within(screen.getByRole('list', { name: 'Proposal waypoints' })).getAllByRole('listitem')[
                arrivingIndex
            ];
            expect(within(row).getByText(`● ${arrivingIndex + 1}`)).not.toHaveStyle({
                color: TRIAL_GRADE_COLORS.clear,
            });
            if (condition === 'needs-tide') expect(row).toHaveTextContent('Needs tide');
        },
    );

    it('maps grouped track locators and paging to sparse display indices, retaining source segment labels', () => {
        const review = reviewOf(Array.from({ length: 999 }, () => []));
        review.legs[555]!.verdict.issues = [trackIssue(140)];
        review.legs[555]!.verdict.grade = 'caution';
        const props = sparseProps(review);
        // Dense bends before a long final leg: raw segment 556 arrives at
        // displayed waypoint 23, never at invented displayed waypoint 557.
        const indices = [...Array.from({ length: 21 }, (_, index) => index), 500, 999];
        const waypoints = indices.map(
            (pathIndex, index): TrialDisplayWaypoint => ({
                coordinates: coordinates[pathIndex],
                pathIndex,
                distanceM: pathIndex * 445,
                kind: index === 0 ? 'departure' : index === indices.length - 1 ? 'destination' : 'turn',
            }),
        );
        const { rerender } = render(<TrialRouteReviewPanel {...props} waypoints={waypoints} />);
        expect(screen.getByRole('region', { name: 'Chart track advisories' })).toHaveTextContent(
            'Detailed route segment 556',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Locate track 1: Newport entrance leads' }));
        expect(props.onSelect).toHaveBeenLastCalledWith(22);
        expect(props.onFocus).toHaveBeenLastCalledWith(trackIssue(140).at);
        rerender(<TrialRouteReviewPanel {...props} waypoints={waypoints} selected={22} />);
        expect(screen.getByText('21–23 / 23')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Locate track 1 near segment 556' }));
        expect(props.onSelect).toHaveBeenLastCalledWith(22);
        expect(props.onFocus).toHaveBeenLastCalledWith(trackIssue(140).at);
        fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
        expect(props.onSelect).toHaveBeenLastCalledWith(0);
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('keeps a hazard on both arriving display legs when a 50 NM marker splits its original checked segment', () => {
        const review = reviewOf([
            [{ severity: 'danger', message: 'Original long segment hazard', at: { lat: 0, lon: 1.2 } }],
        ]);
        const props = {
            ...sparseProps(review),
            coordinates: [
                [0, 0],
                [2, 0],
            ] as [number, number][],
        };
        render(<TrialRouteReviewPanel {...props} />);
        expect(screen.getAllByRole('button', { name: 'Original long segment hazard ↗' })).toHaveLength(3);
        expect(screen.getByRole('status')).toHaveTextContent(
            '1 danger · 0 caution · 0 incomplete · 1/1 checked segments',
        );
    });
});

describe('compact Tracer review disclosures', () => {
    it('keeps danger, shallow depth and tide visible while other local notes are expandable', () => {
        const rock = { lat: -27.1, lon: 153.1 };
        const review = reviewOf([
            [
                { severity: 'danger', message: 'Charted rock in the leg', at: rock },
                { severity: 'caution', message: 'Check nearby cable', at: { lat: -27.2, lon: 153.2 } },
            ],
        ]);
        review.legs[0]!.verdict.minDepthM = 1.1;
        review.legs[0]!.verdict.needsTide = true;
        const { props } = renderPanel(review);
        expect(screen.getByRole('button', { name: 'Charted rock in the leg ↗' })).toBeVisible();
        expect(screen.getByText('Leg 1→2: danger · 1.1 m least')).toBeVisible();
        expect(screen.getByText('Needs tide — no tidal clearance or departure window established.')).toBeVisible();
        expect(screen.getByText('Check nearby cable ↗')).not.toBeVisible();
        fireEvent.click(screen.getByText('1 advisory · details'));
        const cable = screen.getByRole('button', { name: 'Check nearby cable ↗' });
        expect(cable).toBeVisible();
        fireEvent.click(cable);
        expect(props.onSelect).toHaveBeenLastCalledWith(1);
        expect(props.onFocus).toHaveBeenLastCalledWith({ lat: -27.2, lon: 153.2 });
    });

    it('uses one row action for selection and shows the selected row without a redundant button', () => {
        const { props, rerender } = renderPanel(reviewOf([[]]), 1);
        const onInspectWaypoint = vi.fn();
        rerender(<TrialRouteReviewPanel {...props} onInspectWaypoint={onInspectWaypoint} />);
        const button = screen.getByRole('button', { name: 'Select waypoint 2' });
        expect(screen.getAllByRole('button', { name: 'Select waypoint 2' })).toHaveLength(1);
        expect(button.closest('li')).toHaveAttribute('data-selected', 'true');
        fireEvent.click(button);
        expect(onInspectWaypoint).toHaveBeenCalledExactlyOnceWith(1);
        expect(props.onFocus).toHaveBeenCalledExactlyOnceWith({ lat: -27, lon: 153.001 });
    });
});
