import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    requestTracerOpen: vi.fn(),
    triggerHaptic: vi.fn(),
}));

vi.mock('../services/deepLink', () => ({
    requestTracerOpen: mocks.requestTracerOpen,
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: mocks.triggerHaptic,
}));

vi.mock('../services/routeTracer', () => {
    const traceFor = (owner: string) => ({
        id: `${owner}-route`,
        name: `${owner.toUpperCase()} private route`,
        createdAt: '2026-07-23T00:00:00.000Z',
        points: [
            { lat: -27.4, lon: 153.0 },
            { lat: -27.2, lon: 153.2 },
        ],
    });
    // A fictional two-leg trip per account, for the return-trip controls.
    const tripFor = (owner: string) => [
        {
            id: `${owner}-trip`,
            name: 'Harbour - Bay Point (1st Leg)',
            createdAt: '2026-07-23T00:00:00.000Z',
            points: [
                { lat: -30.0, lon: 160.0 },
                { lat: -29.9, lon: 160.1 },
            ],
            tripId: `${owner}-trip`,
            legOrdinal: 1,
            destName: 'Bay Point',
        },
        {
            id: `${owner}-trip-leg-2`,
            name: 'Bay Point - Sandy Cove (2nd Leg)',
            createdAt: '2026-07-23T00:00:00.000Z',
            points: [
                { lat: -29.9, lon: 160.1 },
                { lat: -29.8, lon: 160.2 },
            ],
            tripId: `${owner}-trip`,
            legOrdinal: 2,
        },
    ];
    type Row = { id: string; name: string; tripId?: string; points: Array<{ lat: number; lon: number }> };
    return {
        loadSavedTraces: vi.fn((scope: { userId: string | null }) =>
            scope.userId ? [traceFor(scope.userId), ...tripFor(scope.userId)] : [],
        ),
        groupTracesByTrip: vi.fn((traces: Row[]) => {
            const keys = [...new Set(traces.map((trace) => trace.tripId ?? trace.id))];
            return keys.map((key) => {
                const legs = traces.filter((trace) => (trace.tripId ?? trace.id) === key);
                return { key, label: legs.length > 1 ? 'Harbour - Sandy Cove (2 legs)' : legs[0].name, legs };
            });
        }),
        nextLegSeed: vi.fn(() => null),
        ordinalLegLabel: vi.fn(() => '2nd Leg'),
    };
});

import { TripLegPicker } from '../components/passage/TripLegPicker';

describe('TripLegPicker identity fence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('passes the exact generation that owned the loaded route', () => {
        const accountA = getAuthIdentityScope();
        const onOpenChart = vi.fn();
        render(<TripLegPicker onOpenChart={onOpenChart} />);

        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-route' },
        });
        fireEvent.click(screen.getByRole('button', { name: /ACCOUNT-A private route/ }));

        expect(mocks.requestTracerOpen).toHaveBeenCalledWith({ kind: 'load-saved', id: 'account-a-route' }, accountA);
        expect(onOpenChart).toHaveBeenCalledOnce();
    });

    it('closes A UI and replaces its private route snapshot synchronously for B', () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-route' },
        });
        expect(screen.getByRole('dialog', { name: /ACCOUNT-A private route/ })).toBeInTheDocument();

        let accountB!: ReturnType<typeof getAuthIdentityScope>;
        act(() => {
            accountB = setAuthIdentityScope('account-b');
        });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByText(/ACCOUNT-A private route/)).not.toBeInTheDocument();
        const picker = screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' });
        expect(picker).toHaveTextContent('ACCOUNT-B private route');

        fireEvent.change(picker, { target: { value: 'account-b-route' } });
        fireEvent.click(screen.getByRole('button', { name: /ACCOUNT-B private route/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'load-saved', id: 'account-b-route' },
            accountB,
        );
    });

    it('the return-trip row and the per-leg chips pass the generation that owned the trip', () => {
        const accountA = getAuthIdentityScope();
        const onOpenChart = vi.fn();
        render(<TripLegPicker onOpenChart={onOpenChart} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-trip' },
        });
        const dialog = screen.getByRole('dialog', { name: /Harbour - Sandy Cove/ });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Plan the return trip/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-trip' },
            accountA,
        );

        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-trip' },
        });
        // Leg 2 arrives at Sandy Cove (parsed from its name); leg 1 carries Bay Point.
        fireEvent.click(screen.getByRole('button', { name: 'Return from Sandy Cove: legs 2 to 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-trip', fromOrdinal: 2 },
            accountA,
        );
        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-trip' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Return from Bay Point: leg 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-trip', fromOrdinal: 1 },
            accountA,
        );
        expect(onOpenChart).toHaveBeenCalledTimes(3);
    });

    it('a one-leg route gets a chip but no return-trip row', () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-route' },
        });
        const dialog = screen.getByRole('dialog', { name: /ACCOUNT-A private route/ });
        expect(within(dialog).queryByRole('button', { name: /^Plan the return trip/ })).not.toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Return from the end of leg 1: leg 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-route', fromOrdinal: 1 },
            getAuthIdentityScope(),
        );
    });

    it('closes the return-trip controls with the rest of A when B signs in', () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Trip · Legs: pick a trip or route to continue' }), {
            target: { value: 'account-a-trip' },
        });
        expect(screen.getByRole('button', { name: /^Plan the return trip/ })).toBeInTheDocument();
        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(screen.queryByRole('button', { name: /^Plan the return trip/ })).not.toBeInTheDocument();
        expect(mocks.requestTracerOpen).not.toHaveBeenCalled();
    });
});
