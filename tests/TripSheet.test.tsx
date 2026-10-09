/**
 * The Trip sheet (126-16a) replaces the Trip · Legs select wheel: (a) your
 * trips, (b) one trip's legs as cards with "+ Add the Nth leg from <place>",
 * (c) the saved routes and other trips' legs that start (or end) there. A pick
 * sends ids only, under the scope the rows were built in; the tracer opens a
 * copy and its own Save writes it.
 *
 * Fictional library: Banks Peninsula (New Zealand), and one Atlantic crossing.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    setAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import type { SavedTrace, TracePoint } from '../services/routeTracer';

const mocks = vi.hoisted(() => ({ requestTracerOpen: vi.fn() }));
vi.mock('../services/deepLink', () => ({ requestTracerOpen: mocks.requestTracerOpen }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
// The season card has its own tests; here it would only fetch.
vi.mock('../components/passage/SeasonRiskCard', () => ({ default: () => null }));

import TripSheet from '../components/passage/TripSheet';
import { PanePortalScope } from '../context/PanePortalContext';

const NM_PER_DEG_LAT = (3440.065 * Math.PI) / 180;
const north = (p: TracePoint, nm: number): TracePoint => ({ lat: p.lat + nm / NM_PER_DEG_LAT, lon: p.lon });
const line = (a: TracePoint, b: TracePoint): TracePoint[] => [
    { ...a },
    { lat: (a.lat + b.lat) / 2 + 0.004, lon: (a.lon + b.lon) / 2 },
    { ...b },
];
const LYTTELTON = { lat: -43.607, lon: 172.722 };
const PORT_LEVY = { lat: -43.641, lon: 172.83 };
const AKAROA = { lat: -43.806, lon: 172.968 };
const PIGEON_BAY = { lat: -43.68, lon: 172.9 };
const LE_BONS_BAY = { lat: -43.74, lon: 173.11 };
const LITTLE_AKALOA = { lat: -43.68, lon: 173.0 };
const OKAINS_BAY = { lat: -43.7, lon: 173.06 };

const row = (id: string, name: string, points: TracePoint[], at: string, extra: Partial<SavedTrace> = {}) =>
    ({ id, name, createdAt: at, points, ...extra }) as SavedTrace;

function library(): SavedTrace[] {
    return [
        row('p', 'Lyttelton - Port Levy (1st Leg)', line(LYTTELTON, PORT_LEVY), '2026-09-10T08:00:00Z', {
            tripId: 'p',
            legOrdinal: 1,
            plannedRouteId: 'planned_p1',
        }),
        row('p-2', 'Port Levy - Akaroa (2nd Leg)', line(PORT_LEVY, AKAROA), '2026-09-12T08:00:00Z', {
            tripId: 'p',
            legOrdinal: 2,
        }),
        row('p-3', 'Akaroa - Pigeon Bay (3rd Leg)', line(north(AKAROA, 0.9), PIGEON_BAY), '2026-09-14T08:00:00Z', {
            tripId: 'p',
            legOrdinal: 3,
        }),
        row('q', 'Le Bons Bay - Little Akaloa (1st Leg)', line(LE_BONS_BAY, LITTLE_AKALOA), '2026-09-01T08:00:00Z', {
            tripId: 'q',
            legOrdinal: 1,
        }),
        row(
            'q-2',
            'Little Akaloa - Pigeon Bay (2nd Leg)',
            line(LITTLE_AKALOA, north(PIGEON_BAY, 0.6)),
            '2026-09-01T09:00:00Z',
            { tripId: 'q', legOrdinal: 2 },
        ),
        row('okains', 'Pigeon Bay - Okains Bay', line(PIGEON_BAY, OKAINS_BAY), '2026-08-20T08:00:00Z'),
        row('far', 'Okains Bay - Le Bons Bay', line(north(PIGEON_BAY, 6.2), LE_BONS_BAY), '2026-08-10T08:00:00Z'),
        row(
            'cadiz',
            'Cádiz → Funchal',
            line({ lat: 36.53, lon: -6.3 }, { lat: 32.64, lon: -16.91 }),
            '2026-08-01T08:00:00Z',
        ),
    ];
}

function store(traces: SavedTrace[], scope: AuthIdentityScope = getAuthIdentityScope()): void {
    localStorage.setItem(authScopedStorageKey('thalassa_traced_routes_v1', scope), JSON.stringify(traces));
}

function changed(scope: AuthIdentityScope = getAuthIdentityScope()): void {
    act(() => {
        window.dispatchEvent(
            new CustomEvent('thalassa:saved-routes-changed', {
                detail: { scopeKey: scope.key, scopeGeneration: scope.generation },
            }),
        );
    });
}

function open(start?: React.ComponentProps<typeof TripSheet>['start']) {
    const scope = getAuthIdentityScope();
    const onClose = vi.fn();
    const onOpenChart = vi.fn();
    const { unmount } = render(<TripSheet scope={scope} start={start} onClose={onClose} onOpenChart={onOpenChart} />);
    return { scope, onClose, onOpenChart, unmount, dialog: () => screen.getByRole('dialog') };
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
    store(library());
});

describe('(a) your trips', () => {
    it('lists trips newest first, a single route as a one-leg trip, and searches', () => {
        const { dialog } = open();
        expect(within(dialog()).getByRole('heading', { name: 'Your trips' })).toBeInTheDocument();
        const trips = within(within(dialog()).getByRole('list', { name: 'Trips' })).getAllByRole('button');
        expect(trips.map((b) => b.textContent)).toEqual([
            expect.stringMatching(/^Lyttelton - Pigeon Bay.*3 legs/),
            expect.stringMatching(/^Le Bons Bay - Pigeon Bay.*2 legs/),
            expect.stringMatching(/^Pigeon Bay - Okains Bay.*1 leg\b/),
            expect.stringMatching(/^Okains Bay - Le Bons Bay.*1 leg\b/),
            expect.stringMatching(/^Cádiz → Funchal.*1 leg\b/),
        ]);
        expect(trips[0].textContent).toMatch(/\d+(\.\d)? NM/);
        expect(trips[0].textContent).toMatch(/updated/);

        fireEvent.change(within(dialog()).getByRole('searchbox', { name: 'Search your trips' }), {
            target: { value: 'cadiz' },
        });
        expect(within(within(dialog()).getByRole('list', { name: 'Trips' })).getAllByRole('button')).toHaveLength(1);
        expect(within(dialog()).getByText('Cádiz → Funchal')).toBeInTheDocument();
    });

    it('a tap opens the trip’s legs', () => {
        const { dialog } = open();
        fireEvent.click(within(dialog()).getByRole('button', { name: /^Lyttelton - Pigeon Bay/ }));
        expect(within(dialog()).getByRole('heading', { name: 'Lyttelton - Pigeon Bay' })).toBeInTheDocument();
    });
});

describe('(b) a trip', () => {
    it('shows the legs as cards in order, the joints, and whether each is in the Log', () => {
        const { dialog } = open({ pane: 'trip', tripKey: 'p' });
        const cards = within(within(dialog()).getByRole('list', { name: 'Legs' })).getAllByRole('button', {
            name: /^Leg \d/,
        });
        expect(cards.map((c) => c.getAttribute('aria-label')?.split(':')[0])).toEqual(['Leg 1', 'Leg 2', 'Leg 3']);
        expect(cards[0]).toHaveAccessibleName(/Lyttelton - Port Levy.*in the Log/);
        expect(cards[1]).toHaveAccessibleName(/Port Levy - Akaroa.*Not in the log yet/);
        expect(within(dialog()).getByText('⛓ joined')).toBeInTheDocument();
        expect(within(dialog()).getByText("starts 0.9 NM from leg 2's end")).toBeInTheDocument();
        expect(within(dialog()).getByText(/3 legs · \d+(\.\d)? NM/)).toBeInTheDocument();
    });

    it('a card opens that leg on the chart in its place', () => {
        const { dialog, scope, onOpenChart, onClose } = open({ pane: 'trip', tripKey: 'p' });
        fireEvent.click(within(dialog()).getByRole('button', { name: /^Leg 2:/ }));
        expect(mocks.requestTracerOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'load-saved', id: 'p-2' }, scope);
        expect(onOpenChart).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('the footer adds the next leg from the last arrival; ⇄ and the return trip send today’s payloads', () => {
        const { dialog, scope } = open({ pane: 'trip', tripKey: 'p' });
        expect(within(dialog()).getByRole('button', { name: '+ Add the 4th leg from Pigeon Bay' })).toBeInTheDocument();
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Return from Akaroa: legs 2 to 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'p', fromOrdinal: 2 },
            scope,
        );
        fireEvent.click(within(dialog()).getByRole('button', { name: /^⇄ Plan the return trip/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith({ kind: 'return-trip', tripId: 'p' }, scope);
    });

    it('a one-leg trip offers the 2nd leg and no return-trip row', () => {
        const { dialog } = open({ pane: 'trip', tripKey: 'okains' });
        expect(within(dialog()).getByRole('button', { name: '+ Add the 2nd leg from Okains Bay' })).toBeInTheDocument();
        expect(within(dialog()).queryByRole('button', { name: /Plan the return trip/ })).not.toBeInTheDocument();
    });

    it('Back goes to your trips; Escape goes back one pane, then closes', () => {
        const { dialog, onClose } = open({ pane: 'trip', tripKey: 'p' });
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));
        expect(within(dialog()).getByRole('heading', { name: 'Your trips' })).toBeInTheDocument();
        fireEvent.click(within(dialog()).getByRole('button', { name: /^Lyttelton - Pigeon Bay/ }));
        fireEvent.keyDown(dialog(), { key: 'Escape' });
        expect(within(dialog()).getByRole('heading', { name: 'Your trips' })).toBeInTheDocument();
        fireEvent.keyDown(dialog(), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });
});

describe('(c) add the next leg', () => {
    it('lists what starts there, what ends there to sail the other way, and what is further away and why', () => {
        const { dialog } = open({ pane: 'trip', tripKey: 'p' });
        fireEvent.click(within(dialog()).getByRole('button', { name: '+ Add the 4th leg from Pigeon Bay' }));
        const d = dialog();
        expect(within(d).getByRole('heading', { name: '4th leg from Pigeon Bay' })).toBeInTheDocument();
        expect(
            within(d).getByText('A copy goes in and is checked for this trip. The route you pick is unchanged.'),
        ).toBeInTheDocument();
        const starts = within(d).getByRole('list', { name: 'Starts at Pigeon Bay' });
        expect(within(starts).getByRole('button', { name: /^Pigeon Bay - Okains Bay/ })).toHaveAccessibleName(
            /your saved route · [\d.]+ NM · at the pin/,
        );
        const ends = within(d).getByRole('list', { name: 'Ends at Pigeon Bay — sail it the other way' });
        expect(within(ends).getByRole('button', { name: /^Little Akaloa - Pigeon Bay/ })).toHaveAccessibleName(
            /leg 2 of Le Bons Bay - Pigeon Bay · [\d.]+ NM · 0\.6 NM joining run/,
        );
        // Further away is folded, its rows disabled with their reason.
        expect(within(d).queryByRole('list', { name: 'Further away' })).not.toBeInTheDocument();
        fireEvent.click(within(d).getByRole('button', { name: /^Show \d+ more$/ }));
        const further = within(d).getByRole('list', { name: 'Further away' });
        const near = within(further).getByRole('button', { name: /^Okains Bay - Le Bons Bay/ });
        expect(near).toBeDisabled();
        expect(near).toHaveAccessibleName(/starts 6\.2 NM from Pigeon Bay/);
    });

    it('a pick sends exactly the ids and the direction, under the scope the rows were built in', () => {
        const { dialog, scope, onOpenChart, onClose } = open({ pane: 'add', afterId: 'p-3' });
        fireEvent.click(within(dialog()).getByRole('button', { name: /^Pigeon Bay - Okains Bay/ }));
        expect(mocks.requestTracerOpen).toHaveBeenCalledExactlyOnceWith(
            { kind: 'add-leg', afterId: 'p-3', sourceId: 'okains', direction: 'forward' },
            scope,
        );
        expect(onOpenChart).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('the other way round is a reverse pick; "Plot it by hand" is the empty locked leg', () => {
        const { dialog, scope } = open({ pane: 'add', afterId: 'p-3' });
        fireEvent.click(within(dialog()).getByRole('button', { name: /^Little Akaloa - Pigeon Bay/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'add-leg', afterId: 'p-3', sourceId: 'q-2', direction: 'reverse' },
            scope,
        );
        fireEvent.click(within(dialog()).getByRole('button', { name: '✎ Plot it by hand' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith({ kind: 'new-leg', fromId: 'p-3' }, scope);
    });

    it('searches the routes and legs', () => {
        const { dialog } = open({ pane: 'add', afterId: 'p-3' });
        fireEvent.change(within(dialog()).getByRole('searchbox', { name: 'Search routes and legs' }), {
            target: { value: 'akaloa' },
        });
        expect(within(dialog()).queryByRole('button', { name: /^Pigeon Bay - Okains Bay/ })).not.toBeInTheDocument();
        expect(within(dialog()).getByRole('button', { name: /^Little Akaloa - Pigeon Bay/ })).toBeInTheDocument();
    });

    it('warns about the 50-route library at 45 rows, not at 44', () => {
        const filler = (n: number) =>
            Array.from({ length: n }, (_, i) =>
                row(
                    `f-${i}`,
                    `Filler ${i} - Elsewhere`,
                    line({ lat: 10 + i, lon: 10 }, { lat: 10 + i, lon: 10.1 }),
                    '2026-01-01T00:00:00Z',
                ),
            );
        const base = library();
        store([...base, ...filler(44 - base.length)]);
        const first = open({ pane: 'add', afterId: 'p-3' });
        expect(within(first.dialog()).queryByText(/routes on this phone/)).not.toBeInTheDocument();
        first.unmount();
        store([...base, ...filler(45 - base.length)]);
        const second = open({ pane: 'add', afterId: 'p-3' });
        expect(
            within(second.dialog()).getByText('45 of 50 routes on this phone. Older unchecked trips make room first.'),
        ).toBeInTheDocument();
    });
});

describe('identity and refresh', () => {
    it('an account change closes the sheet and drops its rows', () => {
        const { onClose } = open({ pane: 'trip', tripKey: 'p' });
        expect(screen.getByText(/Lyttelton - Port Levy/)).toBeInTheDocument();
        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(onClose).toHaveBeenCalled();
        expect(screen.queryByText(/Lyttelton/)).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.requestTracerOpen).not.toHaveBeenCalled();
    });

    it('saved-routes-changed refreshes in place', () => {
        const { dialog } = open();
        store([
            ...library(),
            row(
                'new',
                'Tromsø - Skjervøy',
                line({ lat: 69.65, lon: 18.96 }, { lat: 70.03, lon: 20.97 }),
                '2026-10-01T08:00:00Z',
            ),
        ]);
        changed();
        const trips = within(within(dialog()).getByRole('list', { name: 'Trips' })).getAllByRole('button');
        expect(trips[0].textContent).toMatch(/^Tromsø - Skjervøy/);
    });

    it('when the open trip vanishes, the sheet falls back to your trips and says so', () => {
        const { dialog } = open({ pane: 'trip', tripKey: 'p' });
        store(library().filter((t) => t.tripId !== 'p'));
        changed();
        expect(within(dialog()).getByRole('heading', { name: 'Your trips' })).toBeInTheDocument();
        expect(within(dialog()).getByText('That trip changed — pick it again')).toBeInTheDocument();
    });
});

/** 126-16a review: the old legs modal locked its pane; the sheet must too. Its
 *  focus trap takes that lock (useFocusTrap → usePaneModalLock on the card). */
