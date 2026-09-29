import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VesselProfile } from '../types/vessel';
import type { BoatFix } from '../services/boatPositionChain';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TrialRouteReview } from '../services/autoroutingReview';
import type { DayPlanLeg, DayPlanRequest, DayPlanResult } from '../services/dayPlanner/engine';
import type { CatalogueDetail, CatalogueSummary } from '../services/dayPlanner/catalogue';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';
import { autoroutingProposalGeometryKey } from '../services/autoroutingProposalEvidence';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { dayPlanInputTime, dayPlanTime, parseDayPlanInput } from '../services/dayPlanner/presentation';
import DayPlannerSheet from '../components/dayPlanner/DayPlannerSheet';
import { DayPlannerEntry } from '../components/dayPlanner/DayPlannerEntry';
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';

const mock = vi.hoisted(() => ({
    run: vi.fn(),
    locate: vi.fn(),
    save: vi.fn(),
    discover: vi.fn(),
    catalogueDetail: vi.fn(),
    inputs: vi.fn(),
    registry: 'charts',
    chartListeners: new Set<() => void>(),
    reviews: new Map<string, TrialRouteReview>(),
    delay: 0,
}));
vi.mock('../services/dayPlanner/runtime', () => ({
    runDayPlanner: (...args: unknown[]) => mock.run(...args),
    dayPlannerVesselInputs: (vessel: VesselProfile) => mock.inputs(vessel),
}));
vi.mock('../services/dayPlanner/save', () => ({
    saveDayPlanWithCatalogueCheck: (...args: unknown[]) => mock.save(...args),
}));
vi.mock('../services/dayPlanner/cataloguePlanning', () => ({
    discoverCatalogueChoices: (...args: unknown[]) => mock.discover(...args),
    loadCatalogueChoice: (...args: unknown[]) => mock.catalogueDetail(...args),
}));
vi.mock('../services/plannerVesselPosition', () => ({
    PLANNER_LIVE_FIX_MS: 60_000,
    readPlannerVesselPosition: () => mock.locate(),
    plannerVesselLabel: () => 'Yacht position report',
}));
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    getRegistryFingerprint: () => mock.registry,
    subscribe: (listener: () => void) => {
        mock.chartListeners.add(listener);
        return () => mock.chartListeners.delete(listener);
    },
}));
vi.mock('../components/autorouting/AutoroutingTrialWorkspace', () => ({
    AutoroutingTrialWorkspace: ({
        reviewProposal,
        onReviewChange,
        onClose,
    }: {
        reviewProposal: AutoroutingTrialRoute;
        onReviewChange: (review: TrialRouteReview | null) => void;
        onClose: () => void;
    }) => (
        <div role="dialog" aria-label="Mock ENC review">
            <button
                onClick={() => {
                    onReviewChange(mock.reviews.get(reviewProposal.id)!);
                    onClose();
                }}
            >
                Complete chart review
            </button>
            <button
                onClick={() => {
                    onReviewChange(null);
                    onClose();
                }}
            >
                Close unfinished review
            </button>
        </div>
    ),
}));

const NOW = Date.parse('2026-09-27T00:00:00Z');
const HOUR = 3_600_000;
const vessel: VesselProfile = {
    name: 'Test yacht',
    type: 'sail',
    length: 40,
    beam: 12,
    draft: 6,
    displacement: 10000,
    airDraft: 50,
    hullType: 'monohull',
    cruisingSpeed: 6,
    maxWindSpeed: 20,
    maxWaveHeight: 6,
};
const freshFix: BoatFix = { latitude: -20.2, longitude: 148.99, timestamp: NOW, rung: 'bus' };
const sharedId = '00000000-0000-4000-8000-000000000001';
const outboundRef = { id: '00000000-0000-4000-8000-000000000002', version: 2 };
const returnRef = { id: '00000000-0000-4000-8000-000000000003', version: 3 };
function sharedTrip() {
    const review = {
        reviewedAt: new Date(NOW - HOUR).toISOString(),
        reviewDueAt: new Date(NOW + 24 * HOUR).toISOString(),
    };
    const summary: CatalogueSummary = {
        id: sharedId,
        version: 1,
        kind: 'trip',
        name: 'Shared island trip',
        summary: 'A catalogue reference',
        position: { lat: -20.2, lon: 148.99 },
        distanceNM: 0,
        review,
    };
    const detail: CatalogueDetail = {
        ...summary,
        kind: 'trip',
        review: { ...review, reviewerLabel: 'Editor', scope: 'Public source reference' },
        evidence: [],
        limitations: ['Local conditions remain unassessed.'],
        activities: [],
        origin: { id: '00000000-0000-4000-8000-000000000004', version: 1 },
        destination: { id: '00000000-0000-4000-8000-000000000005', version: 1 },
        variantsTruncated: false,
        variants: [
            { ...outboundRef, direction: 'outbound', name: 'Outbound reference' },
            { ...returnRef, direction: 'return', name: 'Return reference' },
        ],
    };
    mock.discover.mockResolvedValue({ status: 'ready', summaries: [summary], message: 'One shared trip nearby.' });
    mock.catalogueDetail.mockResolvedValue(detail);
}
async function chooseSharedTrip() {
    await locate();
    fireEvent.click(screen.getByRole('button', { name: 'Browse shared catalogue' }));
    await screen.findByRole('option', { name: 'Shared island trip · trip' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Shared destination or trip' }), {
        target: { value: `${sharedId}:1` },
    });
    await screen.findByRole('combobox', { name: 'Outbound route reference' });
}

