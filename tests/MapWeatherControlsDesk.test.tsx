/**
 * The wind panel on the desk planner (127-DESKMAP-b). Shane 2026-10-10: "can
 * we include the wind layer on the desktop.?? as an option??". The weather
 * rules: "Name whichever models you actually used" and "Where models
 * disagree, say so."
 *
 * Its own file so the models' comparison can be stubbed without touching the
 * chart panel's tests. Every place and number here is fictional.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/ModelSpreadService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weather/ModelSpreadService')>()),
    queryModelSpread: vi.fn(),
}));

import { MapWeatherControls } from '../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';
import { queryModelSpread, type ModelSpreadResult } from '../services/weather/ModelSpreadService';
import { COMPARE_MODELS } from '../services/weather/forecastModels';
import { useUIStore } from '../stores/uiStore';

type Weather = ReturnType<typeof useWeatherLayers>;

const HOUR = 3_600_000;
// Not on the hour, so a start can only land on its frame by real arithmetic.
const REF = '2026-10-10T05:30:00Z';
const REF_MS = Date.parse(REF);
const SOLENT = { lat: 50.76, lon: -1.4 }; // Europe/London, BST in October
const NOUMEA = { lat: -22.28, lon: 166.45 }; // Pacific/Noumea, UTC+11

function grid(totalHours = 48) {
    const frames = Array.from({ length: totalHours }, () => new Float32Array([6]));
    return {
        u: frames,
        v: frames,
        speed: frames,
        width: 1,
        height: 1,
        lats: [0],
        lons: [0],
        north: 0,
        south: 0,
        west: 0,
        east: 0,
        totalHours,
        refTime: REF,
    };
}

function weather(overrides: Record<string, unknown> = {}): Weather {
    const hours = Array.from({ length: 48 }, (_, i) => i);
    return {
        activeLayers: new Set(['wind']),
        windForecastHours: hours,
        windForecastHoursRef: { current: hours },
        windNowIdx: 2,
        windNowIdxRef: { current: 2 },
        windHour: 2,
        windTotalHours: 48,
        windPlaying: false,
        windReady: true,
        setWindHour: vi.fn(),
        followWindNow: vi.fn(),
        setWindPlaying: vi.fn(),
        windModel: 'ecmwf',
        setWindModel: vi.fn(),
        windState: { loading: false, error: null, grid: grid() },
        ...overrides,
    } as unknown as Weather;
}

const controls = { visible: true, embedded: false, controlsHidden: false, onControlsHiddenChange: vi.fn() };
const desk = (patch: Record<string, unknown> = {}) => ({
    palette: 'light' as const,
    point: SOLENT,
    startMs: null as number | null,
    ...patch,
});

/** Seven models over three local days at `place`'s zone, with per-day maxima. */
function spread(startIso: string, maxima: Array<Array<number | null>>): ModelSpreadResult {
    const start = Date.parse(startIso);
    const times = Array.from({ length: 72 }, (_, i) => start + i * HOUR);
    const models = COMPARE_MODELS.slice(0, 7).map((m, k) => {
        const speed = times.map((_, i) => {
            const peak = maxima[Math.floor(i / 24)]?.[k];
            return peak == null ? null : i % 24 === 12 ? peak : Math.min(peak, 6);
        });
        const empty = times.map(() => null);
        return {
            id: m.id,
            label: m.label,
            provider: m.provider,
            hex: m.hex,
            values: {
                wind_speed_10m: speed,
                wind_direction_10m: speed.map((s) => (s == null ? null : 135)),
                wind_gusts_10m: empty,
                pressure_msl: empty,
                temperature_2m: empty,
                relative_humidity_2m: empty,
                precipitation: empty,
                visibility: empty,
                uv_index: empty,
                weather_code: empty,
            },
        };
    });
    return { atmos: { times, models }, marine: null };
}

const seven = (...v: number[]) => v;

// 07:00 at the Solent on Saturday 10 October 2026: the comparison's days and
// "today" are fixed, whatever the machine's clock says.
const NOW = new Date('2026-10-10T06:00:00Z');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.mocked(queryModelSpread).mockReset();
    useUIStore.setState({ isOffline: false });
});
afterEach(() => {
    vi.useRealTimers();
});

