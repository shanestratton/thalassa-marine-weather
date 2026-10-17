import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MeasuredBuoysLayer from '../components/map/MeasuredBuoysLayer';
import BuoyCard from '../components/map/BuoyCard';
import { ownedVectorFixture } from './helpers/ownedVectorFixture';
import { openWeatherEvidenceSession, type WeatherEvidenceSession } from '../services/weather/evidenceSession';
import { decodeEvidenceIndex, decodeEvidencePointer, decodeMeasuredBuoy } from '../services/weather/evidenceContract';
import {
    BUOY_LAYER_POINTS,
    BUOY_LAYER_SOURCE,
    buoyAge,
    buoyGraph,
    thinnedBuoyStations,
} from '../services/weather/buoyPresentation';
vi.mock('../services/weather/evidenceSession', () => ({ openWeatherEvidenceSession: vi.fn() }));
vi.mock('../components/Toast', () => ({ toast: { persistentError: vi.fn(() => 1), dismiss: vi.fn() } }));
const json = (name: string) =>
    JSON.parse(readFileSync(resolve('tests/fixtures/weather-evidence141', name + '.txt'), 'utf8'));
const pointer = json('pointer-buoys');
const index = decodeEvidenceIndex(json('index-buoys'), decodeEvidencePointer(pointer, 'buoys', pointer.generatedAt));
const raw = json('detail-buoys-ndbc');
const station = index.stations.find((row) => row.key === raw.key)!;
const detail = decodeMeasuredBuoy(raw, station, index.generatedAt);
let current = true;
const close = vi.fn(() => {
    current = false;
});
const readStation = vi.fn<WeatherEvidenceSession['readStation']>();
const session: WeatherEvidenceSession = { index, close, readStation, isCurrent: () => current };
function mapFixture() {
    const fixture = ownedVectorFixture();
    const { map } = fixture;
    Object.assign(map, {
        getContainer: () => ({ clientWidth: 375, clientHeight: 667 }),
        getCenter: () => ({ lng: station.lon, lat: station.lat }),
        project: ([lon]: [number, number]) => ({ x: lon === station.lon ? 100 : 10000, y: 100 }),
        queryRenderedFeatures: vi.fn(() => [{ source: BUOY_LAYER_SOURCE, properties: { key: station.key } }]),
    });
    return fixture;
}
beforeEach(() => {
    current = true;
    vi.spyOn(Date, 'now').mockReturnValue(pointer.generatedAt * 1000 + 1000);
    close.mockClear();
    readStation.mockReset().mockResolvedValue(detail);
    vi.mocked(openWeatherEvidenceSession).mockReset().mockResolvedValue(session);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
describe('measured buoy source and map ownership', () => {
    it('does no request while off and clears owned geometry on retirement', async () => {
        const f = mapFixture();
        const onCredit = vi.fn(),
            onInteractionChange = vi.fn();
        const props = {
            mapRef: f.mapRef,
            mapReady: true,
            active: false,
            canInteract: true,
            onCredit,
            onInteractionChange,
        };
        const view = render(<MeasuredBuoysLayer {...props} />);
        expect(openWeatherEvidenceSession).not.toHaveBeenCalled();
        view.rerender(<MeasuredBuoysLayer {...props} active />);
        await waitFor(() => expect(f.map.sources.has(BUOY_LAYER_SOURCE)).toBe(true));
        act(() => f.map.emit('sourcedata', { sourceId: BUOY_LAYER_SOURCE, sourceDataType: 'content' }));
        expect(f.map.getLayer(BUOY_LAYER_POINTS)).toBeTruthy();
        expect(onCredit.mock.lastCall?.[0]?.text).toContain('preliminary');
        view.rerender(<MeasuredBuoysLayer {...props} />);
        await waitFor(() => expect(f.map.sources.has(BUOY_LAYER_SOURCE)).toBe(false));
        expect(close).toHaveBeenCalled();
        expect(openWeatherEvidenceSession).toHaveBeenCalledTimes(1);
    });
    it('admits only foreground reads and retires geometry and request ownership immediately on background', async () => {
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        const f = mapFixture();
        const props = {
            mapRef: f.mapRef,
            mapReady: true,
            active: true,
            canInteract: true,
            onCredit: vi.fn(),
            onInteractionChange: vi.fn(),
        };
        render(<MeasuredBuoysLayer {...props} />);
        expect(openWeatherEvidenceSession).not.toHaveBeenCalled();
        visibility.mockReturnValue('visible');
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await waitFor(() => expect(f.map.sources.has(BUOY_LAYER_SOURCE)).toBe(true));
        visibility.mockReturnValue('hidden');
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await waitFor(() => expect(f.map.sources.has(BUOY_LAYER_SOURCE)).toBe(false));
        expect(close).toHaveBeenCalled();
        expect(vi.mocked(openWeatherEvidenceSession).mock.calls[0][1].aborted).toBe(true);
        expect(openWeatherEvidenceSession).toHaveBeenCalledTimes(1);
    });
    it('opens real history through a44px query only when competing gestures release the chart', async () => {
        const f = mapFixture();
        const onCredit = vi.fn(),
            onInteractionChange = vi.fn();
        const props = {
            mapRef: f.mapRef,
            mapReady: true,
            active: true,
            canInteract: false,
            onCredit,
            onInteractionChange,
        };
        const view = render(<MeasuredBuoysLayer {...props} />);
        await waitFor(() => expect(f.map.sources.has(BUOY_LAYER_SOURCE)).toBe(true));
        const preventDefault = vi.fn();
        const event = { point: { x: 100, y: 100 }, originalEvent: { defaultPrevented: false }, preventDefault };
        act(() => f.map.emit('click', event));
        expect(readStation).not.toHaveBeenCalled();
        view.rerender(<MeasuredBuoysLayer {...props} canInteract />);
        act(() => f.map.emit('click', event));
        await screen.findByRole('img', { name: /72-hour measured waves/ });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(
            (f.map as unknown as { queryRenderedFeatures: ReturnType<typeof vi.fn> }).queryRenderedFeatures,
        ).toHaveBeenCalledWith(
            [
                [78, 78],
                [122, 122],
            ],
            { layers: [BUOY_LAYER_POINTS] },
        );
        expect(onInteractionChange).toHaveBeenCalledWith(true);
        expect(screen.getByText(/No captured forecast history is available yet/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(onInteractionChange).toHaveBeenLastCalledWith(false);
    });
    it('aborts and drops a late detail when switched off, without restarting a fetch', async () => {
        const f = mapFixture();
        let release!: (value: typeof detail) => void;
        readStation.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const props = {
            mapRef: f.mapRef,
            mapReady: true,
            active: true,
            canInteract: true,
            onCredit: vi.fn(),
            onInteractionChange: vi.fn(),
        };
        const view = render(<MeasuredBuoysLayer {...props} />);
        await waitFor(() => expect(f.map.sources.has(BUOY_LAYER_SOURCE)).toBe(true));
        act(() =>
            f.map.emit('click', {
                point: { x: 100, y: 100 },
                originalEvent: { defaultPrevented: false },
                preventDefault() {},
            }),
        );
        await waitFor(() => expect(readStation).toHaveBeenCalledOnce());
        view.rerender(<MeasuredBuoysLayer {...props} active={false} />);
        await act(async () => release(detail));
        expect(readStation.mock.calls[0][1]?.aborted).toBe(true);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(openWeatherEvidenceSession).toHaveBeenCalledOnce();
    });
});
describe('bounded measured graph and thinning', () => {
    it('keeps real zero samples and gaps as separate dots, not joined forecast truth', () => {
        const synthetic = {
            ...detail,
            measured: [
                [index.generatedAt - 3600, 0],
                [index.generatedAt, 2],
            ] as const,
            issuedForecasts: [],
        };
        const graph = buoyGraph(synthetic, index.generatedAt * 1000);
        expect(graph.measured.match(/M/g)).toHaveLength(2);
        expect(graph.measured).not.toMatch(/[LC]/);
        expect(graph.issued).toEqual([]);
        expect(graph.start).toBe(index.generatedAt - 72 * 3600);
        expect(buoyAge(index.generatedAt, index.generatedAt * 1000)).toBe('0 min ago');
    });
    it('limits64viewport dots, rejects actual expiry and enforces44px Euclidean spacing across cell edges', () => {
        const points = Array.from({ length: 100 }, (_, i) => ({ ...station, key: String(i), lon: i }));
        const visible = thinnedBuoyStations(
            points,
            index.generatedAt * 1000,
            (row) => ({ x: Number(row.key) * 44, y: 30 }),
            10000,
            100,
        );
        expect(visible).toHaveLength(64);
        expect(
            thinnedBuoyStations(
                points.slice(0, 2),
                index.generatedAt * 1000,
                (row) => ({ x: 43 + Number(row.key) * 2, y: 0 }),
                375,
                667,
            ),
        ).toHaveLength(1);
        expect(thinnedBuoyStations([station], station.expiresAt * 1000, () => ({ x: 10, y: 10 }), 375, 667)).toEqual(
            [],
        );
        expect(thinnedBuoyStations([station], index.generatedAt * 1000, () => ({ x: NaN, y: 10 }), 375, 667)).toEqual(
            [],
        );
    });
    it('keeps original provisional labels and hides expired graph/data', () => {
        const qldRaw = json('detail-buoys-qld-des');
        const qld = index.stations.find((s) => s.key === qldRaw.key)!;
        const value = decodeMeasuredBuoy(qldRaw, qld, index.generatedAt);
        const view = render(<BuoyCard station={qld} detail={value} message="" onClose={vi.fn()} />);
        expect(screen.getByText(/Provisional measurements are not scored/)).toBeInTheDocument();
        vi.spyOn(Date, 'now').mockReturnValue(qld.expiresAt * 1000);
        view.rerender(<BuoyCard station={qld} detail={value} message="" onClose={vi.fn()} />);
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
        expect(screen.getByText(/· expired/)).toBeInTheDocument();
    });
});