function resultFor(request: DayPlanRequest, offset = mock.delay): DayPlanResult {
    const destination = WHITSUNDAYS_DAY_DESTINATIONS[0];
    const departureMs = request.departureMs + offset;
    const arrivalMs = departureMs + HOUR / 2;
    const stayToMs = request.mode === 'return' ? arrivalMs + request.stopHours * HOUR : request.overnightUntilMs!;
    const makeLeg = (index: number): DayPlanLeg => {
        const from = index ? destination : request.start;
        const to = index ? request.start : destination;
        const profile = snapshotAutoroutingVesselProfile(vessel);
        const route: AutoroutingTrialRoute = {
            id: `route-${index}`,
            provider: 'SevenCs',
            createdAt: new Date(NOW).toISOString(),
            coordinates: [
                [from.lon, from.lat],
                [to.lon, to.lat],
            ],
            warnings: [],
            providerCheck: { status: 'not-reported', findings: [] },
            vesselProfile: profile,
        };
        const review: TrialRouteReview = {
            phase: 'complete',
            basis: {
                proposalId: route.id,
                geometryKey: autoroutingProposalGeometryKey(route.coordinates),
                draftM: request.draftM,
                draftAssumed: false,
                registryFingerprint: mock.registry,
                vesselProfileKey: JSON.stringify(profile),
                checkedAt: new Date(NOW).toISOString(),
            },
            legs: [
                {
                    incomplete: false,
                    verdict: {
                        grade: 'clear',
                        issues: [],
                        minDepthM: 8,
                        minAt: null,
                        needsTide: false,
                        nudge: null,
                        nudgeTo: null,
                    },
                },
            ],
        };
        mock.reviews.set(route.id, review);
        return {
            route,
            review,
            distanceNM: 3,
            departureMs: index ? stayToMs : departureMs,
            arrivalMs: index ? stayToMs + HOUR / 2 : arrivalMs,
        };
    };
    const legs = request.mode === 'return' ? [makeLeg(0), makeLeg(1)] : [makeLeg(0)];
    return {
        calculatedAt: NOW,
        excluded: [],
        options: [
            {
                id: 'whitehaven-option',
                candidate: { destination, place: { ...destination, kind: 'anchorage' } },
                legs,
                departureMs,
                arrivalMs,
                stayFromMs: arrivalMs,
                stayToMs,
                finishMs: request.mode === 'return' ? stayToMs + HOUR / 2 : stayToMs,
                sailingHours: legs.length / 2,
                distanceNM: legs.length * 3,
                conditions: {
                    light: 'green',
                    reasons: ['Stay forecast checked.'],
                    fromMs: arrivalMs,
                    toMs: stayToMs,
                    fetchedAt: NOW,
                },
                transit: { light: 'green', reasons: ['Transit forecast checked.'], fetchedAt: NOW },
                routeCheck: { light: 'amber', reasons: ['Review provider coverage.'] },
                light: 'amber',
                warnings: ['Check all access restrictions.'],
            },
        ],
    };
}