describe('the desk panel’s place', () => {
    it('takes the desk classes, panel and pill; the chart panel keeps its own', () => {
        vi.mocked(queryModelSpread).mockResolvedValue(spread('2026-10-09T23:00:00Z', []));
        const view = render(<MapWeatherControls {...controls} weather={weather()} desk={desk()} />);
        const panel = screen.getByRole('region', { name: 'Weather controls' });
        expect(panel).toHaveClass('thalassa-chart-controls-panel', 'thalassa-chart-controls-panel--desk');
        view.rerender(<MapWeatherControls {...controls} controlsHidden weather={weather()} desk={desk()} />);
        expect(screen.getByTestId('weather-status-pill')).toHaveClass(
            'thalassa-chart-controls-pill',
            'thalassa-chart-controls-pill--desk',
        );
        view.rerender(<MapWeatherControls {...controls} weather={weather()} />);
        expect(screen.getByRole('region', { name: 'Weather controls' })).not.toHaveClass(
            'thalassa-chart-controls-panel--desk',
        );
    });

    // Review 2026-10-10: the dark inks laid straight on the slate panel read
    // as one near-black strip; on Light the key sits on its own pale sea.
    it('on Light the wind key draws its inks on a chip of Light’s pale sea', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(spread('2026-10-09T23:00:00Z', []));
        const { LIGHT_PALETTE } = await import('../components/map/reliefBase');
        const { WIND_PARTICLE_COLORS_LIGHT } = await import('../components/map/windRamp');
        const view = render(<MapWeatherControls {...controls} weather={weather()} desk={desk()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        const scale = () => document.querySelector<HTMLElement>('[data-weather-scale="wind"]')!;
        const sea = LIGHT_PALETTE.bands[0];
        expect(LIGHT_PALETTE.ramp.map(([, c]) => c)).toContain(sea);
        // jsdom serialises colours as rgb().
        const asRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
        expect(scale().style.border).toBe(`3px solid ${asRgb(sea)}`);
        expect(scale().style.background).toContain(WIND_PARTICLE_COLORS_LIGHT[25]);
        // Off Light, the chart's own key, no chip.
        view.rerender(<MapWeatherControls {...controls} weather={weather()} desk={desk({ palette: 'dark' })} />);
        expect(scale().style.border).toBe('');
    });

    it('her own wind stays an Obs feature: no "Her wind vs the models" row on the desk', () => {
        vi.mocked(queryModelSpread).mockResolvedValue(spread('2026-10-09T23:00:00Z', []));
        render(<MapWeatherControls {...controls} weather={weather()} desk={desk()} />);
        expect(screen.queryByText('Her wind vs the models')).toBeNull();
    });
});

describe('wind at your start time', () => {
    beforeEach(() => vi.mocked(queryModelSpread).mockResolvedValue(spread('2026-10-09T23:00:00Z', [])));
    // Review 2026-10-10: the label is in the DEPART row's clock (the
    // browser's), never the place's, or one start shows two times. A laptop in
    // California planning the Solent or Noumea: 12:00 UTC is 05:00 there.
    const zone = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'America/Los_Angeles';
    });
    afterAll(() => {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
    });

    it('opens the scrubber at the start’s own frame and says so in the DEPART row’s clock', () => {
        // 12:00 UTC is 6.5 h after a 05:30 run: frame 6.5, not 6 or 7.
        const startMs = Date.parse('2026-10-10T12:00:00Z');
        const w = weather();
        const view = render(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs })} />);
        expect(w.setWindHour).toHaveBeenCalledWith(6.5);
        view.rerender(<MapWeatherControls {...controls} weather={{ ...w, windHour: 6.5 }} desk={desk({ startMs })} />);
        // 05:00 PDT on the laptop, as the tracer's DEPART row reads it; 13:00 BST at the Solent is not shown.
        expect(screen.getByText('At your 05:00 start')).toBeInTheDocument();
        expect(screen.queryByText('At your 13:00 start')).toBeNull();
    });

    it('a start pinned in Noumea still reads in the DEPART row’s clock, not Noumea’s', () => {
        const startMs = Date.parse('2026-10-10T12:00:00Z');
        render(
            <MapWeatherControls
                {...controls}
                weather={weather({ windHour: 6.5 })}
                desk={desk({ startMs, point: NOUMEA, pinned: true })}
            />,
        );
        expect(screen.getByText('At your 05:00 start')).toBeInTheDocument();
        expect(screen.queryByText('At your 23:00 start')).toBeNull();
    });

    it('a start past the forecast opens at now and says so', () => {
        const w = weather();
        render(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs: REF_MS + 60 * HOUR })} />);
        expect(w.setWindHour).not.toHaveBeenCalled();
        expect(screen.getByText(/Your start is past this forecast/)).toBeInTheDocument();
    });

    it('a start moved past the forecast, or cleared, hands the timeline back to now once', () => {
        const startMs = Date.parse('2026-10-10T12:00:00Z');
        const w = weather();
        const view = render(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs })} />);
        expect(w.setWindHour).toHaveBeenCalledWith(6.5);
        expect(w.followWindNow).not.toHaveBeenCalled();
        // Four days out: beyond the 48 h grid.
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs: REF_MS + 96 * HOUR })} />);
        expect(w.followWindNow).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Your start is past this forecast/)).toBeInTheDocument();
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs: REF_MS + 97 * HOUR })} />);
        expect(w.followWindNow).toHaveBeenCalledTimes(1);
        // Back inside, then cleared to "now".
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs })} />);
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs: null })} />);
        expect(w.followWindNow).toHaveBeenCalledTimes(2);
    });

    it('a hand scrub is never pulled back to now by a later start change', () => {
        const startMs = Date.parse('2026-10-10T12:00:00Z');
        const w = weather({ windHour: 6.5 });
        const view = render(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs })} />);
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Wind timeline' }), { key: 'ArrowRight' });
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs: null })} />);
        expect(w.followWindNow).not.toHaveBeenCalled();
    });

    it('a hand scrub wins afterwards: the start is not put back', () => {
        vi.useFakeTimers({ now: NOW });
        const startMs = Date.parse('2026-10-10T12:00:00Z');
        const w = weather({ windHour: 6.5 });
        render(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs })} />);
        expect(w.setWindHour).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Wind timeline' }), { key: 'ArrowRight' });
        expect(w.setWindHour).toHaveBeenCalledTimes(2);
        expect(w.setWindHour).toHaveBeenLastCalledWith(8);
        act(() => vi.advanceTimersByTime(10 * 60_000));
        expect(w.setWindHour).toHaveBeenCalledTimes(2);
    });

    it('left alone, the start holds past the five-minute hand-scrub cooldown', () => {
        vi.useFakeTimers({ now: NOW });
        const startMs = Date.parse('2026-10-10T12:00:00Z');
        const w = weather({ windHour: 6.5 });
        render(<MapWeatherControls {...controls} weather={w} desk={desk({ startMs })} />);
        act(() => vi.advanceTimersByTime(6 * 60_000));
        expect(vi.mocked(w.setWindHour).mock.calls.every(([frame]) => frame === 6.5)).toBe(true);
        expect(vi.mocked(w.setWindHour).mock.calls.length).toBeGreaterThan(4);
    });
});

