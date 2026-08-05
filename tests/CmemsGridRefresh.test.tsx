import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCmemsGridRefresh } from '../components/map/useCmemsGridRefresh';
import type { WindGrid } from '../services/weather/windField';
import { CMEMS_CACHE_TTL_MS } from '../services/weather/api/cmemsGridTrust';

function grid(step: number, validUntil: string): WindGrid {
    const u = new Array<Float32Array>(6);
    const v = new Array<Float32Array>(6);
    u[step] = new Float32Array([0.1]);
    v[step] = new Float32Array([0.1]);
    return {
        u,
        v,
        speed: new Array<Float32Array>(6),
        width: 1,
        height: 1,
        lats: [0],
        lons: [0],
        north: 0,
        south: 0,
        west: 0,
        east: 0,
        totalHours: 6,
        sourceStep: step,
        sourceGeneration: 'g-20260805T120000Z-aaaaaaaaaaaa',
        verifiedAt: new Date().toISOString(),
        validUntil,
    };
}

const allowFrameLoad = () => true;

function Harness({
    visible,
    step = 0,
    fetchGrid,
    releaseGrid,
    prepareForFrame = allowFrameLoad,
}: {
    visible: boolean;
    step?: number;
    fetchGrid: (step: number) => Promise<WindGrid | null>;
    releaseGrid: () => void;
    prepareForFrame?: () => boolean;
}) {
    const current = useCmemsGridRefresh(true, visible, step, fetchGrid, releaseGrid, prepareForFrame);
    return (
        <div>
            <span>{current.grid ? `verified-frame-${current.grid.sourceStep}` : 'grid-off'}</span>
            <span>{`phase-${current.phase}`}</span>
            <span>{`attempt-${current.attempt}`}</span>
            <button type="button" onClick={current.retry}>
                Retry
            </button>
        </div>
    );
}

describe('CMEMS visible-frame ownership and revalidation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('clears and releases a prior frame when the bounded-TTL refresh fails', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
        const first = grid(0, '2026-08-05T18:00:00Z');
        const fetchGrid = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(null);
        const releaseGrid = vi.fn();
        render(<Harness visible fetchGrid={fetchGrid} releaseGrid={releaseGrid} />);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(screen.getByText('verified-frame-0')).toBeInTheDocument();

        await act(async () => vi.advanceTimersByTimeAsync(CMEMS_CACHE_TTL_MS + 101));
        expect(fetchGrid).toHaveBeenCalledTimes(2);
        expect(releaseGrid).toHaveBeenCalled();
        expect(screen.getByText('grid-off')).toBeInTheDocument();
        expect(screen.getByText('phase-error')).toBeInTheDocument();
    });

    it('releases decoded ownership immediately when the layer is hidden', () => {
        const fetchGrid = vi.fn();
        const releaseGrid = vi.fn();
        render(<Harness visible={false} fetchGrid={fetchGrid} releaseGrid={releaseGrid} />);
        expect(screen.getByText('grid-off')).toBeInTheDocument();
        expect(screen.getByText('phase-idle')).toBeInTheDocument();
        expect(fetchGrid).not.toHaveBeenCalled();
        expect(releaseGrid).toHaveBeenCalled();
    });

    it('releases an obsolete frame before loading a new scrubber step', async () => {
        const fetchGrid = vi.fn((step: number) => Promise.resolve(grid(step, '2026-08-05T18:00:00Z')));
        const releaseGrid = vi.fn();
        const view = render(<Harness visible step={0} fetchGrid={fetchGrid} releaseGrid={releaseGrid} />);
        expect(await screen.findByText('verified-frame-0')).toBeInTheDocument();
        view.rerender(<Harness visible step={2} fetchGrid={fetchGrid} releaseGrid={releaseGrid} />);
        expect(await screen.findByText('verified-frame-2')).toBeInTheDocument();
        expect(fetchGrid).toHaveBeenLastCalledWith(2);
        expect(releaseGrid).toHaveBeenCalled();
    });

    it('does not fetch or allocate a replacement until teardown absence is proven', async () => {
        vi.useFakeTimers();
        const prepareForFrame = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
        const fetchGrid = vi.fn((step: number) =>
            Promise.resolve(grid(step, new Date(Date.now() + CMEMS_CACHE_TTL_MS * 2).toISOString())),
        );
        const releaseGrid = vi.fn();
        render(<Harness visible fetchGrid={fetchGrid} releaseGrid={releaseGrid} prepareForFrame={prepareForFrame} />);

        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(prepareForFrame).toHaveBeenCalledTimes(1);
        expect(fetchGrid).not.toHaveBeenCalled();
        expect(screen.getByText('phase-error')).toBeInTheDocument();
        expect(screen.getByText('attempt-1')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(prepareForFrame).toHaveBeenCalledTimes(2);
        expect(fetchGrid).toHaveBeenCalledTimes(1);
        expect(screen.getByText('verified-frame-0')).toBeInTheDocument();
        expect(screen.getByText('phase-ready')).toBeInTheDocument();
        expect(screen.getByText('attempt-2')).toBeInTheDocument();
    });
});
