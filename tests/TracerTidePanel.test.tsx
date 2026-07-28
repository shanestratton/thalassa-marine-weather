import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRealTides = vi.fn();
const fetchTideCurve = vi.fn();

vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: (...a: unknown[]) => fetchRealTides(...a) }));
vi.mock('../services/TideHeightService', () => ({ fetchTideCurve: (...a: unknown[]) => fetchTideCurve(...a) }));

import { TracerTidePanel } from '../components/map/TracerTidePanel';

const DEPARTURE = new Date('2026-08-01T06:00:00Z').getTime();

describe('TracerTidePanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchRealTides.mockResolvedValue({
            tides: [
                { time: '2026-08-01T08:12:00Z', type: 'High', height: 1.84 },
                { time: '2026-08-01T14:30:00Z', type: 'Low', height: 0.42 },
            ],
            guiDetails: { stationName: 'Brisbane Bar', isSecondary: false },
        });
        fetchTideCurve.mockResolvedValue({
            provenance: 'EXTREMES_INTERP',
            stationName: 'Brisbane Bar',
            heightAt: (t: number) => (t > DEPARTURE ? 1.4 : 1.1),
        });
    });

    it('renders nothing without an anchor, and does not hit the tide APIs', () => {
        render(<TracerTidePanel anchor={null} departureMs={DEPARTURE} />);
        expect(screen.queryByTestId('tracer-tide-panel')).not.toBeInTheDocument();
        expect(fetchRealTides).not.toHaveBeenCalled();
        expect(fetchTideCurve).not.toHaveBeenCalled();
    });

    it('lists the upcoming extremes with heights and names the station', async () => {
        render(<TracerTidePanel anchor={{ lat: -27.4, lon: 153.1 }} departureMs={DEPARTURE} />);

        expect(await screen.findByText(/HW/)).toBeInTheDocument();
        expect(screen.getByText('1.8 m')).toBeInTheDocument();
        expect(screen.getByText(/LW/)).toBeInTheDocument();
        expect(screen.getByText('0.4 m')).toBeInTheDocument();
        expect(screen.getByText(/Brisbane Bar/)).toBeInTheDocument();
    });

    it('labels an interpolated curve as approximate rather than implying a measurement', async () => {
        render(<TracerTidePanel anchor={{ lat: -27.4, lon: 153.1 }} departureMs={DEPARTURE} />);
        // WorldTides only ever returns extremes today, so this is the live
        // path — the panel must never present a half-cosine value as a
        // station reading against a 0.5 m safety margin.
        expect(await screen.findByText(/Approx — interpolated between high and low/)).toBeInTheDocument();
    });

    it('anchors the curve window on the DEPARTURE, not on now', async () => {
        render(<TracerTidePanel anchor={{ lat: -27.4, lon: 153.1 }} departureMs={DEPARTURE} />);
        await waitFor(() => expect(fetchTideCurve).toHaveBeenCalled());

        const [, , startMs, endMs] = fetchTideCurve.mock.calls[0] as number[];
        // A passage three days out must not be read against a now-anchored
        // window — that was the trap in readTideCurveWindow().
        expect(startMs).toBeLessThan(DEPARTURE);
        expect(endMs).toBeGreaterThan(DEPARTURE);
        expect(endMs - startMs).toBeGreaterThanOrEqual(24 * 3_600_000);
    });

    it('reports the water level at departure and which way it is going', async () => {
        render(<TracerTidePanel anchor={{ lat: -27.4, lon: 153.1 }} departureMs={DEPARTURE} />);
        expect(await screen.findByText(/1\.1 m · rising/)).toBeInTheDocument();
    });

    it('heads each day so a time can never be read against the wrong one', async () => {
        // The panel shows ~2 days of extremes. A bare "HW 02:55" could be
        // tonight or tomorrow morning, and picking the wrong one is exactly
        // how a boat ends up on a bar.
        fetchRealTides.mockResolvedValue({
            tides: [
                { time: '2026-08-01T08:12:00Z', type: 'High', height: 1.84 },
                { time: '2026-08-02T02:55:00Z', type: 'High', height: 1.91 },
            ],
            guiDetails: { stationName: 'Brisbane Bar', isSecondary: false },
        });
        render(<TracerTidePanel anchor={{ lat: -27.4, lon: 153.1 }} departureMs={DEPARTURE} />);

        // Queried by testid, not by text: the heading is locale-formatted, so
        // asserting a shape like "SAT 1 AUG" pins the CI locale, not the rule.
        const headings = await screen.findAllByTestId('tide-day');
        expect(headings.length).toBe(2);
        expect(headings[0].textContent).not.toBe(headings[1].textContent);
    });

    it('says so plainly when there is no station near the route', async () => {
        fetchRealTides.mockResolvedValue({ tides: [], guiDetails: undefined });
        fetchTideCurve.mockResolvedValue(null);
        render(<TracerTidePanel anchor={{ lat: 0, lon: 0 }} departureMs={null} />);
        expect(await screen.findByText('No tide station near this route.')).toBeInTheDocument();
    });
});
