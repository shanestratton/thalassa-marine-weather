import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipLogEntry } from '../types';
import type { StoredPosition } from '../services/shiplog/TrackingStateStore';

const reads = vi.hoisted(() => ({
    position: vi.fn(),
    queue: vi.fn(),
    summaries: vi.fn(),
}));
vi.mock('../services/shiplog/TrackingStateStore', () => ({ getLastPosition: reads.position }));
vi.mock('../services/shiplog/OfflineQueue', () => ({ getOfflineEntries: reads.queue }));
vi.mock('../services/shiplog/VoyageSummaryCache', () => ({ getCachedSummaries: reads.summaries }));

import {
    recordedDeparture,
    recordedDistance,
    RECORDING_METRICS_POLL_MS,
    usePassageRecordingMetrics,
} from '../hooks/usePassageRecordingMetrics';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const VOYAGE = 'recording-1';
const position = (overrides: Partial<StoredPosition> = {}): StoredPosition => ({
    latitude: -27,
    longitude: 153,
    timestamp: new Date(NOW - 1_000).toISOString(),
    cumulativeDistanceNM: 12.4,
    voyageId: VOYAGE,
    ...overrides,
});
const entry = (seconds: number, latitude: number, distance: number, speed = 5): ShipLogEntry =>
    ({
        id: `point-${seconds}`,
        voyageId: VOYAGE,
        source: 'device',
        timestamp: new Date(NOW - 3_600_000 + seconds * 1000).toISOString(),
        latitude,
        longitude: 153,
        cumulativeDistanceNM: distance,
        speedKts: speed,
    }) as ShipLogEntry;
const departure = () => [entry(0, -27, 0), entry(15, -26.9997, 0.02), entry(35, -26.9994, 0.04)];
const flush = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setAuthIdentityScope('hud-metrics-a');
    reads.position.mockReset().mockResolvedValue(position());
    reads.queue.mockReset().mockResolvedValue(departure());
    reads.summaries.mockReset().mockResolvedValue(null);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

describe('recorded voyage evidence', () => {
    it('uses measured cumulative distance only from this voyage and preserves its timestamp', () => {
        expect(recordedDistance(position(), VOYAGE, NOW)).toEqual({ distanceNm: 12.4, recordedAt: NOW - 1_000 });
        for (const invalid of [
            null,
            position({ voyageId: 'old-voyage' }),
            position({ voyageId: undefined }),
            position({ cumulativeDistanceNM: Number.NaN }),
            position({ cumulativeDistanceNM: -1 }),
            position({ timestamp: 'broken' }),
            position({ timestamp: new Date(NOW + 60_000).toISOString() }),
        ])
            expect(recordedDistance(invalid, VOYAGE, NOW)).toEqual({ distanceNm: null, recordedAt: null });
    });

    it('confirms departure from measured movement rather than arm time, dock jitter or an imported route', () => {
        expect(recordedDeparture(departure(), VOYAGE, NOW)).toBe(NOW - 3_600_000);
        expect(recordedDeparture([entry(-3600, -27, 0, 0), entry(0, -27, 0, 0)], VOYAGE, NOW)).toBeNull();
        expect(recordedDeparture(departure().slice(0, 2), VOYAGE, NOW)).toBeNull();
        expect(
            recordedDeparture(
                departure().map((row) => ({ ...row, source: 'planned_route' })),
                VOYAGE,
                NOW,
            ),
        ).toBeNull();
        expect(recordedDeparture(departure(), 'another-voyage', NOW)).toBeNull();
        expect(recordedDeparture([entry(-3 * 24 * 3600, -27, 0, 0)], VOYAGE, NOW)).toBeNull();
    });
});

