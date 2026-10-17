/**
 * The point meteogram (131-02), on the real component: 'All metrics' in a
 * metric deep-dive opens one stacked seven-day picture of the spot, wind and
 * gusts against the boat's limits with the models' spread, waves and period,
 * rain, and pressure with its fast falls; nights shaded, times on the place's
 * clock with a phone-time toggle, the model named and credited; centred and
 * clear of the tab bar; hand-drawn and lazy. Fictional readings off Brisbane.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/ModelSpreadService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weather/ModelSpreadService')>()),
    queryModelSpread: vi.fn(),
}));
vi.mock('../services/weather/api/weatherkit', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weather/api/weatherkit')>()),
    fetchWeatherKitHistory: vi.fn().mockResolvedValue([]),
}));

import { queryModelSpread, type AtmosVar, type ModelSpreadResult } from '../services/weather/ModelSpreadService';
import { MODEL_ATTRIBUTION_LINE, ECCC_LICENCE } from '../services/weather/forecastModels';
import { MODERATE_WINDOW } from '../services/vesselWindowThresholds';
import { Meteogram } from '../components/weather/Meteogram';
import { MetricDeepDiveModal } from '../components/dashboard/hero/MetricDeepDiveModal';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import type { HourlyForecast, UnitPreferences } from '../types';

const H = 3_600_000;
/** 08:30 on Fri 16 Oct 2026 in Brisbane; the week opens at 08:00. */
const NOW = Date.UTC(2026, 9, 15, 22, 30);
const START = Date.UTC(2026, 9, 15, 22);
const BRISBANE = { lat: -27.47, lon: 153.03 };
const units: UnitPreferences = {
    speed: 'kts',
    temp: 'C',
    length: 'm',
    waveHeight: 'm',
    tideHeight: 'm',
    distance: 'nm',
    visibility: 'nm',
};

/** Open-Meteo-style hours: bare stamps on Brisbane's clock. */
function week(over: (i: number) => Partial<HourlyForecast> = () => ({})): HourlyForecast[] {
    return Array.from({ length: 170 }, (_, i) => {
        const wind = i >= 30 && i <= 34 ? 24 : 12;
        return {
            time: new Date(START + i * H + 10 * H).toISOString().slice(0, 16),
            windSpeed: wind,
            windGust: wind + 5,
            // 0.9 m of sea (feet, as stored) until the marine forecast stops at hour 72.
            waveHeight: i < 72 ? 3 : null,
            swellPeriod: i < 72 ? 8 : null,
            precipitation: i === 50 ? 3 : 0,
            precipChance: 20,
            // A front: down 1.5 hPa an hour from hour 100 to 108.
            pressure: i <= 100 ? 1016 : i <= 108 ? 1016 - 1.5 * (i - 100) : 1004,
            temperature: 22,
            condition: 'Clear',
            ...over(i),
        };
    });
}

function spread(models: [string, string][]): ModelSpreadResult {
    const times = Array.from({ length: 240 }, (_, i) => START + i * H);
    return {
        atmos: {
            times,
            models: models.map(([label, provider], k) => ({
                id: label.toLowerCase(),
                label,
                provider,
                hex: '#fff',
                values: { wind_speed_10m: times.map(() => 10 + k * 2) } as Record<AtmosVar, (number | null)[]>,
            })),
        },
        marine: null,
    };
}

const open = (props: Partial<React.ComponentProps<typeof Meteogram>> = {}) => {
    const onClose = vi.fn();
    render(
        <Meteogram
            onClose={onClose}
            hourly={week()}
            units={units}
            limits={MODERATE_WINDOW}
            coordinates={BRISBANE}
            timeZone="Australia/Brisbane"
            utcOffset={36_000}
            {...props}
        />,
    );
    return { onClose, dialog: screen.getByRole('dialog', { name: 'All metrics, next 7 days' }) };
};
const panel = (key: string) => screen.getByTestId(`meteogram-${key}`);
const read = (key: string) => within(panel(key)).getByRole('heading').nextElementSibling as HTMLElement;

