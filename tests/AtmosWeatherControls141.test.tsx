import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { AtmosDataset } from '../services/weather/api/atmosContract';
import type { AtmosSession, AtmosView } from '../services/weather/api/atmosSession';
import type { AtmosPresentation } from '../components/map/atmosPresentation';
import AtmosWeatherLayer from '../components/map/AtmosWeatherLayer';
import { useAtmosView } from '../components/map/useAtmosView';
import { renderHook } from '@testing-library/react';

const source = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../services/weather/api/atmosSession', async (load) => ({
    ...(await load<typeof import('../services/weather/api/atmosSession')>()),
    openAtmosSession: source.open,
}));
vi.mock('../components/map/useScalarGridOverlay', () => ({
    useScalarGridOverlay: (
        _map: unknown,
        _ready: boolean,
        options: { enabled: boolean; grid: unknown; sourceCurrent(): boolean },
    ) => (!options.enabled ? 'off' : options.grid && options.sourceCurrent() ? 'ready' : 'unavailable'),
}));
vi.mock('../components/map/usePressureSymbolOverlay', () => ({
    usePressureSymbolOverlay: (_map: unknown, _ready: boolean, enabled: boolean, view: AtmosView | null) =>
        !enabled ? 'off' : view?.isCurrent() ? 'ready' : 'unavailable',
}));

const RUN = Date.parse('2026-10-17T00:00:00Z'),
    HOUR = 3_600_000;