function mount(value: VesselProfile | null = vessel) {
    const props = { vessel: value, mapboxToken: 'test-token', onClose: vi.fn(), onOpenSaved: vi.fn() };
    return { ...render(<DayPlannerSheet {...props} />), props };
}
async function locate() {
    await waitFor(() => expect(screen.getByLabelText('Latitude')).toHaveValue(freshFix.latitude));
}
async function calculate() {
    await locate();
    fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
    await screen.findByRole('button', { name: 'Review in Plan' });
}
async function reviewNext() {
    fireEvent.click(screen.getAllByRole('button', { name: 'Open ENC review' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Complete chart review' }));
    await screen.findByRole('button', { name: 'Save both legs' });
}
function advanceReportClock(milliseconds: number) {
    vi.mocked(Date.now).mockReturnValue(NOW + milliseconds);
    act(() => mock.chartListeners.forEach((listener) => listener()));
}

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    localStorage.clear();
    setAuthIdentityScope('planner-owner');
    mock.registry = 'charts';
    mock.delay = 0;
    mock.reviews.clear();
    mock.chartListeners.clear();
    mock.locate.mockReset().mockResolvedValue(freshFix);
    mock.inputs.mockReset().mockImplementation((value: VesselProfile) => {
        if (!value.draft || !value.cruisingSpeed) throw new Error('Set vessel draft and cruising speed first.');
        return { draftM: value.draft / 3.28084, speedKts: value.cruisingSpeed, maxWindKts: 20, maxWaveM: 1.8 };
    });
    mock.run.mockReset().mockImplementation(async (request: DayPlanRequest) => resultFor(request));
    mock.save.mockReset().mockReturnValue({
        traces: [{ id: 'saved-first' }, { id: 'saved-second' }],
        cloud: Promise.resolve(['ok', 'ok']),
    });
    mock.discover
        .mockReset()
        .mockResolvedValue({ status: 'empty', summaries: [], message: 'No nearby shared references.' });
    mock.catalogueDetail.mockReset();
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('DayPlannerSheet position and request ownership', () => {
    it('offers only the local catalogue and accepts no activity preference by default', async () => {
        mount();
        await locate();
        const destination = screen.getByRole('combobox', { name: 'Destination' });
        expect(destination).toHaveValue('');
        expect(
            within(destination)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['All local destinations', ...WHITSUNDAYS_DAY_DESTINATIONS.map((item) => item.name)]);
        expect(screen.getByRole('button', { name: 'No preference' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('Sailing limit covers both legs. Stop time is extra.')).toBeInTheDocument();
        await calculate();
        expect(mock.run.mock.calls[0][0].activities).toEqual([]);
        expect(mock.run.mock.calls[0][0]).not.toHaveProperty('destinationIds');
        expect(screen.getByText('No activity preference')).toBeInTheDocument();
    });

    it('sends the explicit destination even with unmatched activity preferences and clears it for all destinations', async () => {
        mount();
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Snorkel' }));
        fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), {
            target: { value: 'whitehaven-beach' },
        });
        expect(
            screen.getByText('Your chosen destination is checked even if activities do not match.'),
        ).toBeInTheDocument();
        await calculate();
        expect(mock.run.mock.calls[0][0]).toMatchObject({
            destinationIds: ['whitehaven-beach'],
            activities: ['snorkel'],
        });
        expect(screen.getByText('Your chosen destination · activities do not filter this stop')).toBeInTheDocument();
        expect(screen.queryByText(/^Matches:/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
        fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'No preference' }));
        await calculate();
        expect(mock.run.mock.calls[1][0]).not.toHaveProperty('destinationIds');
        expect(mock.run.mock.calls[1][0].activities).toEqual([]);
    });

    it('clears a selected destination when departure leaves reviewed coverage', async () => {
        mount();
        await locate();
        fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), {
            target: { value: 'whitehaven-beach' },
        });
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-22.278' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '166.439' } });
        await screen.findByText(/Departure-area time: Pacific\/Noumea/);
        expect(screen.queryByRole('combobox', { name: 'Destination' })).toBeNull();
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-20.2' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '148.99' } });
        await screen.findByText(/Departure-area time: Australia\/Brisbane/);
        expect(screen.getByRole('combobox', { name: 'Destination' })).toHaveValue('');
    });

    it.each([
        { latitude: -22.278, longitude: 166.439, outsideCoverage: true },
        { latitude: -20.3, longitude: 148.98, outsideCoverage: false },
    ])('aborts a pending result if a yacht-position refresh changes departure (%j)', async (position) => {
        let finishPosition!: (value: BoatFix) => void;
        let finishPlan!: (value: DayPlanResult) => void;
        mount();
        await locate();
        fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), {
            target: { value: 'whitehaven-beach' },
        });
        mock.locate.mockReturnValue(
            new Promise<BoatFix>((resolve) => {
                finishPosition = resolve;
            }),
        );
        mock.run.mockReturnValue(
            new Promise<DayPlanResult>((resolve) => {
                finishPlan = resolve;
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Use yacht position' }));
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        const [request, , options] = mock.run.mock.calls[0];
        await act(async () => finishPosition({ ...freshFix, ...position }));
        expect(options.signal.aborted).toBe(true);
        await act(async () => finishPlan(resultFor(request)));
        expect(screen.queryByRole('button', { name: 'Review in Plan' })).toBeNull();
        if (position.outsideCoverage) expect(screen.queryByRole('combobox', { name: 'Destination' })).toBeNull();
        else expect(screen.getByRole('combobox', { name: 'Destination' })).toHaveValue('whitehaven-beach');
        expect(mock.save).not.toHaveBeenCalled();
    });

    it('uses the yacht area timezone and only offers honest mapped-stop activities outside reviewed coverage', async () => {
        mock.locate.mockResolvedValue({ ...freshFix, latitude: -22.278, longitude: 166.439 });
        mount();
        await screen.findByText(/Departure-area time: Pacific\/Noumea/);
        expect(screen.getByLabelText('Leave at')).toHaveValue('2026-09-27T11:30');
        expect(screen.getByRole('button', { name: 'Explore mapped stops' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByRole('button', { name: 'Snorkel' })).toBeNull();
        expect(screen.getByLabelText('Destination coverage')).toHaveTextContent('local details unverified');
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        await screen.findByRole('button', { name: 'Review in Plan' });
        expect(mock.run).toHaveBeenCalledWith(
            expect.objectContaining({
                departureMs: NOW + HOUR / 2,
                timeZone: 'Pacific/Noumea',
                activities: ['explore'],
            }),
            vessel,
            expect.anything(),
        );
    });

    it('preserves chosen departure and deadline instants when changing cruising area and restores reviewed activity choices', async () => {
        mount();
        await locate();
        fireEvent.change(screen.getByLabelText('Leave at'), { target: { value: '2026-09-27T14:00' } });
        fireEvent.change(screen.getByLabelText('Back by (optional)'), { target: { value: '2026-09-27T19:00' } });
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-22.278' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '166.439' } });
        await screen.findByText(/Departure-area time: Pacific\/Noumea/);
        expect(screen.getByLabelText('Leave at')).toHaveValue('2026-09-27T15:00');
        expect(screen.getByLabelText('Back by (optional)')).toHaveValue('2026-09-27T20:00');
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-20.2' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '148.99' } });
        await screen.findByText(/Departure-area time: Australia\/Brisbane/);
        expect(screen.getByLabelText('Leave at')).toHaveValue('2026-09-27T14:00');
        expect(screen.getByLabelText('Back by (optional)')).toHaveValue('2026-09-27T19:00');
        expect(screen.getByRole('button', { name: 'No preference' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByRole('button', { name: 'Explore mapped stops' })).toBeNull();
    });

    it('rejects ambiguous daylight-saving departure times before any provider calculation', async () => {
        const now = Date.parse('2026-10-31T12:00:00Z');
        vi.mocked(Date.now).mockReturnValue(now);
        mock.locate.mockResolvedValue({ ...freshFix, latitude: 40.7, longitude: -74, timestamp: now });
        mount();
        await screen.findByText(/Departure-area time: America\/New_York/);
        fireEvent.change(screen.getByLabelText('Leave at'), { target: { value: '2026-11-01T01:30' } });
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('unambiguous local date and time');
        expect(mock.run).not.toHaveBeenCalled();
    });

    it('keeps mapped provenance and coverage limitations visible in results and never invents a reviewed date', async () => {
        mock.locate.mockResolvedValue({ ...freshFix, latitude: -22.278, longitude: 166.439 });
        mock.run.mockImplementation(async (request: DayPlanRequest) => {
            const result = resultFor(request);
            const option = result.options[0];
            option.candidate.destination = {
                ...option.candidate.destination,
                name: 'Synthetic mapped anchorage',
                activities: ['explore'],
                catalogueQuality: 'mapped-reference',
                verifiedAt: undefined,
                retrievedAt: new Date(NOW).toISOString(),
                timeZone: 'Pacific/Noumea',
            };
            option.light = 'unknown';
            option.conditions.light = 'unknown';
            result.coverage = {
                id: 'mapped-reference',
                name: 'Nearby mapped anchorages',
                type: 'mapped-reference',
                timeZone: request.timeZone!,
                sourceAttributions: ['OpenStreetMap contributors (ODbL)'],
                limitations: ['Limited nearby discovery, not a complete inventory.'],
            };
            return result;
        });
        mount();
        await screen.findByText(/Departure-area time: Pacific\/Noumea/);
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        await screen.findByRole('button', { name: 'Review in Plan' });
        expect(screen.getByLabelText('Plan coverage and time zone')).toHaveTextContent('local details unverified');
        expect(screen.getByText('Limited nearby discovery, not a complete inventory.')).toBeInTheDocument();
        expect(screen.getByText('Checks incomplete')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
        expect(screen.getByText(/Retrieval is not verification/)).toBeInTheDocument();
        expect(screen.queryByText(/Destination reference reviewed/)).toBeNull();
    });

    it('moves the default overnight end with departure but preserves a manually chosen end', async () => {
        mount();
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Stay overnight' }));
        const future = NOW + 4 * 24 * HOUR;
        fireEvent.change(screen.getByLabelText('Leave at'), { target: { value: dayPlanInputTime(future) } });
        expect(screen.getByLabelText('Stay until')).toHaveValue(
            `${dayPlanInputTime(future + 24 * HOUR).slice(0, 10)}T09:00`,
        );
        const chosen = dayPlanInputTime(future + 22 * HOUR);
        fireEvent.change(screen.getByLabelText('Stay until'), { target: { value: chosen } });
        fireEvent.change(screen.getByLabelText('Leave at'), { target: { value: dayPlanInputTime(future + HOUR) } });
        expect(screen.getByLabelText('Stay until')).toHaveValue(chosen);
    });
    it('autofills a fresh vessel position without requiring manual confirmation', async () => {
        mount();
        await locate();
        expect(screen.getByLabelText('Longitude')).toHaveValue(148.99);
        expect(screen.queryByRole('checkbox', { name: /Use this position/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        expect(mock.run).toHaveBeenCalledWith(
            expect.objectContaining({
                start: { lat: -20.2, lon: 148.99, label: 'Yacht position' },
                departureMs: NOW + HOUR / 2,
                mode: 'return',
                flexibleStart: false,
            }),
            vessel,
            expect.objectContaining({ signal: expect.any(AbortSignal), mapboxToken: 'test-token' }),
        );
        await screen.findByRole('button', { name: 'Review in Plan' });
    });

    it('requires explicit confirmation for a stale reported position', async () => {
        mock.locate.mockResolvedValue({ ...freshFix, timestamp: NOW - 120_000, rung: 'cloud' });
        mount();
        await locate();
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox', { name: /Use this position/ }));
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeEnabled();
    });

    it('does not substitute the phone location ashore, and confirms manually entered coordinates', async () => {
        mock.locate.mockResolvedValue(null);
        const phone = vi.spyOn(navigator.geolocation, 'getCurrentPosition');
        mount();
        await screen.findByText(/this device’s location is not substituted/);
        expect(screen.getByLabelText('Latitude')).toHaveValue(null);
        expect(phone).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-20.25' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '148.9' } });
        fireEvent.change(screen.getByLabelText('Departure name'), { target: { value: 'Chosen bay' } });
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox', { name: /Use this position/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        expect(mock.run.mock.calls[0][0].start).toEqual({ lat: -20.25, lon: 148.9, label: 'Chosen bay' });
        await screen.findByRole('button', { name: 'Review in Plan' });
    });

    it('does not overwrite a manual edit with a late yacht-position result', async () => {
        let finish!: (fix: BoatFix) => void;
        mock.locate.mockReturnValue(
            new Promise<BoatFix>((resolve) => {
                finish = resolve;
            }),
        );
        mount();
        fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '-20.25' } });
        fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '148.9' } });
        await act(async () => finish(freshFix));
        expect(screen.getByLabelText('Latitude')).toHaveValue(-20.25);
        expect(screen.getByLabelText('Longitude')).toHaveValue(148.9);
    });

    it('locks request inputs while calculating and aborts explicitly on cancel', async () => {
        mock.run.mockReturnValue(new Promise(() => {}));
        mount();
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        const signal = mock.run.mock.calls[0][2].signal as AbortSignal;
        expect(screen.getByLabelText('Leave at')).toBeDisabled();
        expect(screen.getByLabelText('Latitude')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Beach' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel calculation' }));
        expect(signal.aborted).toBe(true);
        expect(screen.getByLabelText('Leave at')).toBeEnabled();
        expect(mock.save).not.toHaveBeenCalled();
    });

    it.each(['account change', 'unmount'] as const)(
        'cancels an active request on %s and ignores its late result',
        async (change) => {
            let finish!: (result: DayPlanResult) => void;
            mock.run.mockReturnValue(
                new Promise<DayPlanResult>((resolve) => {
                    finish = resolve;
                }),
            );
            const view = mount();
            await locate();
            fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
            const [request, , options] = mock.run.mock.calls[0];
            if (change === 'unmount') view.unmount();
            else act(() => setAuthIdentityScope('other-owner'));
            expect(options.signal.aborted).toBe(true);
            if (change === 'account change') expect(view.props.onClose).toHaveBeenCalledOnce();
            await act(async () => finish(resultFor(request)));
            expect(screen.queryByRole('button', { name: 'Review in Plan' })).toBeNull();
            expect(mock.save).not.toHaveBeenCalled();
        },
    );

    it.each([null, { ...vessel, draft: 0 }])('does not calculate without a usable profile (%j)', async (value) => {
        mount(value);
        await locate();
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        expect(mock.run).not.toHaveBeenCalled();
    });

    it('explains empty results without fabricating a fallback route', async () => {
        mock.run.mockResolvedValue({
            options: [],
            calculatedAt: NOW,
            excluded: [{ name: 'Whitehaven Beach', reason: 'Return route unavailable.' }],
        });
        mount();
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        await screen.findByText('No matching plan this time.');
        expect(screen.getByText(/Return route unavailable/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Review in Plan' })).toBeNull();
        expect(mock.save).not.toHaveBeenCalled();
    });
});

describe('DayPlannerSheet shared catalogue ownership', () => {
    it.each(['return', 'overnight'] as const)(
        'sends the exact shared choice instead of local destinations in %s mode',
        async (mode) => {
            sharedTrip();
            mount();
            await locate();
            expect(mock.discover).not.toHaveBeenCalled();
            fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), {
                target: { value: 'whitehaven-beach' },
            });
            if (mode === 'overnight') fireEvent.click(screen.getByRole('button', { name: 'Stay overnight' }));
            await chooseSharedTrip();
            expect(screen.getByRole('combobox', { name: 'Destination' })).toHaveValue('');
            await waitFor(() => expect(screen.getByRole('button', { name: 'Find my day' })).toBeEnabled());
            fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
            await screen.findByRole('button', { name: 'Review in Plan' });
            const request = mock.run.mock.calls[0][0] as DayPlanRequest;
            expect(request).not.toHaveProperty('destinationIds');
            expect(request.catalogueSelection).toEqual({
                id: sharedId,
                version: 1,
                outbound: outboundRef,
                ...(mode === 'return' ? { return: returnRef } : {}),
            });
        },
    );

    it('blocks a failed shared choice until the user explicitly selects a local destination', async () => {
        sharedTrip();
        mock.catalogueDetail.mockRejectedValue(new Error('withdrawn'));
        mount();
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Browse shared catalogue' }));
        await screen.findByRole('option', { name: 'Shared island trip · trip' });
        fireEvent.change(screen.getByRole('combobox', { name: 'Shared destination or trip' }), {
            target: { value: `${sharedId}:1` },
        });
        await screen.findByText(/This selected reference is unavailable/);
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeDisabled();
        expect(mock.run).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), {
            target: { value: 'whitehaven-beach' },
        });
        expect(screen.getByRole('combobox', { name: 'Shared destination or trip' })).toHaveValue('');
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        await screen.findByRole('button', { name: 'Review in Plan' });
        expect(mock.run.mock.calls[0][0]).toMatchObject({ destinationIds: ['whitehaven-beach'] });
        expect(mock.run.mock.calls[0][0]).not.toHaveProperty('catalogueSelection');
    });

    it('shows catalogue source review separately from approach and local condition checks', async () => {
        mock.run.mockImplementation(async (request: DayPlanRequest) => {
            const result = resultFor(request);
            result.coverage = {
                id: 'shared',
                name: 'Shared catalogue',
                type: 'catalogue-reference',
                timeZone: 'Australia/Brisbane',
                sourceAttributions: ['Catalogue editor'],
                limitations: ['Local conditions remain unassessed.'],
            };
            result.options[0].candidate.destination = {
                ...result.options[0].candidate.destination,
                catalogueQuality: 'catalogue-reference',
            };
            result.options[0].light = 'unknown';
            return result;
        });
        mount();
        await calculate();
        expect(screen.getByText('Shared catalogue · reviewed source references')).toBeInTheDocument();
        expect(
            screen.getByText('Reviewed catalogue reference. Approach and local conditions remain unverified.'),
        ).toBeInTheDocument();
        expect(screen.getByText('Checks incomplete')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
        expect(
            screen.getByText(
                'Reviewed catalogue source reference. This review does not establish an approved approach or current conditions.',
            ),
        ).toBeInTheDocument();
    });
});

