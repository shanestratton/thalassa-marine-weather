/**
 * The customs card loads its clearance guide from the packaged data file
 * (public/data/customs-clearance.json, build 126 bundle diet) the first time
 * it opens, and paints straight from memory after that.
 *
 * The tabs are named from the synchronous port index at once, so the card
 * never flashes "Limited Data Available" while the guide is still loading,
 * and the readiness count only reports documents once there are documents
 * to count.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packagedFetch } from './helpers/packagedFetch';

vi.mock('../hooks/useReadinessSync', async () => {
    const { useState } = await import('react');
    return {
        useScopedReadinessStorageState: <T,>(_key: string, _voyage: string | undefined, initial: T) =>
            useState<T>(initial),
        useReadinessSync: () => ({ syncCheck: vi.fn() }),
    };
});

const GUIDE_URL = '/data/customs-clearance.json';

const plan = (departingCountry: string, destinationCountry: string) =>
    ({ customs: { required: true, departingCountry, destinationCountry } }) as never;

let fetchMock: ReturnType<typeof packagedFetch>;

beforeEach(() => {
    vi.resetModules();
    fetchMock = packagedFetch();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('CustomsClearanceCard loads its JSON', () => {
    it('names both countries at once, then shows the guide from the packaged file', async () => {
        const { CustomsClearanceCard } = await import('../components/passage/CustomsClearanceCard');
        const onCheckedChange = vi.fn();
        render(
            <CustomsClearanceCard
                voyageId="voyage-a"
                voyagePlan={plan('Falmouth, UK', 'Lisbon, Portugal')}
                onCheckedChange={onCheckedChange}
            />,
        );

        // Named from the synchronous index before the guide arrives.
        expect(screen.getByRole('button', { name: 'Departing United Kingdom' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Arriving Portugal' })).toBeInTheDocument();
        expect(screen.queryByText('Limited Data Available')).not.toBeInTheDocument();

        expect(await screen.findByText('Submit C1331 departure form to HMRC (HM Revenue & Customs)')).toBeVisible();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(GUIDE_URL);

        // UK documents (6) plus Portugal's, none ticked yet.
        await waitFor(() => expect(onCheckedChange).toHaveBeenLastCalledWith(expect.any(Number), 0));
        const [total] = onCheckedChange.mock.calls.at(-1)!;
        expect(total).toBeGreaterThan(6);
        expect(onCheckedChange).not.toHaveBeenCalledWith(0, 0);
    });

    it('a second card paints from memory without another fetch', async () => {
        const { CustomsClearanceCard } = await import('../components/passage/CustomsClearanceCard');
        const first = render(<CustomsClearanceCard voyagePlan={plan('Opua, NZ', 'Suva, Fiji')} />);
        expect(await screen.findByText('Complete Customs Departure form (NZCS 5)')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        first.unmount();

        render(<CustomsClearanceCard voyagePlan={plan('Las Palmas, Spain', 'Mindelo, Cabo Verde')} />);
        expect(screen.getByRole('button', { name: 'Departing Spain' })).toBeInTheDocument();
        expect(screen.getByText('No formal departure clearance for Schengen/EU travel')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('warns about a port that is not a port of entry on the first paint, and when the guide cannot be read', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
        const { CustomsClearanceCard } = await import('../components/passage/CustomsClearanceCard');
        render(<CustomsClearanceCard voyagePlan={plan('Whangaroa, NZ', 'Suva, Fiji')} />);

        // Before the guide has answered: the banner needs only the index.
        expect(screen.getByText('Whangaroa, NZ is not a designated port of entry')).toBeInTheDocument();
        expect(screen.getByText(/one of New Zealand's designated ports of entry before departing/)).toBeInTheDocument();
        expect(screen.getByText('Opua')).toBeInTheDocument();

        // The guide could not be read: the banner and its ports stay.
        expect(await screen.findByText('Clearance Guide Unavailable')).toBeInTheDocument();
        expect(screen.getByText('Whangaroa, NZ is not a designated port of entry')).toBeInTheDocument();
        expect(screen.getByText('Lyttelton')).toBeInTheDocument();

        // Arriving at a port of entry: no banner.
        screen.getByRole('button', { name: 'Arriving Fiji' }).click();
        await waitFor(() => expect(screen.queryByText(/is not a designated port of entry/)).not.toBeInTheDocument());
    });

    it('says so when the guide cannot be read, and keeps the plan notes', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
        const { CustomsClearanceCard } = await import('../components/passage/CustomsClearanceCard');
        render(<CustomsClearanceCard voyagePlan={plan('Marmaris, Türkiye', 'Rhodes, Greece')} />);
        expect(await screen.findByText(/clearance guide could not be loaded/i)).toBeInTheDocument();
    });
});
