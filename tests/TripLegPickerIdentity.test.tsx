import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    requestTracerOpen: vi.fn(),
    triggerHaptic: vi.fn(),
}));

vi.mock('../services/deepLink', () => ({
    requestTracerOpen: mocks.requestTracerOpen,
}));

vi.mock('../utils/system', () => ({
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
    return {
        loadSavedTraces: vi.fn((scope: { userId: string | null }) => (scope.userId ? [traceFor(scope.userId)] : [])),
        groupTracesByTrip: vi.fn(
            (traces: Array<{ id: string; name: string; points: Array<{ lat: number; lon: number }> }>) =>
                traces.map((trace) => ({ key: trace.id, label: trace.name, legs: [trace] })),
        ),
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

        fireEvent.change(screen.getByRole('combobox', { name: 'Pick a trip or route to continue' }), {
            target: { value: 'account-a-route' },
        });
        fireEvent.click(screen.getByRole('button', { name: /ACCOUNT-A private route/ }));

        expect(mocks.requestTracerOpen).toHaveBeenCalledWith({ kind: 'load-saved', id: 'account-a-route' }, accountA);
        expect(onOpenChart).toHaveBeenCalledOnce();
    });

    it('closes A UI and replaces its private route snapshot synchronously for B', () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        fireEvent.change(screen.getByRole('combobox', { name: 'Pick a trip or route to continue' }), {
            target: { value: 'account-a-route' },
        });
        expect(screen.getByRole('dialog', { name: /ACCOUNT-A private route/ })).toBeInTheDocument();

        let accountB!: ReturnType<typeof getAuthIdentityScope>;
        act(() => {
            accountB = setAuthIdentityScope('account-b');
        });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByText(/ACCOUNT-A private route/)).not.toBeInTheDocument();
        const picker = screen.getByRole('combobox', { name: 'Pick a trip or route to continue' });
        expect(picker).toHaveTextContent('ACCOUNT-B private route');

        fireEvent.change(picker, { target: { value: 'account-b-route' } });
        fireEvent.click(screen.getByRole('button', { name: /ACCOUNT-B private route/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'load-saved', id: 'account-b-route' },
            accountB,
        );
    });
});
