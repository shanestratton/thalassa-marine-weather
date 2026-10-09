/**
 * The Plan page's Trip · Legs tile and the Trip sheet it opens are fenced by
 * the account that owned the rows (126-16a: a button and a lazy sheet, no
 * longer a select and a modal). Every request carries the generation its rows
 * were built under, and an account change closes the sheet and replaces the
 * private snapshot at the synchronous fence. Fictional routes.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

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
vi.mock('../components/passage/SeasonRiskCard', () => ({ default: () => null }));

import { TripLegPicker } from '../components/passage/TripLegPicker';

/** One private route and a fictional two-leg trip per account. */
function seed(owner: string): void {
    const scope = setAuthIdentityScope(owner);
    localStorage.setItem(
        authScopedStorageKey('thalassa_traced_routes_v1', scope),
        JSON.stringify([
            {
                id: `${owner}-route`,
                name: `${owner.toUpperCase()} private route`,
                createdAt: '2026-07-22T00:00:00.000Z',
                points: [
                    { lat: -27.4, lon: 153.0 },
                    { lat: -27.2, lon: 153.2 },
                ],
            },
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
        ]),
    );
}

async function openTrip(name: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: 'Trip · Legs' }));
    const sheet = await screen.findByRole('dialog', { name: 'Your trips' });
    fireEvent.click(within(sheet).getByRole('button', { name }));
    return screen.getByRole('dialog');
}

describe('TripLegPicker identity fence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        setAuthIdentityScope(null);
        seed('account-b');
        seed('account-a');
    });

    it('is a button named like its title, describing what is saved', () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        const tile = screen.getByRole('button', { name: 'Trip · Legs' });
        expect(tile).toHaveAccessibleDescription('2 saved · pick one to continue');
        expect(tile).toHaveAttribute('aria-haspopup', 'dialog');
        expect(tile).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('passes the exact generation that owned the loaded route', async () => {
        const accountA = getAuthIdentityScope();
        const onOpenChart = vi.fn();
        render(<TripLegPicker onOpenChart={onOpenChart} />);
        const trip = await openTrip(/^ACCOUNT-A private route/);
        fireEvent.click(within(trip).getByRole('button', { name: /^Leg 1: ACCOUNT-A private route/ }));

        expect(mocks.requestTracerOpen).toHaveBeenCalledWith({ kind: 'load-saved', id: 'account-a-route' }, accountA);
        expect(onOpenChart).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes A UI and replaces its private route snapshot synchronously for B', async () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        await openTrip(/^ACCOUNT-A private route/);
        expect(screen.getByRole('dialog', { name: /ACCOUNT-A private route/ })).toBeInTheDocument();

        let accountB!: ReturnType<typeof getAuthIdentityScope>;
        act(() => {
            accountB = setAuthIdentityScope('account-b');
        });

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByText(/ACCOUNT-A private route/)).not.toBeInTheDocument();
        const trip = await openTrip(/^ACCOUNT-B private route/);
        fireEvent.click(within(trip).getByRole('button', { name: /^Leg 1: ACCOUNT-B private route/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'load-saved', id: 'account-b-route' },
            accountB,
        );
    });

    it('the return-trip row and the per-leg chips pass the generation that owned the trip', async () => {
        const accountA = getAuthIdentityScope();
        const onOpenChart = vi.fn();
        render(<TripLegPicker onOpenChart={onOpenChart} />);
        let dialog = await openTrip(/^Harbour - Sandy Cove/);
        fireEvent.click(within(dialog).getByRole('button', { name: /^⇄ Plan the return trip/ }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-trip' },
            accountA,
        );

        dialog = await openTrip(/^Harbour - Sandy Cove/);
        // Leg 2 arrives at Sandy Cove (parsed from its name); leg 1 carries Bay Point.
        fireEvent.click(within(dialog).getByRole('button', { name: 'Return from Sandy Cove: legs 2 to 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-trip', fromOrdinal: 2 },
            accountA,
        );
        dialog = await openTrip(/^Harbour - Sandy Cove/);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Return from Bay Point: leg 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-trip', fromOrdinal: 1 },
            accountA,
        );
        expect(onOpenChart).toHaveBeenCalledTimes(3);
    });

    it('a one-leg route gets a chip but no return-trip row', async () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        const dialog = await openTrip(/^ACCOUNT-A private route/);
        expect(within(dialog).queryByRole('button', { name: /Plan the return trip/ })).not.toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Return from the end of leg 1: leg 1 reversed' }));
        expect(mocks.requestTracerOpen).toHaveBeenLastCalledWith(
            { kind: 'return-trip', tripId: 'account-a-route', fromOrdinal: 1 },
            getAuthIdentityScope(),
        );
    });

    it('closes the return-trip controls with the rest of A when B signs in', async () => {
        render(<TripLegPicker onOpenChart={vi.fn()} />);
        await openTrip(/^Harbour - Sandy Cove/);
        expect(screen.getByRole('button', { name: /^⇄ Plan the return trip/ })).toBeInTheDocument();
        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(screen.queryByRole('button', { name: /Plan the return trip/ })).not.toBeInTheDocument();
        expect(mocks.requestTracerOpen).not.toHaveBeenCalled();
    });

    it('a sheet that fails to load says so and leaves the Plan page standing', async () => {
        const { readFileSync } = await import('node:fs');
        const tile = readFileSync('components/passage/TripLegPicker.tsx', 'utf8');
        expect(tile).toContain("import { LazyTripSheet } from './LazyTripSheet'");
        expect(tile).not.toMatch(/^import .*['"]\.\/TripSheet['"]/m);
        const lazy = readFileSync('components/passage/LazyTripSheet.tsx', 'utf8');
        expect(lazy).toMatch(/React\.lazy\(\(\) => import\('\.\/TripSheet'\)\)/);
        expect(lazy).not.toMatch(/^import (?!type).*['"]\.\/TripSheet['"]/m);
        // Never lazyRetry's whole-app reload: a toast, and the page stays.
        expect(lazy).not.toMatch(/^import .*lazyRetry/m);
        expect(lazy).toMatch(/<ErrorBoundary[\s\S]*?fallback=\{RENDER_NOTHING\}[\s\S]*?onError=/);
        expect(lazy).toContain('toast.error(');
    });
});
