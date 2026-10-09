/**
 * The Sounding sheet (build 125, SND): a skew-T of ECMWF's upper air with the
 * hour picker, plain-words readings, the honesty line and the CC BY 4.0
 * credit, plus its three ways of saying "no sounding": not available here,
 * the server needs its update, and a retryable failure. Fictional numbers,
 * off the Azores.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/sounding/soundingData', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weather/sounding/soundingData')>()),
    fetchSounding: vi.fn(),
}));

import { fetchSounding, type SoundingData } from '../services/weather/sounding/soundingData';
import { SoundingSheet } from '../components/sounding/SoundingSheet';

const fetchMock = vi.mocked(fetchSounding);
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 9, 9, 12);

const rhFor = (t: number, td: number) => 100 * Math.exp((17.625 * td) / (243.04 + td) - (17.625 * t) / (243.04 + t));

/** Off Faial, Azores (fictional): a dry lid near 1.5 km, a 60 kt jet. */
function azores(): SoundingData {
    const times = Array.from({ length: 76 }, (_, i) => T0 + i * HOUR_MS);
    const fill = <T,>(v: T) => times.map(() => v);
    const L: [number, number, number, number, number, number][] = [
        // p, T, Td, z, km/h, from
        [1000, 19, 15, 140, 25, 30],
        [925, 15, 12, 800, 30, 40],
        [850, 13, 0, 1520, 30, 60],
        [700, 4, -12, 3120, 35, 250],
        [500, -14, -30, 5760, 60, 260],
        [300, -40, -52, 9380, 100, 265],
        [250, -50, -60, 10650, 111.12, 270],
    ];
    return {
        lat: 38.5,
        lon: -28.75,
        elevation: 0,
        utcOffsetSeconds: 0,
        timezone: null,
        times,
        surface: {
            t: fill(20),
            td: fill(15.5),
            mslp: fill(1022),
            windKmh: fill(22),
            windFrom: fill(30),
            cape: fill(20),
        },
        levels: L.map(([p, t, td, z, kmh, dir]) => ({
            p,
            t: fill(t),
            rh: fill(rhFor(t, td)),
            z: times.map((_, i) => (p === 500 ? z - i : z)),
            windKmh: fill(kmh),
            windFrom: fill(dir),
        })),
    };
}

beforeEach(() => {
    fetchMock.mockReset();
});

async function openSheet(props: Partial<React.ComponentProps<typeof SoundingSheet>> = {}) {
    const onClose = vi.fn();
    render(
        <SoundingSheet
            lat={38.53}
            lon={-28.7}
            units={{ speed: 'kts', temp: 'C', length: 'm' }}
            palette="dark"
            onClose={onClose}
            {...props}
        />,
    );
    return { onClose, dialog: await screen.findByRole('dialog', { name: /sounding/i }) };
}

