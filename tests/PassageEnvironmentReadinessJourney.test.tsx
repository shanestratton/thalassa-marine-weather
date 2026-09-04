import React from 'react';
import { isAcknowledgementFresh, PASSAGE_ACK_TTL_MS } from '../services/passageEnvironmentReadiness';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentBriefing } from '../services/OceanCurrentService';
import type { WeatherWindowResult } from '../services/WeatherWindowService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { DEFAULT_SETTINGS, useSettingsStore } from '../stores/settingsStore';

const readinessMocks = vi.hoisted(() => ({
    loadCardChecks: vi.fn(),
    upsertCheck: vi.fn(),
}));
const currentMocks = vi.hoisted(() => ({ fetchCurrents: vi.fn() }));
const weatherMocks = vi.hoisted(() => ({ analyse: vi.fn() }));

vi.mock('../services/ReadinessCheckService', () => ({
    ReadinessCheckService: {
        loadCardChecks: readinessMocks.loadCardChecks,
        upsertCheck: readinessMocks.upsertCheck,
    },
}));

vi.mock('../services/OceanCurrentService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/OceanCurrentService')>();
    return {
        ...actual,
        OceanCurrentService: { ...actual.OceanCurrentService, fetchCurrents: currentMocks.fetchCurrents },
    };
});

vi.mock('../services/WeatherWindowService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/WeatherWindowService')>();
    return {
        ...actual,
        WeatherWindowService: { ...actual.WeatherWindowService, analyse: weatherMocks.analyse },
    };
});

vi.mock('../utils/system', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/system')>();
    return { ...actual, triggerHaptic: vi.fn() };
});

import { OceanCurrentsCard } from '../components/passage/OceanCurrentsCard';
import { WeatherWindowCard } from '../components/passage/WeatherWindowCard';

const DEPARTURE = { lat: -27.47, lon: 153.03 };
const DESTINATION = { lat: -22.27, lon: 166.44 };
const ROUTE_A = [DEPARTURE, { lat: -25.1, lon: 158.2 }, DESTINATION];
const ROUTE_B = [DEPARTURE, { lat: -24.2, lon: 160.1 }, DESTINATION];

function availableCurrent(dataFingerprint = 'current-data-a'): CurrentBriefing {
    return {
        availability: 'available',
        vectors: [{ lat: -25, lon: 158, u: 0.2, v: 0.1, speedKts: 0.43, directionDeg: 63 }],
        avgSpeedKts: 0.4,
        maxSpeedKts: 0.4,
        netEffectHours: -0.5,
        source: 'climatology',
        fetchedAt: new Date().toISOString(),
        provider: 'NOAA CoastWatch ERDDAP',
        providerDataset: 'test-current-field',
        dataTime: '2026-08-05T00:00:00.000Z',
        retrieval: 'live',
        coverage: 'data',
        dataFingerprint,
        segments: [{ type: 'favourable', avgSpeedKts: 0.4, label: 'favourable' }],
    };
}

function unavailableCurrent(): CurrentBriefing {
    return {
        availability: 'unavailable',
        vectors: [],
        avgSpeedKts: null,
        maxSpeedKts: null,
        netEffectHours: null,
        source: 'climatology',
        fetchedAt: new Date().toISOString(),
        provider: 'NOAA CoastWatch ERDDAP',
        providerDataset: null,
        dataTime: null,
        retrieval: 'live',
        coverage: 'unavailable',
        dataFingerprint: null,
        errorMessage: 'Provider unavailable; no current assumed.',
        segments: [],
    };
}

