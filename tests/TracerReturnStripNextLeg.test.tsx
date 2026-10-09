/**
 * "Plot the 4th leg →" stays on the chart after a leg is saved (126-16a), so
 * leg after leg is three taps each with no trip back to Plan. It shows only
 * for a SAVED last leg of a trip: not mid-trip, not during the trip home, and
 * not while the leg on screen has unsaved edits. Fictional legs in the Solent
 * (UK).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TracerReturnStrip } from '../components/map/tracer/TracerReturnStrip';
import type { NextLegSeed, SavedTrace, TracePoint } from '../services/routeTracer';
import { nextLegOffer } from '../services/tripLegAdd';

const LYMINGTON = { lat: 50.755, lon: -1.53 };
const YARMOUTH = { lat: 50.707, lon: -1.5 };
const COWES = { lat: 50.765, lon: -1.297 };
const HAMBLE = { lat: 50.857, lon: -1.31 };
const line = (a: TracePoint, b: TracePoint): TracePoint[] => [
    { ...a },
    { lat: (a.lat + b.lat) / 2 + 0.003, lon: (a.lon + b.lon) / 2 },
    { ...b },
];

const legs: SavedTrace[] = [
    {
        id: 'solent',
        name: 'Lymington - Yarmouth (1st Leg)',
        createdAt: '2026-06-01T08:00:00Z',
        points: line(LYMINGTON, YARMOUTH),
        tripId: 'solent',
        legOrdinal: 1,
    },
    {
        id: 'solent-2',
        name: 'Yarmouth - Cowes (2nd Leg)',
        createdAt: '2026-06-01T09:00:00Z',
        points: line(YARMOUTH, COWES),
        tripId: 'solent',
        legOrdinal: 2,
    },
    {
        id: 'solent-3',
        name: 'Cowes - Hamble (3rd Leg)',
        createdAt: '2026-06-01T10:00:00Z',
        points: line(COWES, HAMBLE),
        tripId: 'solent',
        legOrdinal: 3,
        destName: 'Hamble',
    },
];
const seedFor = (ordinal: number, anchor: TracePoint, fromName: string): NextLegSeed => ({
    tripId: 'solent',
    ordinal,
    fromName,
    anchor,
});

describe('nextLegOffer: when the chart offers the next leg', () => {
    it('a saved last leg on screen offers the 4th leg from its arrival', () => {
        expect(
            nextLegOffer({
                savedTraces: legs,
                legAnchor: seedFor(3, COWES, 'Cowes'),
                points: legs[2].points,
                returnTrip: false,
            }),
        ).toEqual({ ordinal: 4, fromName: 'Hamble', afterId: 'solent-3', tripKey: 'solent' });
    });

    it('not mid-trip, not during the trip home, not with unsaved edits, not for a free route', () => {
        const base = { savedTraces: legs, returnTrip: false };
        expect(nextLegOffer({ ...base, legAnchor: seedFor(2, YARMOUTH, 'Yarmouth'), points: legs[1].points })).toBe(
            null,
        );
        expect(
            nextLegOffer({ ...base, legAnchor: seedFor(3, COWES, 'Cowes'), points: legs[2].points, returnTrip: true }),
        ).toBeNull();
        const edited = legs[2].points.map((p, i) => (i === 1 ? { lat: p.lat + 0.001, lon: p.lon } : p));
        expect(nextLegOffer({ ...base, legAnchor: seedFor(3, COWES, 'Cowes'), points: edited })).toBeNull();
        // An empty slot (nothing saved yet) has no "next" to offer.
        expect(nextLegOffer({ ...base, legAnchor: seedFor(4, HAMBLE, 'Hamble'), points: [HAMBLE] })).toBeNull();
        expect(nextLegOffer({ ...base, legAnchor: null, points: legs[2].points })).toBeNull();
    });
});

describe('TracerReturnStrip: the next-leg row', () => {
    const props = {
        note: null,
        slotChoices: null,
        slotFromName: null,
        onPickSlot: vi.fn(),
        onCancelSlot: vi.fn(),
        progress: null,
        nextReturnLeg: null,
        onNextReturnLeg: vi.fn(),
        onStopReturnTrip: vi.fn(),
    };

    it('says exactly where the next leg goes from, with 44 pt targets', () => {
        const onNextLeg = vi.fn();
        const onBackToTrip = vi.fn();
        render(
            <TracerReturnStrip
                {...props}
                nextLeg={{ ordinal: 4, fromName: 'Hamble' }}
                onNextLeg={onNextLeg}
                onBackToTrip={onBackToTrip}
            />,
        );
        const plot = screen.getByRole('button', { name: 'Plot the 4th leg →' });
        expect(plot).toHaveAttribute('title', 'Plot the 4th leg from Hamble');
        const back = screen.getByRole('button', { name: 'Back to the trip' });
        for (const button of [plot, back]) expect(button.className).toContain('min-h-[44px]');
        fireEvent.click(plot);
        expect(onNextLeg).toHaveBeenCalledOnce();
        fireEvent.click(back);
        expect(onBackToTrip).toHaveBeenCalledOnce();
    });

    it('is absent without an offer', () => {
        render(<TracerReturnStrip {...props} nextLeg={null} onNextLeg={vi.fn()} onBackToTrip={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /Plot the .* leg/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Back to the trip' })).not.toBeInTheDocument();
    });
});
