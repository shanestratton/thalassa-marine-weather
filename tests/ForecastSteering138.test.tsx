import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentField2D } from '../services/routing/env/EnvFields';
import { forecastSteeringAt, forecastSteeringText } from '../services/routing/forecastSteering';
import { ForecastSteeringLine } from '../components/passage/ForecastSteeringLine';
import { forecastSteeringBounds, useForecastSteeringField } from '../hooks/useForecastSteeringField';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { currentRegionalFixture } from './helpers/currentRegionalFixture';
import { decodeCurrentRegionalAsset } from '../services/weather/api/currentRegionalContract';

const loader = vi.hoisted(() => vi.fn());
vi.mock('../services/weather/api/currentRegionalLoader', () => ({ loadRegionalCurrentSeries: loader }));
const now = Date.parse('2026-10-17T12:00:00Z');
const point = { lat: 0.5, lon: 0.5 };
const field = (u: number, v: number): CurrentField2D => ({
    provenance: 'CMEMS_HOURLY',
    currentAt: () => ({ u, v }),
    forecast: { model: 'CMEMS', generation: 'verified-test', runMs: now, components: 'ocean' },
});
beforeEach(() => {
    loader.mockReset();
    loader.mockResolvedValue(null);
    setAuthIdentityScope('steering-a');
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

describe('forecast CTS, separated from live measured steering', () => {
    it('renders a true zero heading and a known finite zero current', () => {
        const value = forecastSteeringAt(field(0, 0), point, now, 0, 6);
        expect(value?.headingDeg).toBe(0);
        expect(value?.currentKn).toBe(0);
        render(<ForecastSteeringLine value={value} />);
        expect(screen.getByTestId('forecast-steering')).toHaveTextContent('Forecast steer 000°T');
        expect(screen.getByTestId('forecast-steering').title).toContain('2026-10-17T12:00:00.000Z');
    });
    it('crabs to port into an eastward TO vector on a northbound leg with m/s converted to knots', () => {
        const value = forecastSteeringAt(field(1, 0), point, now, 0, 6)!;
        expect(value.currentKn).toBeCloseTo(1.94384449);
        expect(value.setDeg).toBe(90);
        expect(value.headingDeg).toBeCloseTo(341.096, 2);
        expect(forecastSteeringText(value)).toContain('current sets 19° to starboard');
    });
    it('withholds a steer value for an unholdable crossing stream or a stronger opposing stream', () => {
        expect(forecastSteeringAt(field(8, 0), point, now, 0, 6)?.headingDeg).toBeNull();
        expect(forecastSteeringAt(field(0, -8), point, now, 0, 6)?.headingDeg).toBeNull();
        expect(forecastSteeringText(forecastSteeringAt(field(8, 0), point, now, 0, 6))).toContain('cannot hold');
    });
    it('requires real forecast provenance and a covered finite vector, never a leeway-only heading', () => {
        expect(
            forecastSteeringAt({ provenance: 'ESTIMATE', currentAt: () => ({ u: 0, v: 0 }) }, point, now, 0, 6),
        ).toBeNull();
        expect(forecastSteeringAt({ ...field(0, 0), currentAt: () => null }, point, now, 0, 6)).toBeNull();
        expect(forecastSteeringAt(field(NaN, 0), point, now, 0, 6)).toBeNull();
        expect(forecastSteeringAt(field(0, 0), point, now - 1, 0, 6)).toBeNull();
        expect(forecastSteeringAt(field(0, 0), point, now, 0, 0)).toBeNull();
    });
    it('samples the actual later-leg UTC clock, preserving unknown coverage', () => {
        const sample = vi.fn((_lat: number, _lon: number, t: number) =>
            t === now + 3_600_000 ? { u: 1, v: 0 } : null,
        );
        const current = { ...field(0, 0), currentAt: sample };
        expect(forecastSteeringAt(current, point, now, 0, 6)).toBeNull();
        expect(forecastSteeringAt(current, point, now + 3_600_000, 0, 6)?.sampledAtMs).toBe(now + 3_600_000);
        expect(sample).toHaveBeenLastCalledWith(0.5, 0.5, now + 3_600_000);
    });
    it('bounds every vertex and handles a dateline-crossing route without a worldwide box', () => {
        const crossing = forecastSteeringBounds([
            { lat: 0, lon: 179.8 },
            { lat: 1, lon: -179.8 },
        ]);
        expect(crossing?.west).toBeCloseTo(179.79);
        expect(crossing?.east).toBeCloseTo(-179.79);
        expect(
            forecastSteeringBounds([
                { lat: 0, lon: 1 },
                { lat: 10, lon: 2 },
                { lat: 0, lon: 3 },
            ])?.north,
        ).toBe(10.01);
        expect(forecastSteeringBounds([{ lat: NaN, lon: 0 }])).toBeNull();
    });
    it('holds production unavailable and skips the loader in Satellite Mode', async () => {
        renderHook(() =>
            useForecastSteeringField({
                points: [point],
                startMs: now,
                endMs: now,
                vesselKey: 'boat-a',
                enabled: true,
                satelliteMode: true,
            }),
        );
        await act(async () => {});
        expect(loader).not.toHaveBeenCalled();
    });
    it('fences account and vessel changes while a verified cohort is arriving', async () => {
        const raw = currentRegionalFixture('t-45-90', now);
        const series = decodeCurrentRegionalAsset(raw.bytes, raw.manifest, 'CMEMS');
        let resolve!: (value: typeof series) => void;
        loader.mockReturnValueOnce(
            new Promise<typeof series>((done) => {
                resolve = done;
            }),
        );
        const props = { vesselKey: 'boat-a' };
        const view = renderHook(
            ({ vesselKey }) =>
                useForecastSteeringField({ points: [point], startMs: now, endMs: now, vesselKey, enabled: true }),
            { initialProps: props },
        );
        await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
        act(() => {
            setAuthIdentityScope('steering-b');
        });
        view.rerender({ vesselKey: 'boat-b' });
        await act(async () => {
            resolve(series);
        });
        expect(view.result.current).toBeNull();
        expect(loader.mock.calls[0][0].signal.aborted).toBe(true);
    });
});