describe('recording HUD local reads', () => {
    it('reads the current voyage queue until departure is confirmed, then polls only its saved accumulator', async () => {
        const { result, unmount } = renderHook(() => usePassageRecordingMetrics(VOYAGE));
        await flush();
        expect(result.current).toMatchObject({ distanceNm: 12.4, departedAt: NOW - 3_600_000 });
        expect(reads.queue).toHaveBeenCalledWith({ voyageId: VOYAGE, expectedScope: getAuthIdentityScope() });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECORDING_METRICS_POLL_MS * 3);
        });
        expect(reads.position).toHaveBeenCalledTimes(4);
        expect(reads.queue).toHaveBeenCalledTimes(1);
        expect(reads.summaries).toHaveBeenCalledTimes(1);
        unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECORDING_METRICS_POLL_MS);
        });
        expect(reads.position).toHaveBeenCalledTimes(4);
    });

    it('stays pending while docked and confirms the original moving fix on a later poll', async () => {
        reads.queue.mockResolvedValueOnce([entry(-1200, -27, 0, 0)]).mockResolvedValue(departure());
        const { result } = renderHook(() => usePassageRecordingMetrics(VOYAGE));
        await flush();
        expect(result.current.departedAt).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECORDING_METRICS_POLL_MS);
        });
        expect(result.current.departedAt).toBe(NOW - 3_600_000);
    });

    it('preserves explicit earlier departure evidence when continuing a voyage, ignoring legacy startedAt', async () => {
        reads.summaries.mockResolvedValue([
            {
                voyageId: VOYAGE,
                startedAt: new Date(NOW - 10 * 3600_000).toISOString(),
                departedAt: new Date(NOW - 2 * 3600_000).toISOString(),
            },
        ]);
        const { result } = renderHook(() => usePassageRecordingMetrics(VOYAGE));
        await flush();
        expect(result.current.departedAt).toBe(NOW - 2 * 3600_000);
        expect(reads.queue).not.toHaveBeenCalled();
        cleanup();
        reads.summaries.mockResolvedValue([
            { voyageId: VOYAGE, startedAt: new Date(NOW - 10 * 3600_000).toISOString() },
        ]);
        reads.queue.mockResolvedValue([]);
        const legacy = renderHook(() => usePassageRecordingMetrics(VOYAGE));
        await flush();
        expect(legacy.result.current.departedAt).toBeNull();
    });

    it('does not overlap slow reads or admit a previous account result', async () => {
        let finish!: (value: StoredPosition) => void;
        reads.position.mockReturnValueOnce(
            new Promise<StoredPosition>((resolve) => {
                finish = resolve;
            }),
        );
        const { result } = renderHook(() => usePassageRecordingMetrics(VOYAGE));
        await flush();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECORDING_METRICS_POLL_MS * 3);
        });
        expect(reads.position).toHaveBeenCalledTimes(1);
        reads.position.mockResolvedValue(null);
        reads.queue.mockResolvedValue([]);
        act(() => {
            setAuthIdentityScope('hud-metrics-b');
        });
        expect(result.current.distanceNm).toBeNull();
        await flush();
        await act(async () => {
            finish(position());
        });
        expect(result.current.distanceNm).toBeNull();
        expect(result.current.departedAt).toBeNull();
    });

    it('rejects a legacy cached departure that may be recording arm time', async () => {
        reads.summaries.mockResolvedValue([{ voyageId: VOYAGE, departedAt: '2026-09-20T12:00:00Z' }]);
        reads.queue.mockResolvedValue([]);
        const { result } = renderHook(() => usePassageRecordingMetrics(VOYAGE));
        await flush();
        expect(result.current.departedAt).toBeNull();
    });

    it('clears another voyage immediately and retains a saved value with its age after a failed read', async () => {
        const { result, rerender } = renderHook(({ voyageId }) => usePassageRecordingMetrics(voyageId), {
            initialProps: { voyageId: VOYAGE },
        });
        await flush();
        reads.position.mockRejectedValue(new Error('storage unavailable'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECORDING_METRICS_POLL_MS * 3);
        });
        expect(result.current.distanceNm).toBe(12.4);
        expect(result.current.recordedAt).toBe(NOW - 1000);
        expect(result.current.nowMs).toBe(NOW + RECORDING_METRICS_POLL_MS * 3);
        rerender({ voyageId: 'new-voyage' });
        expect(result.current.distanceNm).toBeNull();
        expect(result.current.departedAt).toBeNull();
        await flush();
        expect(result.current.distanceNm).toBeNull();
    });
});