const zone = process.env.TZ;
beforeAll(() => {
    // The phone is in Honolulu; the boat is off Brisbane.
    process.env.TZ = 'Pacific/Honolulu';
});
afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
});
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(queryModelSpread).mockReset();
    vi.mocked(queryModelSpread).mockResolvedValue({ atmos: null, marine: null });
    useUIStore.setState({ isOffline: false });
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, forecastModel: 'dwd_icon', offshoreModel: 'sg' } });
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('one stacked seven-day picture of the spot', () => {
    it('stacks wind and gusts, waves and period, rain and pressure under a week of days', async () => {
        open();
        expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
            'Wind and gusts',
            'Waves and period',
            'Rain',
            'Pressure',
        ]);
        const days = screen.getByTestId('meteogram-days').textContent;
        expect(days).toMatch(/^Fri 16Sat 17Sun 18Mon 19Tue 20Wed 21Thu 22/);
        await waitFor(() => expect(queryModelSpread).toHaveBeenCalled());
    });

    it('reads wind and gusts against the boat’s limits, red where they reach them', () => {
        open();
        expect(read('wind')).toHaveTextContent('Reaches your 22 kts limit Sat 14:00');
        expect(read('wind')).toHaveClass('text-red-300');
        // One clip each for the wind and the gust line, above its own limit.
        expect(panel('wind').querySelectorAll('clipPath')).toHaveLength(2);
    });

    it('names the gusts when they reach their limit before the wind reaches its own', () => {
        // Gusts at the 28 kt limit Saturday 02:00 (wind 20); the wind at 24 only on Monday.
        open({
            hourly: week((i) =>
                i === 18
                    ? { windSpeed: 20, windGust: 28 }
                    : i === 78
                      ? { windSpeed: 24, windGust: 27 }
                      : { windSpeed: 12, windGust: 17 },
            ),
        });
        expect(read('wind')).toHaveTextContent('Gusts reach your 28 kts limit Sat 02:00');
        expect(read('wind')).toHaveClass('text-red-300');
    });

    it('names the wind when it reaches its limit first, and the gusts when only they do', () => {
        open({
            hourly: week((i) =>
                i === 10 ? { windSpeed: 23, windGust: 25 } : i === 40 ? { windSpeed: 15, windGust: 30 } : {},
            ),
        });
        expect(read('wind')).toHaveTextContent('Reaches your 22 kts limit Fri 18:00');
        cleanup();
        open({ hourly: week((i) => (i === 40 ? { windSpeed: 18, windGust: 30 } : { windSpeed: 12, windGust: 17 })) });
        expect(read('wind')).toHaveTextContent('Gusts reach your 28 kts limit Sun 00:00');
    });

    it('says when the boat stays within its limits', () => {
        open({ hourly: week(() => ({ windSpeed: 10, windGust: 14 })) });
        expect(read('wind')).toHaveTextContent('Within your limits (22 kts, gusts 28)');
        expect(read('wind')).toHaveClass('text-emerald-300');
    });

    it('draws no line across a missing hour', () => {
        open({ hourly: week((i) => (i === 60 || i === 61 ? { windSpeed: null } : {})) });
        const wind = panel('wind').querySelector('path[stroke-width="2"]')!.getAttribute('d')!;
        expect(wind.match(/M/g)).toHaveLength(2);
    });

    it('marks the week past the end of the wave forecast', () => {
        open();
        expect(within(panel('sea')).getByText('No forecast')).toBeInTheDocument();
        expect(read('sea')).toHaveTextContent('Within your 1.8 m limit');
    });

    it('names the wettest hour, and the pressure’s fast fall in red', () => {
        open();
        expect(read('rain')).toHaveTextContent('Wettest hour Sun 10:00, 3 mm');
        expect(read('pressure')).toHaveTextContent('Falls 4.5 hPa in 3 h to Tue 15:00');
        expect(panel('pressure').querySelector('path[stroke="#f87171"]')!.getAttribute('d')).toMatch(/^M100 /);
    });

    it('reads a steady barometer in its words', () => {
        open({ hourly: week(() => ({ pressure: 1013 })) });
        expect(read('pressure')).toHaveTextContent('1013 hPa now, steady');
    });

    it('says so when a spot has no wave forecast at all', () => {
        open({ hourly: week(() => ({ waveHeight: null, swellPeriod: null })) });
        expect(read('sea')).toHaveTextContent('No wave forecast for this spot');
        expect(within(panel('sea')).getByText('No wave forecast')).toBeInTheDocument();
    });

    it('shades the seven nights at the spot', () => {
        open();
        const nights = panel('wind').querySelector('path[data-night]')!.getAttribute('d')!;
        expect(nights.match(/M/g)).toHaveLength(7);
    });
});

