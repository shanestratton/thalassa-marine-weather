import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveCyclones } from '../components/map/useActiveCyclones';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const fetchActiveCyclones = vi.hoisted(() => vi.fn());

vi.mock('../services/weather/CycloneTrackingService', () => ({ fetchActiveCyclones }));

const cyclones: ActiveCyclone[] = [
    {
        sid: 'AL012026',
        name: 'Cyclone Iris',
        basin: 'SP',
        category: 2,
        categoryLabel: '2',
        currentPosition: { lat: -18.2, lon: 151.4, time: '2026-07-23T00:00:00Z', windKts: 85, pressureMb: 970 },
        track: [],
        forecastTrack: [],
        maxWindKts: 85,
        minPressureMb: 970,
        nature: 'TY',
    },
];

beforeEach(() => {
    fetchActiveCyclones.mockReset();
    fetchActiveCyclones.mockResolvedValue(cyclones);
});

describe('useActiveCyclones', () => {
    it('does not fetch the catalogue while cyclone-related layers are unused', () => {
        renderHook(() => useActiveCyclones(false));

        expect(fetchActiveCyclones).not.toHaveBeenCalled();
    });

    it('loads the catalogue when a cyclone-related feature becomes active', async () => {
        const { result, rerender } = renderHook(({ enabled }) => useActiveCyclones(enabled), {
            initialProps: { enabled: false },
        });

        rerender({ enabled: true });

        await waitFor(() => expect(result.current.cyclones).toEqual(cyclones));
        expect(fetchActiveCyclones).toHaveBeenCalledOnce();
    });

    it('shares concurrent refreshes instead of starting duplicate network work', async () => {
        let resolve: ((value: ActiveCyclone[]) => void) | undefined;
        fetchActiveCyclones.mockReturnValue(
            new Promise<ActiveCyclone[]>((done) => {
                resolve = done;
            }),
        );
        const { result } = renderHook(() => useActiveCyclones(false));

        let first!: Promise<ActiveCyclone[]>;
        let second!: Promise<ActiveCyclone[]>;
        act(() => {
            first = result.current.refresh();
            second = result.current.refresh();
        });
        await waitFor(() => expect(fetchActiveCyclones).toHaveBeenCalledOnce());

        await act(async () => {
            resolve?.(cyclones);
            await Promise.all([first, second]);
        });
        expect(result.current.cyclones).toEqual(cyclones);
    });
});
