import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NearbyModelSkill from '../components/dashboard/NearbyModelSkill';
import { openWeatherEvidenceSession, type WeatherEvidenceSession } from '../services/weather/evidenceSession';
import {
    decodeEvidenceIndex,
    decodeEvidencePointer,
    decodeStationSkill,
    type StationSkillDetail,
} from '../services/weather/evidenceContract';
import { nearestEvidenceStation, issuedModelLabel } from '../services/weather/nearbyEvidence';
vi.mock('../services/weather/evidenceSession', () => ({ openWeatherEvidenceSession: vi.fn() }));
const json = (name: string) =>
    JSON.parse(readFileSync(resolve('tests/fixtures/weather-evidence141', name + '.txt'), 'utf8'));
const source = json('pointer-skill');
const index = decodeEvidenceIndex(json('index-skill'), decodeEvidencePointer(source, 'skill', source.generatedAt));
const original = json('detail-skill-ndbc');
const station = index.stations.find((s) => s.key === original.key)!;
const detail = decodeStationSkill(original, station, index.generatedAt);
let current = true;
const close = vi.fn(() => {
    current = false;
});
const readStation = vi.fn<(key: string, signal?: AbortSignal) => Promise<StationSkillDetail>>();
const session: WeatherEvidenceSession = { index, close, readStation, isCurrent: () => current };
function expand() {
    const node = screen.getByTestId('nearby-model-skill') as HTMLDetailsElement;
    node.open = true;
    fireEvent(node, new Event('toggle'));
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(source.generatedAt * 1000 + 1000);
    current = true;
    close.mockClear();
    readStation.mockReset().mockResolvedValue(detail);
    vi.mocked(openWeatherEvidenceSession).mockReset().mockResolvedValue(session);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
describe('nearby issued advice within the existing model sheet', () => {
    it('does no read until explicitly opened and shows honest warming without a score or model mutation', async () => {
        const view = render(<NearbyModelSkill coordinates={{ lat: station.lat, lon: station.lon }} />);
        expect(openWeatherEvidenceSession).not.toHaveBeenCalled();
        expand();
        await screen.findByText(/Warming at this station/);
        expect(screen.queryByText(/Closest here lately:/)).not.toBeInTheDocument();
        expect(screen.queryByText(/MAE \d/)).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Skill measure'), { target: { value: 'wave_hs_m' } });
        fireEvent.change(screen.getByLabelText('Skill forecast lead'), { target: { value: '48-72h' } });
        expect(readStation).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Warming at this station/)).toBeInTheDocument();
        view.unmount();
        expect(close).toHaveBeenCalled();
        expect(vi.mocked(openWeatherEvidenceSession).mock.calls[0][1].aborted).toBe(true);
    });
    it('does no request with missing position and never sends a coordinate to the reader', async () => {
        const view = render(<NearbyModelSkill />);
        expand();
        expect(screen.getByText('No forecast position is available.')).toBeInTheDocument();
        expect(openWeatherEvidenceSession).not.toHaveBeenCalled();
        view.rerender(<NearbyModelSkill coordinates={{ lat: 0, lon: 0 }} />);
        await screen.findByText(/No current scored station within 50 nm/);
        expect(openWeatherEvidenceSession).toHaveBeenCalledTimes(1);
        expect(readStation).not.toHaveBeenCalled();
        expect(openWeatherEvidenceSession).toHaveBeenCalledWith('skill', expect.any(AbortSignal), expect.any(Function));
    });
    it('shows qualified lead-specific skill with exact source names and never offers a model switch', async () => {
        const models = {
            ecmwf_ifs025: {
                pairs: 50,
                effectiveN: 30,
                spanHours: 260,
                status: 'ready' as const,
                mae: 1,
                medianLeadHours: 3,
            },
            dwd_icon: {
                pairs: 50,
                effectiveN: 30,
                spanHours: 260,
                status: 'ready' as const,
                mae: 2,
                medianLeadHours: 3,
            },
        };
        const ready: StationSkillDetail = {
            ...detail,
            metrics: {
                ...detail.metrics,
                wind_speed_mps: {
                    ...detail.metrics.wind_speed_mps,
                    '0-6h': {
                        metric: 'wind_speed_mps',
                        lead: '0-6h',
                        status: 'ready',
                        closest: 'ecmwf_ifs025',
                        tiedModels: [],
                        models,
                    },
                },
            },
        };
        readStation.mockResolvedValue(ready);
        render(<NearbyModelSkill coordinates={{ lat: station.lat, lon: station.lon }} />);
        expand();
        await screen.findByText('Closest here lately: ECMWF IFS 0.25°');
        expect(screen.getByText(/MAE 1.00 m\/s/)).toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Skill forecast lead'), { target: { value: '24-48h' } });
        expect(screen.queryByText(/Closest here lately:/)).not.toBeInTheDocument();
        expect(screen.getByText(/Warming at this station/)).toBeInTheDocument();
    });
    it('discards a late detail after location A/B/A and keeps one catalogue read', async () => {
        let release!: (value: StationSkillDetail) => void;
        readStation.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const view = render(<NearbyModelSkill coordinates={{ lat: station.lat, lon: station.lon }} />);
        expand();
        await waitFor(() => expect(readStation).toHaveBeenCalledTimes(1));
        view.rerender(<NearbyModelSkill coordinates={{ lat: 0, lon: 0 }} />);
        await screen.findByText(/No current scored station within 50 nm/);
        expect(readStation.mock.calls[0][1]?.aborted).toBe(true);
        view.rerender(<NearbyModelSkill coordinates={{ lat: station.lat, lon: station.lon }} />);
        await screen.findByText(/Warming at this station/);
        await act(async () => release(detail));
        expect(openWeatherEvidenceSession).toHaveBeenCalledTimes(1);
        expect(readStation).toHaveBeenCalledTimes(2);
    });
    it('retires expired catalogue/detail and never silently refetches', async () => {
        render(<NearbyModelSkill coordinates={{ lat: station.lat, lon: station.lon }} />);
        expand();
        await screen.findByText(/Warming at this station/);
        vi.useFakeTimers();
        current = false;
        // The interval belongs to real timers. A selector event also rechecks
        // the current owner synchronously before any score is rendered.
        fireEvent.change(screen.getByLabelText('Skill measure'), { target: { value: 'wave_hs_m' } });
        expect(screen.queryByText(/Warming at this station/)).not.toBeInTheDocument();
        expect(openWeatherEvidenceSession).toHaveBeenCalledTimes(1);
    });
});
describe('local-only exact nearby station selection', () => {
    it('omits individually expired stations and refuses invalid positions or expanded radius', () => {
        expect(nearestEvidenceStation([station], { lat: station.lat, lon: station.lon }, station.expiresAt)).toBeNull();
        expect(nearestEvidenceStation([station], { lat: 91, lon: 0 }, source.generatedAt)).toBeNull();
        expect(
            nearestEvidenceStation([station], { lat: station.lat, lon: station.lon }, source.generatedAt, 51),
        ).toBeNull();
        expect(
            nearestEvidenceStation([station], { lat: station.lat, lon: station.lon }, source.generatedAt)?.distanceNm,
        ).toBe(0);
    });
    it('handles antimeridian proximity and deterministic coincident station ties', () => {
        const a = { ...station, key: 'ndbc:a', lat: 0, lon: -179.9 };
        const b = { ...a, key: 'ndbc:b' };
        expect(nearestEvidenceStation([b, a], { lat: 0, lon: 179.9 }, source.generatedAt)?.station.key).toBe('ndbc:a');
        expect(issuedModelLabel('ecmwf_ifs025')).toBe('ECMWF IFS 0.25°');
        expect(issuedModelLabel('ecmwf_ifs')).toBe('ecmwf_ifs');
    });
});
