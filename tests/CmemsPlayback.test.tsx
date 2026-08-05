import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CMEMS_SCALAR_DWELL_MS,
    CMEMS_VECTOR_DWELL_MS,
    type CmemsFailureNotifier,
    type CmemsPlaybackConfig,
    isCmemsRenderedStepReady,
    isCmemsStepPresented,
    useCmemsAutoplay,
    useCmemsFailureBoundary,
} from '../components/map/useCmemsPlayback';
import {
    cmemsRenderedLayerState,
    type CmemsLayerLoadState,
    useCmemsGridRefresh,
} from '../components/map/useCmemsGridRefresh';
import type { WindGrid } from '../services/weather/windField';

function grid(step: number): WindGrid {
    const u = new Array<Float32Array>(5);
    const v = new Array<Float32Array>(5);
    u[step] = new Float32Array([0.2]);
    v[step] = new Float32Array([0.1]);
    return {
        u,
        v,
        speed: new Array<Float32Array>(5),
        width: 1,
        height: 1,
        lats: [0],
        lons: [0],
        north: 0,
        south: 0,
        west: 0,
        east: 0,
        totalHours: 5,
        sourceStep: step,
        sourceGeneration: `g-step-${step}`,
        verifiedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
    };
}

function SlowPlaybackHarness({
    dwellMs,
    fetchGrid,
    releaseGrid,
}: {
    dwellMs: number;
    fetchGrid: (step: number) => Promise<WindGrid | null>;
    releaseGrid: () => void;
}) {
    const [step, setStep] = React.useState(0);
    const [playing, setPlaying] = React.useState(true);
    const refresh = useCmemsGridRefresh(true, true, step, fetchGrid, releaseGrid);
    const status = cmemsRenderedLayerState(
        refresh,
        true,
        true,
        true,
        refresh.phase === 'ready'
            ? {
                  phase: 'ready',
                  attempt: refresh.attempt,
                  verifiedStep: refresh.verifiedStep,
                  sourceGeneration: refresh.sourceGeneration,
              }
            : null,
    );
    useCmemsAutoplay({
        layer: 'currents',
        label: 'Currents',
        visible: true,
        playing,
        step,
        totalSteps: 5,
        dwellMs,
        status,
        setStep,
        setPlaying,
        setLayerVisibility: () => undefined,
    });
    return <div>{`step-${step} phase-${status.phase} attempt-${status.attempt}`}</div>;
}

function PlaybackHarness({ config }: { config: CmemsPlaybackConfig }) {
    useCmemsAutoplay(config);
    return null;
}

function FailureHarness({ config, notify }: { config: CmemsPlaybackConfig; notify: CmemsFailureNotifier }) {
    useCmemsFailureBoundary(config, notify);
    return null;
}

function RecoveryHarness({
    fetchGrid,
    releaseGrid,
    notify,
}: {
    fetchGrid: (step: number) => Promise<WindGrid | null>;
    releaseGrid: () => void;
    notify: CmemsFailureNotifier;
}) {
    const [visible, setVisible] = React.useState(true);
    const [playing, setPlaying] = React.useState(true);
    const refresh = useCmemsGridRefresh(true, visible, 0, fetchGrid, releaseGrid);
    useCmemsFailureBoundary(
        visible
            ? {
                  layer: 'currents',
                  label: 'Currents',
                  visible,
                  playing,
                  step: 0,
                  totalSteps: 5,
                  dwellMs: CMEMS_VECTOR_DWELL_MS,
                  status: refresh,
                  setStep: () => undefined,
                  setPlaying,
                  setLayerVisibility: (_layer, nextVisible) => setVisible(nextVisible),
              }
            : null,
        notify,
    );
    return <div>{`visible-${visible} playing-${playing} phase-${refresh.phase} attempt-${refresh.attempt}`}</div>;
}

const ready = (step: number, attempt = 1): CmemsLayerLoadState => ({
    phase: 'ready',
    requestedStep: step,
    verifiedStep: step,
    sourceGeneration: `g-${step}`,
    presentation: 'visible',
    attempt,
    retry: vi.fn(),
});