describe('where the models disagree, the desk says so', () => {
    const line = () => screen.findByTestId('desk-wind-agreement');

    it('splits: "Models split here Saturday: strongest wind 12-28 kt across 7 of 7 models"', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 13, 12, 12, 28), seven(10, 10, 10, 10, 10, 10, 10)]),
        );
        // 12:00 UTC Saturday at the Solent.
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk()} />);
        expect(await line()).toHaveTextContent(
            'Models split here Saturday: strongest wind 12-28 kt across 7 of 7 models',
        );
        expect(queryModelSpread).toHaveBeenCalledWith(SOLENT.lat, SOLENT.lon, { passive: true });
        expect((await line()).querySelector('svg path')).not.toBeNull();
    });

    // Review 2026-10-10: the range is the seven models' numbers, so each
    // provider is credited under its own licence, ECCC in its own words.
    it('credits every model it compared, each under its own licence', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 13, 12, 12, 28), seven(10, 10, 10, 10, 10, 10, 10)]),
        );
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk()} />);
        await line();
        expect(await screen.findByTestId('desk-wind-compared')).toHaveTextContent(
            'Compared via Open-Meteo: DWD, ECMWF, JMA (CC BY 4.0); UK Met Office (CC BY-SA 4.0); NOAA (public domain); Data Source: Environment and Climate Change Canada (ECCC Data Services End-use Licence)',
        );
    });

    it('a model that sent no wind is not credited; nothing compared, no credit', async () => {
        const block = spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 13, 12, 12, 28)]);
        const gem = block.atmos!.models[6];
        gem.values.wind_speed_10m = gem.values.wind_speed_10m.map(() => null);
        vi.mocked(queryModelSpread).mockResolvedValue(block);
        const view = render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk()} />);
        const credit = await screen.findByTestId('desk-wind-compared');
        expect(credit).toHaveTextContent('NOAA (public domain)');
        expect(credit).not.toHaveTextContent('Canada');
        view.unmount();
        vi.mocked(queryModelSpread).mockResolvedValue({ atmos: null, marine: null, unreachable: ['atmos'] });
        render(
            <MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk({ point: NOUMEA })} />,
        );
        expect(await line()).toHaveTextContent('Model agreement not known here');
        expect(screen.queryByTestId('desk-wind-compared')).toBeNull();
    });

    it('at the trace’s first pin it says "at your start", not "here"', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 13, 12, 12, 28), seven(10, 10, 10, 10, 10, 10, 10)]),
        );
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk({ pinned: true })} />);
        expect(await line()).toHaveTextContent(
            'Models split at your start Saturday: strongest wind 12-28 kt across 7 of 7 models',
        );
    });

    it('while a model’s grid loads (no scrubbed hour) the last day’s verdict holds', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 13, 12, 12, 28), seven(10, 10, 10, 11, 10, 10, 10)]),
        );
        // 12:00 UTC Sunday, a day after today.
        const view = render(<MapWeatherControls {...controls} weather={weather({ windHour: 30.5 })} desk={desk()} />);
        expect(await line()).toHaveTextContent('Models agree here Sunday: strongest wind 10-11 kt');
        // A model chip: WindStore clears the grid until the new model's lands.
        view.rerender(
            <MapWeatherControls
                {...controls}
                weather={weather({ windHour: 30.5, windState: { loading: true, error: null, grid: null } })}
                desk={desk()}
            />,
        );
        await act(async () => Promise.resolve());
        await act(async () => Promise.resolve());
        expect(await line()).toHaveTextContent('Models agree here Sunday: strongest wind 10-11 kt');
    });

    it('this afternoon reads today, though its noon is before the comparison’s first hour', async () => {
        // 14:00 at the Solent; the comparison starts at the current hour, as the proxy answers it.
        vi.setSystemTime(new Date('2026-10-10T13:00:00Z'));
        const block = spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 13, 12, 12, 28)]);
        const from = block.atmos!.times.findIndex((t) => t >= Date.parse('2026-10-10T13:00:00Z'));
        block.atmos!.times = block.atmos!.times.slice(from);
        const peaks = seven(12, 12, 12, 13, 12, 12, 28);
        block.atmos!.models.forEach((m, k) => {
            for (const key of Object.keys(m.values) as Array<keyof typeof m.values>)
                m.values[key] = m.values[key].slice(from);
            m.values.wind_speed_10m = m.values.wind_speed_10m.map((v) => (v == null ? null : peaks[k]));
        });
        vi.mocked(queryModelSpread).mockResolvedValue(block);
        // The scrubber near now: 13:30 UTC.
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 8, windNowIdx: 8 })} desk={desk()} />);
        expect(await line()).toHaveTextContent(
            'Models split here Saturday: strongest wind 12-28 kt across 7 of 7 models',
        );
    });

    it('agrees, in Noumea: seven models within 2 kt', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T13:00:00Z', [seven(14, 15, 14, 16, 15, 14, 15), seven(14, 14, 14, 14, 14, 14, 14)]),
        );
        // 12:00 UTC Saturday is 23:00 Saturday in Noumea.
        render(
            <MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk({ point: NOUMEA })} />,
        );
        expect(await line()).toHaveTextContent(
            'Models agree here Saturday: strongest wind 14-16 kt across 7 of 7 models',
        );
    });

    it('some spread', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T23:00:00Z', [seven(12, 13, 15, 16, 18, 15, 14), seven(10, 10, 10, 10, 10, 10, 10)]),
        );
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk()} />);
        expect(await line()).toHaveTextContent(
            'Some spread here Saturday: strongest wind 12-18 kt across 7 of 7 models',
        );
    });

    it('a thin day says "only 4 of 7 models"', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread('2026-10-09T23:00:00Z', [seven(12, 12, 12, 12, 12, 12, 12), [11, 12, 12, 13, null, null, null]]),
        );
        // 12:00 UTC Sunday: 30.5 h after the run.
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 30.5 })} desk={desk()} />);
        expect(await line()).toHaveTextContent(
            'Models agree here Sunday: strongest wind 11-13 kt across only 4 of 7 models',
        );
    });

    it('not known when the comparison cannot be had', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue({ atmos: null, marine: null, unreachable: ['atmos', 'marine'] });
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} desk={desk()} />);
        expect(await line()).toHaveTextContent('Model agreement not known here');
    });

    it('never on the chart panel: no line, no request', () => {
        render(<MapWeatherControls {...controls} weather={weather({ windHour: 6.5 })} />);
        expect(screen.queryByTestId('desk-wind-agreement')).toBeNull();
        expect(queryModelSpread).not.toHaveBeenCalled();
    });

    it('after a refusal (a 429 among them) it stops asking until the panel is next opened', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue({ atmos: null, marine: null, unreachable: ['atmos'] });
        const w = weather({ windHour: 6.5 });
        const view = render(<MapWeatherControls {...controls} weather={w} desk={desk()} />);
        expect(await line()).toHaveTextContent('Model agreement not known here');
        expect(queryModelSpread).toHaveBeenCalledTimes(1);
        // Pinned somewhere else: still silent.
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ point: NOUMEA })} />);
        await act(async () => Promise.resolve());
        expect(queryModelSpread).toHaveBeenCalledTimes(1);
        expect(await line()).toHaveTextContent('Model agreement not known here');
        // Closed and opened again: it asks once more.
        view.rerender(<MapWeatherControls {...controls} controlsHidden weather={w} desk={desk({ point: NOUMEA })} />);
        view.rerender(<MapWeatherControls {...controls} weather={w} desk={desk({ point: NOUMEA })} />);
        await waitFor(() => expect(queryModelSpread).toHaveBeenCalledTimes(2));
    });
});