describe('the place’s clock, and the phone’s on the toggle', () => {
    it('shows the place’s times first, the phone’s on a press', () => {
        open();
        const place = screen.getByRole('button', { name: 'Place time' });
        const phone = screen.getByRole('button', { name: 'Phone time' });
        expect(place).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText(/^The place's own clock/)).toBeInTheDocument();

        fireEvent.click(phone);
        expect(phone).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText(/^Your phone's clock/)).toBeInTheDocument();
        // 14:00 Saturday in Brisbane is 18:00 Friday in Honolulu.
        expect(read('wind')).toHaveTextContent('Reaches your 22 kts limit Fri 18:00');
        expect(screen.getByTestId('meteogram-days').textContent).toMatch(/^Thu 15Fri 16/);

        fireEvent.click(place);
        expect(read('wind')).toHaveTextContent('Sat 14:00');
    });

    it('offers only the phone’s clock when the place is unknown', () => {
        open({ coordinates: undefined, timeZone: undefined, utcOffset: undefined });
        expect(screen.queryByRole('group', { name: 'Times' })).toBeNull();
        expect(screen.getByText(/^Your phone's clock/)).toBeInTheDocument();
        expect(queryModelSpread).not.toHaveBeenCalled();
    });
});

describe('reading any hour', () => {
    it('steps through the hours from the keyboard, every panel at once', () => {
        open();
        const slider = screen.getByRole('slider', { name: 'Hour to read' });
        fireEvent.keyDown(slider, { key: 'End' });
        expect(slider).toHaveAttribute('aria-valuenow', '167');
        expect(slider.getAttribute('aria-valuetext')).toMatch(/^Fri 07:00: wind and gusts 12 kts, gust 17;/);
        expect(read('sea')).toHaveTextContent('No forecast');
        fireEvent.keyDown(slider, { key: 'Home' });
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        expect(slider.getAttribute('aria-valuetext')).toMatch(/^Fri 09:00/);
        expect(read('sea')).toHaveTextContent('0.9 m, 8 s');
        expect(read('pressure')).toHaveTextContent('1016 hPa');
    });

    it('gives the week’s summaries back when the slider loses focus', () => {
        open();
        const slider = screen.getByRole('slider', { name: 'Hour to read' });
        act(() => slider.focus());
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        expect(read('wind')).toHaveTextContent('12 kts, gust 17');
        act(() => screen.getByRole('button', { name: 'Close all metrics' }).focus());
        expect(read('wind')).toHaveTextContent('Reaches your 22 kts limit Sat 14:00');
    });

    describe('under a finger or the mouse', () => {
        /** 60 px across 336 is hour 30, Saturday 14:00, when the wind is 24 kts. */
        const slider = () => {
            const s = screen.getByRole('slider', { name: 'Hour to read' });
            vi.spyOn(s, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 336 } as DOMRect);
            return s;
        };
        // jsdom has no PointerEvent: a MouseEvent of the same type, given the pointer's own fields.
        const pointer = (
            target: Element,
            type: string,
            x: number,
            y = 100,
            pointerType = 'touch',
            relatedTarget: Element | null = null,
        ) =>
            act(() => {
                const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, relatedTarget });
                Object.defineProperties(e, { pointerType: { value: pointerType }, pointerId: { value: 1 } });
                target.dispatchEvent(e);
            });
        const summaries = () => {
            expect(read('wind')).toHaveTextContent('Reaches your 22 kts limit Sat 14:00');
            expect(read('pressure')).toHaveTextContent('Falls 4.5 hPa in 3 h to Tue 15:00');
        };

        it('reads the hour under a sideways drag, and gives the summaries back when the finger lifts', () => {
            open();
            const s = slider();
            pointer(s, 'pointerdown', 50);
            summaries();
            pointer(s, 'pointermove', 60, 101);
            expect(read('wind')).toHaveTextContent('24 kts, gust 29');
            expect(read('rain')).toHaveTextContent('0 mm, 20% chance');
            pointer(s, 'pointerup', 60, 101);
            summaries();
            expect(s.getAttribute('aria-valuetext')).toMatch(/^None chosen/);
        });

        it('leaves the summaries alone while the sheet scrolls over the panels', () => {
            open();
            const s = slider();
            pointer(s, 'pointerdown', 60, 300);
            pointer(s, 'pointermove', 62, 270);
            summaries();
            // The browser takes the gesture for its scroll.
            pointer(s, 'pointercancel', 62, 270);
            pointer(s, 'pointermove', 64, 200);
            summaries();
        });

        it('reads under a finger held still, until it lifts', () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            try {
                open();
                const s = slider();
                pointer(s, 'pointerdown', 60);
                act(() => vi.advanceTimersByTime(200));
                summaries();
                act(() => vi.advanceTimersByTime(100));
                expect(read('wind')).toHaveTextContent('24 kts, gust 29');
                pointer(s, 'pointerup', 60);
                summaries();
            } finally {
                vi.useRealTimers();
            }
        });

        it('reads under the mouse, until it leaves the panels', () => {
            open();
            const s = slider();
            pointer(s, 'pointermove', 60, 100, 'mouse');
            expect(read('wind')).toHaveTextContent('24 kts, gust 29');
            // React hears a pointer leaving as pointerout to somewhere outside it.
            pointer(s, 'pointerout', 400, 100, 'mouse', document.body);
            summaries();
        });
    });
});