describe('CMEMS load-aware playback', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        ['vector', CMEMS_VECTOR_DWELL_MS],
        ['scalar', CMEMS_SCALAR_DWELL_MS],
    ])('waits for a slow %s frame and then gives it a full dwell', async (_kind, dwellMs) => {
        vi.useFakeTimers();
        const fetchGrid = vi.fn(
            (step: number) => new Promise<WindGrid>((resolve) => setTimeout(() => resolve(grid(step)), 3_000)),
        );
        const releaseGrid = vi.fn();
        render(<SlowPlaybackHarness dwellMs={dwellMs} fetchGrid={fetchGrid} releaseGrid={releaseGrid} />);

        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(fetchGrid).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(2_998));
        expect(screen.getByText(/step-0 phase-loading/)).toBeInTheDocument();
        expect(releaseGrid).not.toHaveBeenCalled();

        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(screen.getByText(/step-0 phase-ready/)).toBeInTheDocument();
        await act(async () => vi.advanceTimersByTimeAsync(dwellMs - 1));
        expect(screen.getByText(/step-0 phase-ready/)).toBeInTheDocument();
        expect(releaseGrid).not.toHaveBeenCalled();

        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(screen.getByText(/step-1 phase-loading/)).toBeInTheDocument();
        expect(releaseGrid).toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(fetchGrid).toHaveBeenLastCalledWith(1);
    });

    it('cancels an in-progress dwell when the requested step changes', async () => {
        vi.useFakeTimers();
        const setStep = vi.fn();
        const base = {
            layer: 'currents' as const,
            label: 'Currents',
            visible: true,
            playing: true,
            totalSteps: 5,
            dwellMs: CMEMS_VECTOR_DWELL_MS,
            setStep,
            setPlaying: vi.fn(),
            setLayerVisibility: vi.fn(),
        };
        const view = render(<PlaybackHarness config={{ ...base, step: 0, status: ready(0) }} />);
        await act(async () => vi.advanceTimersByTimeAsync(400));
        view.rerender(
            <PlaybackHarness
                config={{
                    ...base,
                    step: 1,
                    status: { ...ready(0), phase: 'loading', requestedStep: 1, verifiedStep: null },
                }}
            />,
        );
        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        expect(setStep).not.toHaveBeenCalled();
    });

    it('cancels an armed dwell when Mapbox can no longer prove the frame visible', async () => {
        vi.useFakeTimers();
        const setStep = vi.fn();
        const base = {
            layer: 'currents' as const,
            label: 'Currents',
            visible: true,
            playing: true,
            step: 0,
            totalSteps: 5,
            dwellMs: CMEMS_VECTOR_DWELL_MS,
            setStep,
            setPlaying: vi.fn(),
            setLayerVisibility: vi.fn(),
        };
        const view = render(<PlaybackHarness config={{ ...base, status: ready(0) }} />);
        await act(async () => vi.advanceTimersByTimeAsync(400));
        view.rerender(<PlaybackHarness config={{ ...base, status: { ...ready(0), presentation: 'hidden' } }} />);
        await act(async () => vi.advanceTimersByTimeAsync(1_000));

        expect(setStep).not.toHaveBeenCalled();
    });

    it('credits a stale painted step after teardown failure without treating the new request as ready', () => {
        const stuck: CmemsLayerLoadState = {
            ...ready(0),
            phase: 'error',
            requestedStep: 1,
            verifiedStep: 0,
            presentation: 'visible',
        };
        expect(isCmemsStepPresented(stuck)).toBe(true);
        expect(isCmemsRenderedStepReady(stuck, 1)).toBe(false);
        expect(isCmemsRenderedStepReady({ ...ready(1), presentation: 'hidden' }, 1)).toBe(false);
    });

    it('never claims a stuck-visible failure was switched off', () => {
        const notify = vi.fn<CmemsFailureNotifier>();
        const status: CmemsLayerLoadState = {
            ...ready(0),
            phase: 'error',
            presentation: 'visible',
        };
        render(
            <FailureHarness
                notify={notify}
                config={{
                    layer: 'currents',
                    label: 'Currents',
                    visible: true,
                    playing: true,
                    step: 0,
                    totalSteps: 5,
                    dwellMs: CMEMS_VECTOR_DWELL_MS,
                    status,
                    setStep: vi.fn(),
                    setPlaying: vi.fn(),
                    setLayerVisibility: vi.fn(),
                }}
            />,
        );

        expect(notify).toHaveBeenCalledOnce();
        expect(notify.mock.calls[0]?.[0]).toContain('stale layer still visible');
        expect(notify.mock.calls[0]?.[0]).not.toContain('switched off');
    });

    it('reports a later stale-visible transition from the same failed attempt', () => {
        const notify = vi.fn<CmemsFailureNotifier>();
        const setLayerVisibility = vi.fn();
        const base = {
            layer: 'currents' as const,
            label: 'Currents',
            visible: true,
            playing: true,
            step: 0,
            totalSteps: 5,
            dwellMs: CMEMS_VECTOR_DWELL_MS,
            setStep: vi.fn(),
            setPlaying: vi.fn(),
            setLayerVisibility,
        };
        const first: CmemsLayerLoadState = {
            ...ready(0),
            phase: 'error',
            presentation: 'absent',
        };
        const view = render(<FailureHarness notify={notify} config={{ ...base, status: first }} />);

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toContain('switched off');

        view.rerender(
            <FailureHarness notify={notify} config={{ ...base, status: { ...first, presentation: 'visible' } }} />,
        );

        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1]?.[0]).toContain('stale layer still visible');
    });

    it('deselects once on a terminal error and delayed Retry starts a fresh attempt', async () => {
        vi.useFakeTimers();
        const fetchGrid = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(grid(0));
        const releaseGrid = vi.fn();
        const notify = vi.fn<CmemsFailureNotifier>();
        render(<RecoveryHarness fetchGrid={fetchGrid} releaseGrid={releaseGrid} notify={notify} />);

        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(screen.getByText(/visible-false playing-false/)).toBeInTheDocument();
        expect(fetchGrid).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);

        await act(async () => vi.advanceTimersByTimeAsync(5_000));
        expect(notify).toHaveBeenCalledTimes(1);
        const retry = notify.mock.calls[0]?.[1];
        expect(retry).toBeTypeOf('function');

        act(() => retry?.());
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(fetchGrid).toHaveBeenCalledTimes(2);
        expect(screen.getByText(/visible-true playing-false phase-ready attempt-2/)).toBeInTheDocument();
        expect(notify).toHaveBeenCalledTimes(1);
    });
});
