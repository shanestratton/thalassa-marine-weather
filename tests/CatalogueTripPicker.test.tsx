import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogueTripPicker } from '../components/dayPlanner/CatalogueTripPicker';
import type { CatalogueDetail, CatalogueSummary } from '../services/dayPlanner/catalogue';
import type { CataloguePlanSelection } from '../services/dayPlanner/cataloguePlanningTypes';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mock = vi.hoisted(() => ({ discover: vi.fn(), detail: vi.fn(), change: vi.fn(), ready: vi.fn() }));
vi.mock('../services/dayPlanner/cataloguePlanning', () => ({
    discoverCatalogueChoices: (...args: unknown[]) => mock.discover(...args),
    loadCatalogueChoice: (...args: unknown[]) => mock.detail(...args),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const position = { lat: -20.2, lon: 148.9 };
const review = { reviewedAt: '2026-09-01T00:00:00Z', reviewDueAt: '2026-10-01T00:00:00Z' };
const summaries: CatalogueSummary[] = [
    {
        id: id(1),
        version: 2,
        kind: 'trip',
        name: 'Island trip',
        summary: 'Trip reference',
        position,
        distanceNM: 1,
        review,
    },
    {
        id: id(2),
        version: 3,
        kind: 'destination',
        name: 'Island stop',
        summary: 'Stop reference',
        position,
        distanceNM: 2,
        review,
    },
];
const common = {
    name: 'Island',
    summary: 'Source-backed visit',
    position,
    review: { ...review, reviewerLabel: 'Editor', scope: 'Source facts' },
    evidence: [],
    limitations: ['Access is unverified.'],
    activities: [],
};
const trip: CatalogueDetail = {
    ...common,
    kind: 'trip',
    id: id(1),
    version: 2,
    origin: { id: id(10), version: 1 },
    destination: { id: id(2), version: 3 },
    variantsTruncated: false,
    variants: [
        { id: id(3), version: 4, direction: 'outbound', name: 'Outer outbound' },
        { id: id(4), version: 5, direction: 'return', name: 'Inner return' },
    ],
};
const destination: CatalogueDetail = { ...common, kind: 'destination', id: id(2), version: 3 };
const key = (n: number, version: number) => `${id(n)}:${version}`;

function Harness({
    enabled = true,
    point = position,
    mode = 'return',
}: {
    enabled?: boolean;
    point?: typeof position;
    mode?: 'return' | 'overnight';
}) {
    const [value, setValue] = useState<CataloguePlanSelection | null>(null);
    return (
        <CatalogueTripPicker
            position={point}
            enabled={enabled}
            mode={mode}
            value={value}
            onChange={(next) => {
                mock.change(next);
                setValue(next);
            }}
            onReadyChange={mock.ready}
        />
    );
}
async function browse() {
    fireEvent.click(screen.getByRole('button', { name: 'Browse shared catalogue' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Shared destination or trip' })).toBeEnabled());
    await screen.findByRole('option', { name: 'Island trip · trip' });
}
async function chooseTrip() {
    await browse();
    fireEvent.change(screen.getByRole('combobox', { name: 'Shared destination or trip' }), {
        target: { value: key(1, 2) },
    });
}
beforeEach(() => {
    setAuthIdentityScope('catalogue-picker-owner');
    mock.discover.mockReset().mockResolvedValue({ status: 'ready', summaries, message: 'Nearby reviewed references.' });
    mock.detail.mockReset().mockImplementation(async (ref: { id: string }) => (ref.id === id(1) ? trip : destination));
    mock.change.mockReset();
    mock.ready.mockReset();
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('CatalogueTripPicker', () => {
    it('does not send a position when there is no authenticated scope', () => {
        setAuthIdentityScope(null);
        render(<Harness />);
        expect(screen.getByRole('button', { name: 'Browse shared catalogue' })).toBeDisabled();
        expect(mock.discover).not.toHaveBeenCalled();
    });
    it('waits for an explicit browse action and a confirmed authenticated departure', async () => {
        const view = render(<Harness enabled={false} />);
        expect(screen.getByRole('button', { name: 'Browse shared catalogue' })).toBeDisabled();
        expect(mock.discover).not.toHaveBeenCalled();
        view.rerender(<Harness />);
        expect(mock.discover).not.toHaveBeenCalled();
        await browse();
        expect(mock.discover).toHaveBeenCalledOnce();
        expect(mock.detail).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole('combobox', { name: 'Shared destination or trip' }), {
            target: { value: key(2, 3) },
        });
        await screen.findByText('No reviewed local route available · calculate and check a new route.');
        expect(mock.detail).toHaveBeenCalledWith({ id: id(2), version: 3 }, expect.any(AbortSignal));
        expect(mock.ready).toHaveBeenLastCalledWith(true);
    });

    it('defaults only unique directional variants and never downloads their geometry', async () => {
        render(<Harness />);
        await chooseTrip();
        expect(await screen.findByRole('combobox', { name: 'Outbound route reference' })).toHaveValue(key(3, 4));
        expect(screen.getByRole('combobox', { name: 'Return route reference' })).toHaveValue(key(4, 5));
        expect(mock.change).toHaveBeenLastCalledWith({
            id: id(1),
            version: 2,
            outbound: { id: id(3), version: 4 },
            return: { id: id(4), version: 5 },
        });
        expect(mock.detail).toHaveBeenCalledOnce();
        expect(mock.ready).toHaveBeenLastCalledWith(true);
    });

    it('requires an explicit choice when outbound variants are ambiguous', async () => {
        mock.detail.mockResolvedValue({
            ...trip,
            variants: [...trip.variants, { id: id(5), version: 1, direction: 'outbound', name: 'Other outbound' }],
        });
        render(<Harness />);
        await chooseTrip();
        const outbound = await screen.findByRole('combobox', { name: 'Outbound route reference' });
        expect(outbound).toHaveValue('');
        expect(mock.ready).toHaveBeenLastCalledWith(false);
        fireEvent.change(outbound, { target: { value: key(5, 1) } });
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
        expect(mock.detail).toHaveBeenCalledOnce();
    });

    it('requires a separate return variant only when a return trip is requested', async () => {
        mock.detail.mockResolvedValue({
            ...trip,
            variants: trip.variants.filter((variant) => variant.direction === 'outbound'),
        });
        const view = render(<Harness />);
        await chooseTrip();
        await screen.findByRole('combobox', { name: 'Return route reference' });
        expect(screen.getByRole('option', { name: 'No reviewed route available' })).toBeInTheDocument();
        expect(mock.ready).toHaveBeenLastCalledWith(false);
        view.rerender(<Harness mode="overnight" />);
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
        view.rerender(<Harness mode="return" />);
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(false));
        expect(mock.detail).toHaveBeenCalledOnce();
    });

    it('keeps a failed choice selected and incomplete until explicitly cleared', async () => {
        mock.detail.mockRejectedValue(new Error('withdrawn'));
        render(<Harness />);
        await chooseTrip();
        await screen.findByText(/This selected reference is unavailable/);
        const selector = screen.getByRole('combobox', { name: 'Shared destination or trip' });
        expect(selector).toHaveValue(key(1, 2));
        expect(mock.ready).toHaveBeenLastCalledWith(false);
        fireEvent.change(selector, { target: { value: '' } });
        expect(mock.change).toHaveBeenLastCalledWith(null);
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
    });

    it.each([false, true])('keeps missing or truncated route choices incomplete (truncated=%s)', async (truncated) => {
        mock.detail.mockResolvedValue({
            ...trip,
            variants: truncated ? trip.variants : [],
            variantsTruncated: truncated,
        });
        render(<Harness />);
        await chooseTrip();
        await screen.findByText('Source-backed visit');
        expect(mock.ready).toHaveBeenLastCalledWith(false);
        expect(mock.change).not.toHaveBeenLastCalledWith(null);
        if (truncated)
            expect(
                screen.getByText('The route choices are incomplete. This trip cannot be selected.'),
            ).toBeInTheDocument();
        else expect(screen.getAllByRole('option', { name: 'No reviewed route available' })).toHaveLength(2);
    });

    it('aborts and ignores a late detail after a new destination is selected', async () => {
        let finish!: (detail: CatalogueDetail) => void;
        mock.detail.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        render(<Harness />);
        await chooseTrip();
        const signal = mock.detail.mock.calls[0][1] as AbortSignal;
        fireEvent.change(screen.getByRole('combobox', { name: 'Shared destination or trip' }), {
            target: { value: key(2, 3) },
        });
        await screen.findByText('No reviewed local route available · calculate and check a new route.');
        expect(signal.aborted).toBe(true);
        await act(async () => finish(trip));
        expect(screen.queryByRole('combobox', { name: 'Outbound route reference' })).toBeNull();
        expect(mock.change).toHaveBeenLastCalledWith({ id: id(2), version: 3 });
    });

    it('retries discovery and then the selected detail without a duplicate detail request', async () => {
        mock.detail.mockRejectedValueOnce(new Error('offline'));
        render(<Harness />);
        await chooseTrip();
        await screen.findByText(/This selected reference is unavailable/);
        fireEvent.click(screen.getByRole('button', { name: 'Retry shared catalogue' }));
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
        expect(mock.discover).toHaveBeenCalledTimes(2);
        expect(mock.detail).toHaveBeenCalledTimes(2);
    });

    it('invalidates the retained choice when its departure changes to an empty area', async () => {
        const view = render(<Harness />);
        await chooseTrip();
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
        const signal = mock.discover.mock.calls[0][1] as AbortSignal;
        mock.discover.mockResolvedValue({ status: 'empty', summaries: [], message: 'No references found.' });
        view.rerender(<Harness point={{ lat: -30, lon: 150 }} />);
        await screen.findByText(/No reviewed shared destination or trip is available nearby/);
        expect(signal.aborted).toBe(true);
        expect(screen.getByRole('combobox', { name: 'Shared destination or trip' })).toHaveValue(key(1, 2));
        expect(mock.ready).toHaveBeenLastCalledWith(false);
    });

    it('does not replace a withdrawn exact route reference with a newly sole variant on refresh', async () => {
        const view = render(<Harness />);
        await chooseTrip();
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
        mock.detail.mockResolvedValue({
            ...trip,
            variants: [
                { id: id(5), version: 1, direction: 'outbound', name: 'Replacement outbound' },
                trip.variants[1],
            ],
        });
        view.rerender(<Harness point={{ lat: -20.21, lon: 148.9 }} />);
        await screen.findByRole('option', { name: 'Selected route reference unavailable' });
        expect(screen.getByRole('combobox', { name: 'Outbound route reference' })).toHaveValue(key(3, 4));
        expect(mock.ready).toHaveBeenLastCalledWith(false);
        fireEvent.change(screen.getByRole('combobox', { name: 'Outbound route reference' }), {
            target: { value: key(5, 1) },
        });
        await waitFor(() => expect(mock.ready).toHaveBeenLastCalledWith(true));
    });

    it.each(['account', 'unmount'] as const)('aborts pending discovery on %s and ignores its result', async (cause) => {
        let finish!: (value: unknown) => void;
        mock.discover.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const view = render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Browse shared catalogue' }));
        const signal = mock.discover.mock.calls[0][1] as AbortSignal;
        if (cause === 'account') act(() => setAuthIdentityScope('other-owner'));
        else view.unmount();
        expect(signal.aborted).toBe(true);
        await act(async () => finish({ status: 'ready', summaries, message: 'Late result' }));
        expect(screen.queryByText('Late result')).toBeNull();
        expect(mock.detail).not.toHaveBeenCalled();
    });

    it('distinguishes unavailable coverage from an empty catalogue', async () => {
        mock.discover.mockRejectedValue(new Error('offline'));
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Browse shared catalogue' }));
        await screen.findByText('The shared catalogue is unavailable. Its coverage could not be checked.');
        expect(screen.queryByText(/No reviewed shared destination or trip is available nearby/)).toBeNull();
    });
});