describe('day names that never collide', () => {
    /** The row at 375 px (311 px of week) and each name about as wide as Verdana Bold draws it. */
    const ROW = 311;
    const perChar = 8.5;
    beforeEach(() => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const width =
                this.getAttribute('data-testid') === 'meteogram-days'
                    ? ROW
                    : this.tagName === 'SPAN'
                      ? (this.textContent ?? '').length * perChar
                      : 0;
            return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0 } as DOMRect;
        });
    });
    const names = () =>
        [...screen.getByTestId('meteogram-days').querySelectorAll<HTMLElement>('[data-day-name]')].map((n) => ({
            text: n.textContent!,
            l: (parseFloat(n.style.left) / 100) * ROW,
        }));

    it('drops to the weekdays at 375 px in a wide face, each clear of the next, the last part day giving way', () => {
        open();
        const shown = names();
        expect(shown.map((n) => n.text)).toEqual(['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
        shown.slice(1).forEach((n, i) => expect(n.l - shown[i].l).toBeGreaterThanOrEqual(3 * perChar + 6 - 1e-6));
        // The measuring probe is gone again.
        expect(screen.getByTestId('meteogram-days').querySelectorAll('span:not([data-day-name])')).toHaveLength(0);
    });

    it('fits the names again on the phone’s clock', () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Phone time' }));
        // Honolulu's Thursday at either end; its six whole days between.
        const texts = names().map((n) => n.text);
        expect(texts.filter((t) => t !== 'Thu')).toEqual(['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']);
    });
});