describe('DayPlannerSheet review and planned-only save', () => {
    it('aborts a pending save on change plan and ignores its late result', async () => {
        let finish!: (value: unknown) => void;
        mock.save.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        mount();
        await calculate();
        fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
        await reviewNext();
        await reviewNext();
        fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed each leg/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save both legs' }));
        const options = mock.save.mock.calls[0][2] as { signal: AbortSignal };
        expect(screen.getByRole('button', { name: 'Save both legs' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Change plan' }));
        expect(options.signal.aborted).toBe(true);
        await act(async () => finish({ traces: [{ id: 'late-save' }], cloud: Promise.resolve(['ok']) }));
        expect(screen.queryByRole('button', { name: 'Open saved plan' })).toBeNull();
        expect(screen.queryByText(/Saved to your private route library/)).toBeNull();
    });

    it('supplies current vessel getters during an asynchronous save and aborts on unmount', async () => {
        mock.save.mockImplementation(() => new Promise(() => {}));
        const view = mount();
        await calculate();
        fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
        await reviewNext();
        await reviewNext();
        fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed each leg/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save both legs' }));
        const options = mock.save.mock.calls[0][2] as {
            signal: AbortSignal;
            getCurrentVesselProfile: () => unknown;
            getCurrentVesselInputs: () => unknown;
        };
        const changedVessel = { ...vessel, draft: 7, cruisingSpeed: 7 };
        view.rerender(<DayPlannerSheet {...view.props} vessel={changedVessel} />);
        expect(options.getCurrentVesselProfile()).toEqual(snapshotAutoroutingVesselProfile(changedVessel));
        expect(options.getCurrentVesselInputs()).toEqual(mock.inputs(changedVessel));
        view.unmount();
        expect(options.signal.aborted).toBe(true);
    });
    it.each([false, true])(
        'requires both chart reviews and acknowledgement, then saves the selected departure (flexible=%s)',
        async (flexible) => {
            mock.delay = flexible ? HOUR : 0;
            const view = mount();
            await locate();
            if (flexible) fireEvent.click(screen.getByRole('checkbox', { name: /Compare leaving/ }));
            await calculate();
            fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
            expect(screen.getByRole('button', { name: 'Save both legs' })).toBeDisabled();
            const acknowledgement = () => screen.getByRole('checkbox', { name: /I have reviewed each leg/ });
            fireEvent.click(acknowledgement());
            expect(screen.getByRole('button', { name: 'Save both legs' })).toBeDisabled();
            await reviewNext();
            expect(screen.getByRole('button', { name: 'Save both legs' })).toBeDisabled();
            await reviewNext();
            expect(acknowledgement()).not.toBeChecked();
            fireEvent.click(acknowledgement());
            fireEvent.click(screen.getByRole('button', { name: 'Save both legs' }));
            expect(mock.save).toHaveBeenCalledOnce();
            const savedInput = mock.save.mock.calls[0][0];
            expect(savedInput.request.departureMs).toBe(NOW + HOUR / 2 + mock.delay);
            expect(savedInput.option.departureMs).toBe(savedInput.request.departureMs);
            expect(savedInput.request.flexibleStart).toBe(flexible);
            expect(savedInput.currentVesselProfile).toEqual(snapshotAutoroutingVesselProfile(vessel));
            expect(savedInput.currentVesselInputs).toEqual(mock.inputs(vessel));
            expect(savedInput.acknowledgedPlannedOnly).toBe(true);
            expect(view.props.onOpenSaved).not.toHaveBeenCalled();
            await screen.findByText(/Saved to your private route library/);
            fireEvent.click(screen.getByRole('button', { name: 'Open saved plan' }));
            expect(view.props.onOpenSaved).toHaveBeenCalledWith('saved-first');
        },
    );

    it.each(['incomplete', 'stopped', 'error', 'danger'] as const)(
        'returns a %s ENC check without crashing or enabling save',
        async (phase) => {
            mount();
            await calculate();
            const review = mock.reviews.get('route-0')!;
            if (phase === 'danger') review.legs[0]!.verdict.grade = 'danger';
            else if (phase !== 'incomplete') review.phase = phase;
            fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
            fireEvent.click(screen.getAllByRole('button', { name: 'Open ENC review' })[0]);
            fireEvent.click(
                await screen.findByRole('button', {
                    name: phase === 'incomplete' ? 'Close unfinished review' : 'Complete chart review',
                }),
            );
            expect(await screen.findByRole('button', { name: 'Save both legs' })).toBeDisabled();
            const firstLeg = screen.getByText('1. To Whitehaven Beach').closest('.day-plan-leg')!;
            expect(
                within(firstLeg as HTMLElement).getByText(phase === 'danger' ? /known danger/ : /checks incomplete/i),
            ).toBeInTheDocument();
            if (phase === 'danger') {
                await reviewNext();
                fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed each leg/ }));
                expect(screen.getByRole('button', { name: 'Save both legs' })).toBeDisabled();
            }
            expect(mock.save).not.toHaveBeenCalled();
        },
    );

    it.each(['conditions', 'transit'] as const)('shows expired %s as unknown instead of favourable', async (part) => {
        mock.run.mockImplementation(async (request: DayPlanRequest) => {
            const result = resultFor(request);
            result.options[0][part].fetchedAt = NOW - 4 * 60_000;
            return result;
        });
        mount();
        await calculate();
        fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
        advanceReportClock(12 * 60_000);
        const heading = screen.getByRole('heading', {
            name: part === 'conditions' ? 'Your stay' : 'Underway conditions',
        });
        const section = within(heading.closest('section')!);
        expect(section.queryByText('Favourable forecast')).toBeNull();
        expect(section.getByText('Refresh needed')).toHaveStyle({ color: '#94a3b8' });
        expect(screen.getByRole('button', { name: 'Save both legs' })).toBeDisabled();
        expect(screen.getByText(/report needs refreshing/)).toBeInTheDocument();
    });

    it('keeps a later flexible option usable after the originally requested start passes', async () => {
        mock.delay = HOUR;
        mount();
        await locate();
        fireEvent.change(screen.getByLabelText('Leave at'), {
            target: { value: dayPlanInputTime(NOW + 5 * 60_000) },
        });
        fireEvent.click(screen.getByRole('checkbox', { name: /Compare leaving/ }));
        await calculate();
        advanceReportClock(6 * 60_000);
        expect(screen.getByRole('button', { name: 'Review in Plan' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Review in Plan' }));
        await reviewNext();
        await reviewNext();
        fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed each leg/ }));
        expect(screen.getByRole('button', { name: 'Save both legs' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Save both legs' }));
        expect(mock.save.mock.calls[0][0].request.departureMs).toBe(NOW + 65 * 60_000);
        await screen.findByText(/Saved to your private route library/);
    });
});

describe('DayPlannerEntry lifecycle', () => {
    // The entry opens the planner at once on a confirmed draft; an
    // unconfirmed one is asked about first (tests/DraftConfirmGates.test.tsx).
    beforeEach(async () => {
        await awaitSettingsLoaded();
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                vessel: { ...vessel, draftConfirmedFt: vessel.draft },
            },
        });
    });

    it('keeps a pending calculation alive through an unrelated entry rerender', async () => {
        mock.run.mockReturnValue(new Promise(() => {}));
        const onOpenSaved = vi.fn();
        const props = { vessel, mapboxToken: 'test-token', onOpenSaved };
        const view = render(<DayPlannerEntry {...props} />);
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        const signal = mock.run.mock.calls[0][2].signal as AbortSignal;
        view.rerender(<DayPlannerEntry {...props} />);
        expect(signal.aborted).toBe(false);
        expect(mock.locate).toHaveBeenCalledOnce();
        expect(screen.getByRole('button', { name: 'Cancel calculation' })).toBeEnabled();
        view.unmount();
        expect(signal.aborted).toBe(true);
    });

    it('cancels the old calculation when numeric draft changes with the same profile status', async () => {
        mock.run.mockReturnValue(new Promise(() => {}));
        const props = { vessel, mapboxToken: 'test-token', onOpenSaved: vi.fn() };
        const view = render(<DayPlannerEntry {...props} />);
        fireEvent.click(screen.getByRole('button', { name: /Plan Your Day/ }));
        await locate();
        fireEvent.click(screen.getByRole('button', { name: 'Find my day' }));
        const signal = mock.run.mock.calls[0][2].signal as AbortSignal;
        view.rerender(<DayPlannerEntry {...props} vessel={{ ...vessel, draft: 7 }} />);
        expect(signal.aborted).toBe(true);
        await locate();
        expect(screen.getByRole('button', { name: 'Find my day' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Cancel calculation' })).toBeNull();
        expect(mock.save).not.toHaveBeenCalled();
    });
});

describe('Queensland planning time on a host using daylight saving', () => {
    it('renders and parses AEST independently of the host timezone and rejects impossible dates', async () => {
        vi.stubEnv('TZ', 'America/New_York');
        mount();
        await locate();
        expect(screen.getByLabelText('Leave at')).toHaveValue('2026-09-27T10:30');
        const utc = Date.parse('2026-11-01T05:30:00Z');
        expect(dayPlanInputTime(utc)).toBe('2026-11-01T15:30');
        expect(parseDayPlanInput('2026-11-01T15:30')).toBe(utc);
        expect(dayPlanTime(utc)).toMatch(/3:30\s*pm/i);
        expect(Number.isNaN(parseDayPlanInput('2026-02-30T10:00'))).toBe(true);
        expect(Number.isNaN(parseDayPlanInput('2026-10-01T25:00'))).toBe(true);
    });
});
