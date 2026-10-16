import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ load: vi.fn(), reviewWait: vi.fn(), accept: vi.fn(), dispose: vi.fn() }));
vi.mock('../services/routing/passageTideReview', () => ({ loadPassageTideReview: m.load }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (s: unknown) => unknown) =>
        selector({ settings: { vessel: { draft: 2 }, satelliteMode: false } }),
}));
import PassageTideReview from '../components/map/PassageTideReview';
const T = Date.parse('2026-10-17T08:00:23.456Z');
const pins = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.1 },
];
const session = () => ({
    isCurrent: () => true,
    dispose: m.dispose,
    reviewWait: m.reviewWait,
    acceptWait: m.accept,
    report: {
        identity: 'test',
        pointIndex: 1,
        point: pins[1],
        atMs: T + 3600000,
        loadedAtMs: T,
        expiresAtMs: T + 300000,
        mode: 'aboard',
        chart: {
            chartVersion: 1,
            contentKey: 'PRIVATE-CELL',
            completeInventory: true,
            aboardOnly: true,
            soundingDatum: 'LAT',
            soundingDatumEpoch: null,
            pointDepthM: 5,
            holdingText: 'Nearby chart sample as sand.',
            holdingPointSample: true,
            bridges: [],
            notes: ['No reviewed station-to-cell epoch tie.'],
        },
        stations: [
            {
                id: 'sample',
                name: 'Actual provider station',
                provider: 'WorldTides',
                kind: 'sampled-prediction',
                distanceKm: 1.2,
                datum: 'MSL',
                datumEpoch: null,
                heightAtEtaM: 1.2,
                originalIssueMs: null,
                receivedAtMs: T,
                publicationAtMs: null,
                events: [],
                note: 'WorldTides navigation permission is unverified.',
                credit: 'Test copyright',
            },
        ],
        notes: ['No averaging across untied datums.'],
    },
});
describe('usable bounded passage tide review UI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        m.load.mockImplementation(async () => session());
        m.reviewWait.mockResolvedValue({ kind: 'unavailable', reason: 'Missing complete holding evidence.' });
    });
    it('waits for an explicit action, preserves the exact original departure and shows separate source/datum/rights unknowns', async () => {
        const view = render(<PassageTideReview pins={pins} identity="route-a" departureMs={T} cruisingSpeedKts={6} />);
        expect(m.load).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Read aboard' }));
        await screen.findByTestId('passage-tide-review-results');
        expect(m.load.mock.calls[0][0]).toMatchObject({ mode: 'aboard', departureMs: T, pointIndex: 1, speedKts: 6 });
        expect(screen.getByText(/WorldTides navigation permission is unverified/)).toBeTruthy();
        expect(screen.getByText(/Original prediction issue: unknown/)).toBeTruthy();
        expect(screen.getByText(/Tide-adjusted depth.*unknown/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Accept Wait/ })).toBeNull();
        view.unmount();
        expect(m.dispose).toHaveBeenCalledTimes(1);
    });
    it('keeps the loaded report while wait limits are edited and passes explicit caps to review', async () => {
        render(<PassageTideReview pins={pins} identity="route-a" departureMs={T} cruisingSpeedKts={6} />);
        fireEvent.click(screen.getByRole('button', { name: 'Read aboard' }));
        await screen.findByTestId('passage-tide-review-results');
        fireEvent.change(screen.getByLabelText('UKC (m)'), { target: { value: '0.8' } });
        expect(screen.getByTestId('passage-tide-review-results')).toBeTruthy();
        expect(m.dispose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Review wait evidence' }));
        await screen.findByText('Missing complete holding evidence.');
        expect(m.reviewWait).toHaveBeenCalledWith(0, 60, 100, {
            draftM: 2,
            ukcM: 0.8,
            maxWindKts: 15,
            maxGustKts: 20,
            maxWaveM: 1,
        });
    });
    it('drops a late wait result after a policy edit and retires the report on a new route', async () => {
        let resolve!: (v: unknown) => void;
        m.reviewWait.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const view = render(<PassageTideReview pins={pins} identity="route-a" departureMs={T} cruisingSpeedKts={6} />);
        fireEvent.click(screen.getByRole('button', { name: 'Read aboard' }));
        await screen.findByTestId('passage-tide-review-results');
        fireEvent.click(screen.getByRole('button', { name: 'Review wait evidence' }));
        fireEvent.change(screen.getByLabelText('Wind limit (kt)'), { target: { value: '12' } });
        await act(async () => resolve({ kind: 'unavailable', reason: 'STALE WAIT RESULT' }));
        expect(screen.queryByText('STALE WAIT RESULT')).toBeNull();
        view.rerender(<PassageTideReview pins={pins} identity="route-b" departureMs={T} cruisingSpeedKts={6} />);
        await waitFor(() => expect(screen.queryByTestId('passage-tide-review-results')).toBeNull());
        expect(m.dispose).toHaveBeenCalled();
    });
});