function weatherResult(dataFingerprint = 'weather-data-a'): WeatherWindowResult {
    const analysisTime = new Date().toISOString();
    const time = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return {
        availability: 'available',
        windows: [
            {
                time,
                // Same instant; the fixture's `time` is already absolute.
                timeUtc: time,
                label: 'Thu, 6 Aug · 06:00',
                rating: 'go',
                score: 92,
                summary: {
                    maxWindKts: 16,
                    avgWindKts: 12,
                    maxWaveM: 1.4,
                    avgWaveM: 1,
                    dominantWindDir: 'SE',
                    rainProbability: 10,
                },
                description: 'SE 12–16kt · 1.0–1.4m swell',
            },
        ],
        bestWindowIndex: 0,
        analysisTime,
        source: 'live',
        provider: 'Open-Meteo Commercial marine + forecast',
        cacheVersion: 2,
        forecastStart: time,
        forecastEnd: time,
        dataFingerprint,
        analysisContextFingerprint: `context-${dataFingerprint}`,
    };
}

describe('passage environment readiness journeys', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('passage-owner');
        readinessMocks.loadCardChecks.mockReset().mockResolvedValue({});
        readinessMocks.upsertCheck.mockReset().mockResolvedValue(undefined);
        currentMocks.fetchCurrents.mockReset();
        weatherMocks.analyse.mockReset();
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                vessel: { ...DEFAULT_SETTINGS.vessel!, cruisingSpeed: 6, maxWindSpeed: 35, maxWaveHeight: 12 },
                comfortParams: { maxWindKts: 28, maxWaveM: 3, preferredAngles: ['beam_reach'] },
            },
        });
    });

    afterEach(() => {
        cleanup();
        act(() => {
            useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
            setAuthIdentityScope(null);
        });
    });

    it('never greens before an ack; a route change re-briefs; speed tweaks and data refreshes keep it', async () => {
        const onReviewedChange = vi.fn();
        currentMocks.fetchCurrents.mockResolvedValueOnce(unavailableCurrent());
        const { rerender } = render(
            <OceanCurrentsCard
                voyageId="voyage-current"
                departure={DEPARTURE}
                destination={DESTINATION}
                routeCoordinates={ROUTE_A}
                distanceNM={820}
                onReviewedChange={onReviewedChange}
            />,
        );

        await screen.findByText('Current data unavailable');
        expect(screen.queryByText(/0kt/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Acknowledge Current Briefing' })).toBeDisabled();
        expect(onReviewedChange).toHaveBeenLastCalledWith(false);

        currentMocks.fetchCurrents.mockResolvedValue(availableCurrent());
        fireEvent.click(screen.getByRole('button', { name: 'Retry current briefing' }));
        await screen.findByText(/Surface Currents/);
        fireEvent.click(screen.getByRole('button', { name: 'Acknowledge Current Briefing' }));
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));

        rerender(
            <OceanCurrentsCard
                voyageId="voyage-current"
                departure={DEPARTURE}
                destination={DESTINATION}
                routeCoordinates={ROUTE_B}
                distanceNM={820}
                onReviewedChange={onReviewedChange}
            />,
        );
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(false));
        expect(await screen.findByText(/The route changed or the acknowledgement expired/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Acknowledge Current Briefing' }));
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));
        // A cruising-speed tweak no longer kills the ack (Shane 2026-08-26:
        // "those green buttons refuse to stay green") — the readiness tick
        // binds to the ROUTE and the 7-day TTL only.
        act(() => {
            useSettingsStore.setState((state) => ({
                settings: { ...state.settings, vessel: { ...state.settings.vessel!, cruisingSpeed: 7 } },
            }));
        });
        await screen.findByText(/Surface Currents/);
        expect(onReviewedChange).toHaveBeenLastCalledWith(true);

        // A provider DATA refresh keeps it too (hourly frames re-nagged on
        // every page open before 2026-08-26).
        currentMocks.fetchCurrents.mockResolvedValue(availableCurrent('current-data-b'));
        fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
        await screen.findByText(/Surface Currents/);
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));
    });

    it('binds accepted weather to the exact route; departure, limits and data refreshes keep it', async () => {
        const first = weatherResult();
        weatherMocks.analyse.mockResolvedValue(first);
        const onReviewedChange = vi.fn();
        const onDepartureTimeChange = vi.fn();
        const props = {
            voyageId: 'voyage-weather',
            departure: DEPARTURE,
            destination: DESTINATION,
            departureTime: first.windows[0].time,
            onReviewedChange,
            onDepartureTimeChange,
        };
        const { rerender } = render(<WeatherWindowCard {...props} routeCoordinates={ROUTE_A} />);

        await screen.findByText('Thu, 6 Aug · 06:00');
        expect(screen.getByText(/Open-Meteo Commercial marine \+ forecast/)).toBeInTheDocument();
        expect(screen.getByText(/updated .* · less than 1 minute old/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Accept This Window' }));
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));

        rerender(<WeatherWindowCard {...props} routeCoordinates={ROUTE_B} />);
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(false));
        expect(screen.getByText(/The route changed or the acceptance expired/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Accept This Window' }));
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));
        // A departure change or a comfort tweak no longer kills the
        // acceptance (Shane 2026-08-26): the readiness tick binds to the
        // ROUTE and the 7-day TTL only. Every re-plan mints a new departure,
        // which un-greened this card on every cycle.
        rerender(
            <WeatherWindowCard
                {...props}
                routeCoordinates={ROUTE_B}
                departureTime={new Date(Date.parse(first.windows[0].time) + 60 * 60 * 1000).toISOString()}
            />,
        );
        await screen.findByText('Thu, 6 Aug · 06:00');
        expect(onReviewedChange).toHaveBeenLastCalledWith(true);

        act(() => {
            useSettingsStore.setState((state) => ({
                settings: { ...state.settings, comfortParams: { ...state.settings.comfortParams, maxWindKts: 24 } },
            }));
        });
        await screen.findByText('Thu, 6 Aug · 06:00');
        expect(onReviewedChange).toHaveBeenLastCalledWith(true);
        // A forecast DATA refresh (same inputs, same windows, new provider
        // data) keeps the acceptance. Reuse `first` wholesale: the fixture
        // mints a fresh window time per call, which would masquerade as a
        // genuine departure change.
        weatherMocks.analyse.mockResolvedValue({ ...first, dataFingerprint: 'weather-data-b' });
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await screen.findByText('Thu, 6 Aug · 06:00');
        await waitFor(() => expect(onReviewedChange).toHaveBeenLastCalledWith(true));
    });

    it('disables acceptance and readiness when a displayed analysis exceeds the hard age limit', async () => {
        const stale = weatherResult();
        stale.analysisTime = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
        weatherMocks.analyse.mockResolvedValue(stale);
        const onReviewedChange = vi.fn();

        render(
            <WeatherWindowCard
                voyageId="voyage-stale"
                departure={DEPARTURE}
                destination={DESTINATION}
                routeCoordinates={ROUTE_A}
                departureTime={stale.windows[0].time}
                onReviewedChange={onReviewedChange}
            />,
        );

        await screen.findByText('Forecast is too old to accept');
        expect(screen.getByRole('button', { name: 'Refresh forecast to accept' })).toBeDisabled();
        expect(onReviewedChange).toHaveBeenLastCalledWith(false);
    });
});

describe('acknowledgement TTL', () => {
    it('stays fresh for a week, expires after, fails closed on garbage or future stamps', () => {
        const now = Date.parse('2026-08-26T00:00:00Z');
        const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();
        expect(isAcknowledgementFresh(iso(0), now)).toBe(true);
        expect(isAcknowledgementFresh(iso(-6 * 24 * 3_600_000), now)).toBe(true);
        expect(isAcknowledgementFresh(iso(-PASSAGE_ACK_TTL_MS - 60_000), now)).toBe(false);
        expect(isAcknowledgementFresh(iso(60 * 60_000), now)).toBe(false); // future clock
        expect(isAcknowledgementFresh('not-a-date', now)).toBe(false);
    });
});