const owned: AtmosSession[] = [];
function makeSession(dataset: AtmosDataset, signal: AbortSignal, owner: () => boolean): AtmosSession {
    let closed = false;
    const current = () => !closed && !signal.aborted && owner();
    const grid = (value: number) => ({
        width: 2,
        height: 2,
        west: -1,
        south: -1,
        dx: 2,
        dy: 2,
        values: new Float32Array(4).fill(value),
        validMask: new Uint8Array(4).fill(1),
    });
    const session: AtmosSession = {
        manifest: {
            dataset,
            generation: `owned-${dataset}`,
            runMs: RUN,
            publishedMs: RUN + 4 * HOUR,
            files: Array.from({ length: dataset === 'gfs-atmos' ? 29 : 41 }, (_, step) => ({
                step,
                offset_hours: step * 6,
                data_time: '',
                filename: '',
                bytes: 1,
                sha256: '',
                content_type: 'application/octet-stream',
            })),
        },
        close: vi.fn(() => {
            closed = true;
        }),
        isCurrent: current,
        readAt: vi.fn(async (validMs, caller) => {
            if (validMs < RUN || validMs > RUN + (dataset === 'gfs-atmos' ? 168 : 240) * HOUR)
                throw new RangeError('Requested UTC outside source coverage');
            return {
                dataset,
                generation: session.manifest.generation,
                runMs: RUN,
                validMs,
                fields:
                    dataset === 'gfs-atmos'
                        ? {
                              gust: grid(12),
                              visibility: grid(5000),
                              pressure: grid(101200),
                              temperature: grid(290),
                              dewpoint: grid(289),
                          }
                        : { pressure: grid(101200) },
                isCurrent: () => current() && !caller?.aborted,
            };
        }),
    };
    owned.push(session);
    return session;
}
const mapRef = { current: null as mapboxgl.Map | null };
function Harness(props: {
    gust?: boolean;
    visibility?: boolean;
    pressure?: boolean;
    model?: string;
    follow?: number | null;
}) {
    const [presentation, setPresentation] = useState<AtmosPresentation>({ legend: null, credits: [] });
    return (
        <>
            <AtmosWeatherLayer
                mapRef={mapRef}
                mapReady
                gust={props.gust ?? false}
                visibility={props.visibility ?? false}
                pressure={props.pressure ?? false}
                pressureModel={props.model ?? 'ecmwf'}
                followWindMs={props.follow ?? null}
                standalonePressure={!props.gust && !props.visibility}
                point={{ lat: 0, lon: 0 }}
                onPresentation={setPresentation}
            />
            {presentation.legend}
            <div data-testid="credit-source">
                {presentation.credits.map((row) => (
                    <p key={row.key}>{row.text}</p>
                ))}
            </div>
        </>
    );
}
async function settle() {
    await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
    });
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN + 5 * HOUR);
    owned.length = 0;
    source.open.mockReset().mockImplementation(async (dataset, signal, owner) => makeSession(dataset, signal, owner));
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('actual atmospheric controls and caller-owned read hook', () => {
    it.each([
        { model: 'gfs', dataset: 'gfs-atmos', end: 168 },
        { model: 'ecmwf', dataset: 'ifs-pressure', end: 240 },
    ])('scrubs only the selected $model pressure UTC through its actual horizon', async ({ model, dataset, end }) => {
        render(<Harness pressure model={model} />);
        await settle();
        expect(source.open).toHaveBeenCalledTimes(1);
        expect(source.open.mock.calls[0][0]).toBe(dataset);
        const slider = screen.getByRole('slider', { name: 'Atmospheric forecast time' });
        expect(slider).toHaveAttribute('max', String(end));
        fireEvent.change(slider, { target: { value: String(end) } });
        await settle();
        expect(owned[0].readAt).toHaveBeenCalledTimes(2);
        expect(vi.mocked(owned[0].readAt).mock.calls.at(-1)?.[0]).toBe(RUN + end * HOUR);
        expect(screen.getByRole('status')).toHaveTextContent('Model forecast');
        fireEvent.click(screen.getByRole('button', { name: 'Info' }));
        expect(screen.getByTestId('credit-source')).toHaveTextContent(
            model === 'ecmwf' ? 'CC-BY-4.0' : 'NOAA public-domain',
        );
    });

    it('keeps unsupported selected pressure models held instead of fetching another model', async () => {
        render(<Harness pressure model="icon" />);
        await settle();
        expect(source.open).not.toHaveBeenCalled();
        expect(screen.getByRole('status')).toHaveTextContent('ICON long-range pressure unavailable');
        expect(screen.queryByRole('slider')).toBeNull();
        expect(screen.getByTestId('credit-source')).toHaveTextContent('No other model has been substituted');
    });

    it('shares one GFS bracket for gust and visibility and discloses the low-skill point proxy', async () => {
        render(<Harness gust visibility />);
        await settle();
        expect(source.open).toHaveBeenCalledTimes(1);
        expect(owned[0].readAt).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('region', { name: 'Atmospheric model controls' })).toHaveTextContent(
            'Model visibility · low skill',
        );
        expect(screen.getByText(/Weather point/)).toHaveTextContent('gust 23 kt; visibility 2.7 NM; T−Td 1.0°C');
        fireEvent.click(screen.getByRole('button', { name: 'Info' }));
        expect(screen.getByText(/Missing cells remain unknown/)).toHaveTextContent('not proof of fog');
    });

    it('uses the wind UTC exactly and holds an unknown or out-of-range wind time without a slider or endpoint substitution', async () => {
        const view = render(<Harness pressure model="gfs" follow={RUN + 120 * HOUR} />);
        await settle();
        expect(vi.mocked(owned[0].readAt).mock.calls.at(-1)?.[0]).toBe(RUN + 120 * HOUR);
        expect(screen.queryByRole('slider')).toBeNull();
        view.rerender(<Harness pressure model="gfs" follow={RUN + 169 * HOUR} />);
        await settle();
        expect(screen.getByRole('status')).toHaveTextContent('outside source coverage');
        expect(vi.mocked(owned[0].readAt).mock.calls.at(-1)?.[0]).toBe(RUN + 169 * HOUR);
        view.rerender(<Harness pressure model="gfs" follow={NaN} />);
        await settle();
        expect(screen.getByRole('status')).toHaveTextContent('Wind valid UTC is unknown');
        expect(owned[0].readAt).toHaveBeenCalledTimes(2);
    });

    it('plays only after the chosen frame is ready and stops at the actual final UTC', async () => {
        render(<Harness pressure model="gfs" />);
        await settle();
        fireEvent.change(screen.getByRole('slider'), { target: { value: '168' } });
        await settle();
        fireEvent.click(screen.getByRole('button', { name: 'Play' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(751);
        });
        expect(screen.getByRole('button', { name: 'Play' })).toHaveAttribute('aria-pressed', 'false');
        expect(owned[0].readAt).toHaveBeenCalledTimes(2);
    });

    it('retires a previous model lease and removes the control after user-off', async () => {
        const view = render(<Harness pressure model="gfs" />);
        await settle();
        view.rerender(<Harness pressure model="ecmwf" />);
        await settle();
        expect(owned[0].isCurrent()).toBe(false);
        expect(owned[0].close).toHaveBeenCalledTimes(1);
        expect(source.open.mock.calls.at(-1)?.[0]).toBe('ifs-pressure');
        view.rerender(<Harness />);
        await settle();
        expect(owned[1].isCurrent()).toBe(false);
        expect(screen.queryByRole('region', { name: 'Atmospheric model controls' })).toBeNull();
    });

    it('keeps a successful abort-aware view live until real caller retirement', async () => {
        const hook = renderHook(() => useAtmosView('ifs-pressure', RUN + 5 * HOUR, 0));
        await settle();
        expect(hook.result.current.view?.isCurrent()).toBe(true);
        expect(vi.mocked(owned[0].readAt).mock.calls[0][1]?.aborted).toBe(false);
        hook.unmount();
        expect(owned[0].isCurrent()).toBe(false);
    });

    it('closes a source acquired after unmount and never adopts its late frame', async () => {
        let resolve!: (session: AtmosSession) => void;
        source.open.mockImplementationOnce(
            () =>
                new Promise<AtmosSession>((done) => {
                    resolve = done;
                }),
        );
        const hook = renderHook(() => useAtmosView('ifs-pressure', RUN, 0));
        hook.unmount();
        const late = makeSession('ifs-pressure', new AbortController().signal, () => true);
        await act(async () => {
            resolve(late);
            await Promise.resolve();
        });
        expect(late.close).toHaveBeenCalledTimes(1);
        expect(late.readAt).not.toHaveBeenCalled();
    });

    it('refuses a late old UTC while a newer selection is already adopted', async () => {
        const hook = renderHook(({ time }) => useAtmosView('ifs-pressure', time, 0), { initialProps: { time: RUN } });
        await settle();
        let resolve!: (view: AtmosView) => void;
        const oldView = hook.result.current.view!;
        vi.mocked(owned[0].readAt).mockImplementationOnce(
            () =>
                new Promise<AtmosView>((done) => {
                    resolve = done;
                }),
        );
        hook.rerender({ time: RUN + HOUR });
        expect(hook.result.current.view).toBeNull();
        hook.rerender({ time: RUN + 2 * HOUR });
        await settle();
        await act(async () => {
            resolve(oldView);
            await Promise.resolve();
        });
        expect(hook.result.current.view?.validMs).toBe(RUN + 2 * HOUR);
    });
});