describe('the model, named and credited', () => {
    it('names the Glass’s model as the picker credits it', () => {
        open();
        expect(screen.getByTestId('meteogram-credit')).toHaveTextContent('Forecast: DWD ICON · CC BY 4.0');
    });

    it('names Auto and credits every source', () => {
        const settings = useSettingsStore.getState().settings;
        useSettingsStore.setState({ settings: { ...settings, forecastModel: 'best_match' } });
        open();
        const credit = screen.getByTestId('meteogram-credit');
        expect(credit).toHaveTextContent('Forecast: Auto, a blend of sources');
        expect(credit).toHaveTextContent(MODEL_ATTRIBUTION_LINE);
    });

    it('credits the offshore source offshore', () => {
        open({ offshore: true });
        expect(screen.getByTestId('meteogram-credit')).toHaveTextContent('Forecast: ECMWF IFS · CC BY 4.0');
    });

    it('draws the models’ spread from the comparison’s answer and credits its providers', async () => {
        vi.mocked(queryModelSpread).mockResolvedValue(
            spread([
                ['ICON', 'DWD'],
                ['ECMWF', 'ECMWF'],
                ['UKMO', 'UK Met Office'],
                ['GEM', 'Environment and Climate Change Canada'],
            ]),
        );
        open();
        expect(queryModelSpread).toHaveBeenCalledWith(BRISBANE.lat, BRISBANE.lon, { passive: true });
        const credit = screen.getByTestId('meteogram-credit');
        await waitFor(() =>
            expect(credit).toHaveTextContent(
                'Model spread via Open-Meteo: DWD, ECMWF (CC BY 4.0); UK Met Office (CC BY-SA 4.0); Data Source: Environment and Climate Change Canada',
            ),
        );
        expect(within(credit).getByRole('link', { name: ECCC_LICENCE })).toBeInTheDocument();
        expect(screen.getByTestId('meteogram-key')).toHaveTextContent('the green band the range of 4 models');
        expect(panel('wind').querySelector('path[opacity="0.2"]')!.getAttribute('d')).toMatch(/^M0 /);
    });

    it('asks nothing offline, and draws no spread', () => {
        useUIStore.setState({ isOffline: true });
        open();
        expect(queryModelSpread).not.toHaveBeenCalled();
        expect(screen.getByTestId('meteogram-key')).not.toHaveTextContent('range of');
    });
});

describe('a centred modal, clear of the tab bar', () => {
    it('sits above the tab bar and over the deep-dive', () => {
        const { dialog } = open();
        const overlay = dialog.closest('[data-overlay-layer]')!;
        expect(overlay).toHaveAttribute('data-overlay-layer', 'nested');
        expect(overlay.className).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
        expect(overlay.className).toContain('items-center');
    });

    it('closes from Close, the X, Escape and the backdrop, but not from inside', () => {
        const { onClose, dialog } = open();
        fireEvent.click(dialog);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close all metrics' }));
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        fireEvent.click(dialog.closest('[data-overlay-layer]')!);
        expect(onClose).toHaveBeenCalledTimes(4);
    });
});

describe('opened from a metric deep-dive', () => {
    it('opens over the deep-dive from All metrics, and closes back to it', async () => {
        render(
            <MetricDeepDiveModal
                metric="wind"
                onClose={vi.fn()}
                units={units}
                hourly={week()}
                forecast={[]}
                coordinates={BRISBANE}
                timeZone="Australia/Brisbane"
                utcOffset={36_000}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'All metrics' }));
        const meteogram = await screen.findByRole('dialog', { name: 'All metrics, next 7 days' });
        expect(within(meteogram).getByText('Reaches your 22 kts limit Sat 14:00')).toBeInTheDocument();
        fireEvent.click(within(meteogram).getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog', { name: 'All metrics, next 7 days' })).toBeNull();
        expect(screen.getByRole('dialog', { name: 'Wind' })).toBeInTheDocument();
    });
});

describe('hand-drawn and lazy', () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

    it('uses no chart library', () => {
        for (const file of ['components/weather/Meteogram.tsx', 'components/weather/meteogramModel.ts']) {
            const imports = [...read(file).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
            expect(imports.filter((s) => !s.startsWith('.') && s !== 'react')).toEqual([]);
        }
    });

    it('loads only when All metrics opens it', () => {
        const deepDive = read('components/dashboard/hero/MetricDeepDiveModal.tsx');
        expect(deepDive).toContain("import('../../weather/Meteogram')");
        expect(deepDive).not.toMatch(/from '\.\.\/\.\.\/weather\/Meteogram'/);
    });
});