describe('split view', () => {
    // A measured pane: an unmeasured one (jsdom's 0 × 0) hides its portal host.
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            width: 600,
            height: 760,
            right: 600,
            bottom: 760,
            x: 0,
            y: 0,
            toJSON() {},
        } as DOMRect);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function PlanPane({ sheet }: { sheet: boolean }) {
        const ref = React.useRef<HTMLDivElement>(null);
        return (
            <PanePortalScope enabled paneId="left" frameRef={ref}>
                <div ref={ref} data-testid="plan-pane">
                    <button type="button">Start plotting</button>
                    {sheet && <TripSheet scope={getAuthIdentityScope()} onClose={vi.fn()} onOpenChart={vi.fn()} />}
                </div>
            </PanePortalScope>
        );
    }

    it('makes the Plan page behind the sheet inert while it is open, and only then', () => {
        const view = render(<PlanPane sheet={false} />);
        expect(screen.getByTestId('plan-pane')).not.toHaveAttribute('inert');
        view.rerender(<PlanPane sheet />);
        // Portalled into the pane's host, outside the page it locks.
        expect(screen.getByTestId('plan-pane')).not.toContainElement(screen.getByRole('dialog'));
        expect(screen.getByTestId('plan-pane')).toHaveAttribute('inert');
        view.rerender(<PlanPane sheet={false} />);
        expect(screen.getByTestId('plan-pane')).not.toHaveAttribute('inert');
    });

    it('lets go of the page when an account change ends the sheet', () => {
        render(<PlanPane sheet />);
        expect(screen.getByTestId('plan-pane')).toHaveAttribute('inert');
        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByTestId('plan-pane')).not.toHaveAttribute('inert');
    });
});