describe('SoundingSheet with data', () => {
    beforeEach(() => fetchMock.mockResolvedValue({ status: 'ok', data: azores() }));

    it('asks once, for the tapped point', async () => {
        await openSheet();
        await screen.findByTestId('sounding-headline');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0].slice(0, 2)).toEqual([38.53, -28.7]);
    });

    it('draws the skew-T with temperature, dewpoint, the rising parcel and barbs', async () => {
        await openSheet();
        const chart = await screen.findByRole('img', { name: /skew-t/i });
        expect(chart.querySelector('[data-line="temperature"]')).not.toBeNull();
        expect(chart.querySelector('[data-line="dewpoint"]')).not.toBeNull();
        expect(chart.querySelector('[data-line="parcel"]')).not.toBeNull();
        expect(chart.querySelectorAll('[data-barb]').length).toBeGreaterThan(0);
    });

    it('leads with one plain sentence and lists the readings with their numbers', async () => {
        await openSheet();
        expect((await screen.findByTestId('sounding-headline')).textContent).toBe(
            'Cloud base about 550 m. Tops capped near 1.5 km by the dry lid: flat cumulus, showers unlikely.',
        );
        for (const label of [
            'Cloud base',
            'Freezing level',
            'Instability',
            'Inversion',
            'Jet, 250 hPa',
            '500 hPa height',
        ])
            expect(screen.getByText(label)).toBeTruthy();
        expect(screen.getByText('60 kt from 270°')).toBeTruthy();
    });

    it('credits ECMWF and says how coarse seven levels are', async () => {
        await openSheet();
        const foot = await screen.findByTestId('sounding-credit');
        expect(foot.textContent).toContain('Forecast data: ECMWF');
        expect(foot.textContent).toContain('ECMWF IFS 0.25°, 7 levels: coarse, not an aviation sounding');
    });

    it('steps through the hours: Now, then every third hour', async () => {
        await openSheet();
        const now = await screen.findByRole('button', { name: 'Now' });
        expect(now.getAttribute('aria-pressed')).toBe('true');
        // Each chip is named in full: "15:00" alone comes round every day.
        const later = screen.getByRole('button', { name: 'Fri 9 Oct, 15:00' });
        expect(later.textContent).toBe('15:00');
        fireEvent.click(later);
        expect(later.getAttribute('aria-pressed')).toBe('true');
        expect(now.getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('sounding-when').textContent).toContain('15:00');
    });

    it('opens on the first hour it can draw when now is too thin, and keeps the picker', async () => {
        const thin = azores();
        thin.levels = thin.levels.map((l, k) => (k < 5 ? { ...l, t: l.t.map((v, i) => (i === 0 ? null : v)) } : l));
        fetchMock.mockResolvedValue({ status: 'ok', data: thin });
        await openSheet();
        const now = await screen.findByRole('button', { name: 'Now' });
        expect((now as HTMLButtonElement).disabled).toBe(true);
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Fri 9 Oct, 15:00' }).getAttribute('aria-pressed')).toBe('true'),
        );
        expect(screen.getByTestId('sounding-headline')).toBeTruthy();
    });

    it('speaks the skipper’s units and says barbs stay in knots', async () => {
        await openSheet({ units: { speed: 'mph', temp: 'F', length: 'ft' } });
        expect(await screen.findByText('69 mph from 270°')).toBeTruthy();
        // In the foot where there is room (a short screen hides it), and always on the barb itself.
        expect(screen.getByTestId('sounding-credit').textContent).toContain('Barbs in knots.');
        const jet = document.querySelector('[data-barb="250 hPa"] title');
        expect(jet?.textContent).toBe('250 hPa: 69 mph from 270°, drawn as 60 kt');
    });

    it('draws barb feathers on the low-pressure side: north of a westerly up here, south of it down south', async () => {
        const feather = () => {
            const line = document.querySelector('[data-barb="250 hPa"] line:nth-of-type(2)') as SVGLineElement;
            return Number(line.getAttribute('y2')) - Number(line.getAttribute('y1'));
        };
        const { unmount } = render(
            <SoundingSheet lat={38.53} lon={-28.7} palette="dark" onClose={vi.fn()} units={{ speed: 'kts' }} />,
        );
        await screen.findByTestId('sounding-headline');
        expect(document.querySelector('[data-barb="250 hPa"]')?.getAttribute('data-feathers')).toBe('north');
        // A westerly: the staff points west, the feathers point up the screen (north).
        expect(feather()).toBeLessThan(0);
        unmount();

        fetchMock.mockResolvedValue({ status: 'ok', data: { ...azores(), lat: -38.5, lon: 150 } }); // the Tasman
        render(<SoundingSheet lat={-38.53} lon={150} palette="dark" onClose={vi.fn()} units={{ speed: 'kts' }} />);
        await screen.findByTestId('sounding-headline');
        expect(document.querySelector('[data-barb="250 hPa"]')?.getAttribute('data-feathers')).toBe('south');
        expect(feather()).toBeGreaterThan(0);
    });

    it('labels the cloud base on the diagram in its own words, fog included', async () => {
        const fog = azores();
        fog.surface.td = fog.surface.t.map(() => 19.95);
        fetchMock.mockResolvedValue({ status: 'ok', data: fog });
        await openSheet();
        const chart = await screen.findByRole('img', { name: /skew-t/i });
        expect([...chart.querySelectorAll('text')].map((t) => t.textContent)).toContain('cloud base: surface');
    });

    it('names the real place for a tap past the antimeridian when there is no answer to name it', async () => {
        fetchMock.mockResolvedValue({ status: 'unavailable' });
        render(<SoundingSheet lat={-18.65} lon={186} palette="dark" onClose={vi.fn()} />);
        await screen.findByText(/isn.t available for this point/i);
        expect(screen.getByRole('dialog').textContent).toContain('18.65°S 174.00°W');
    });

    it('wears the palette it is given, red at night', async () => {
        const { dialog } = await openSheet({ palette: 'night' });
        expect(dialog.closest('[data-palette]')?.getAttribute('data-palette')).toBe('night');
    });

    it('closes from its button and from Escape', async () => {
        const { onClose } = await openSheet();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

describe('SoundingSheet without data', () => {
    it('says the whole forecast is too thin, not just this hour, when no hour can be drawn', async () => {
        const thin = azores();
        thin.levels = thin.levels.map((l, k) => (k < 5 ? { ...l, t: l.t.map(() => null) } : l));
        fetchMock.mockResolvedValue({ status: 'ok', data: thin });
        await openSheet();
        expect(await screen.findByText('Too few levels in this forecast to draw a sounding.')).toBeTruthy();
        expect(screen.getAllByRole('button').filter((b) => b.hasAttribute('data-hour-chip'))).not.toHaveLength(0);
    });

    it('says plainly when upper air is not available here', async () => {
        fetchMock.mockResolvedValue({ status: 'unavailable' });
        await openSheet();
        expect(await screen.findByText(/isn.t available for this point/i)).toBeTruthy();
        expect(screen.queryByRole('img', { name: /skew-t/i })).toBeNull();
    });

    it('says soundings need the next server update when the proxy does not know the levels yet', async () => {
        fetchMock.mockResolvedValue({ status: 'needs-update' });
        await openSheet();
        expect(await screen.findByText(/soundings need the next server update/i)).toBeTruthy();
    });

    it('offers a retry after a failure, and retries', async () => {
        fetchMock.mockResolvedValueOnce({ status: 'error', message: 'offline' });
        fetchMock.mockResolvedValueOnce({ status: 'ok', data: azores() });
        await openSheet();
        const retry = await screen.findByRole('button', { name: /try again/i });
        await act(async () => {
            fireEvent.click(retry);
        });
        await waitFor(() => expect(screen.getByTestId('sounding-headline')).toBeTruthy());
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
