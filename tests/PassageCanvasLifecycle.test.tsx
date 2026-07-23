import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpatiotemporalPayload } from '../types/spatiotemporal';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const passageMocks = vi.hoisted(() => ({
    downloadRouteGPX: vi.fn(),
    savePassagePlanToLogbook: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    setWindLoading: vi.fn(),
    setWindGrid: vi.fn(),
    fetchWW3Grid: vi.fn(),
    fetchGlobalWindField: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('../utils/gpxRouteExport', () => ({
    downloadRouteGPX: passageMocks.downloadRouteGPX,
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        savePassagePlanToLogbook: passageMocks.savePassagePlanToLogbook,
    },
}));

vi.mock('../components/Toast', () => ({
    toast: {
        success: passageMocks.toastSuccess,
        error: passageMocks.toastError,
    },
}));

vi.mock('../hooks/passage/useGhostShip', () => ({
    useGhostShip: () => ({
        position: [153, -27],
        bearing: 0,
        conditions: {
            depth_m: 10,
            wind_spd_kts: 12,
            wind_dir_deg: 90,
            wave_ht_m: 1,
            swell_period_s: 8,
        },
        distanceNM: 0,
        segmentIndex: 0,
    }),
}));

vi.mock('../components/passage/SpatiotemporalMap', () => ({
    default: () => <div data-testid="passage-map" />,
}));

vi.mock('../components/passage/TemporalScrubber', () => ({
    default: () => <div data-testid="temporal-scrubber" />,
}));

vi.mock('../components/passage/SharePassageButton', () => ({
    default: () => <button type="button">Share passage</button>,
}));

vi.mock('../stores/WindStore', () => ({
    WindStore: {
        setLoading: passageMocks.setWindLoading,
        setGrid: passageMocks.setWindGrid,
    },
}));

vi.mock('../services/ww3CacheClient', () => ({
    fetchWW3Grid: passageMocks.fetchWW3Grid,
}));

vi.mock('../services/weather/windField', () => ({
    fetchGlobalWindField: passageMocks.fetchGlobalWindField,
}));

import PassageCanvas from '../components/passage/PassageCanvas';

function makePayload(destination = 'Cairns', destinationLongitude = 145.77): SpatiotemporalPayload {
    return {
        summary: {
            total_distance_nm: 730,
            total_duration_hours: 96,
            cost_score: 1,
            computation_ms: 50,
            routing_mode: 'stitched_spatiotemporal',
            vessel_type: 'sail',
            departure_time: '2026-07-23T00:00:00.000Z',
        },
        bounding_box: [145, -28, 154, -16],
        track: [
            {
                coordinates: [153.03, -27.47],
                distance_from_start_nm: 0,
                time_offset_hours: 0,
                name: 'Brisbane',
                lateral_offset_nm: 0,
                conditions: {
                    depth_m: 10,
                    wind_spd_kts: 12,
                    wind_dir_deg: 90,
                    wave_ht_m: 0,
                    swell_period_s: 8,
                },
            },
            {
                coordinates: [destinationLongitude, -16.92],
                distance_from_start_nm: 730,
                time_offset_hours: 96,
                name: destination,
                lateral_offset_nm: 0,
                conditions: {
                    depth_m: 20,
                    wind_spd_kts: 16,
                    wind_dir_deg: 110,
                    wave_ht_m: 1.2,
                    swell_period_s: 9,
                },
            },
        ],
        mesh_stats: {
            total_nodes: 2,
            rows: 1,
            cols: 2,
            corridor_width_nm: 20,
            weather_grid_points: 2,
            forecast_hours: 120,
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushAsyncWork() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    setAuthIdentityScope('account-a');
    passageMocks.downloadRouteGPX.mockReset();
    passageMocks.savePassagePlanToLogbook.mockReset();
    passageMocks.savePassagePlanToLogbook.mockResolvedValue('voyage-1');
    passageMocks.toastSuccess.mockReset();
    passageMocks.toastError.mockReset();
    passageMocks.setWindLoading.mockReset();
    passageMocks.setWindGrid.mockReset();
    passageMocks.fetchWW3Grid.mockReset();
    passageMocks.fetchWW3Grid.mockResolvedValue(null);
    passageMocks.fetchGlobalWindField.mockReset();
    passageMocks.fetchGlobalWindField.mockResolvedValue(null);
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: false,
        }),
    );
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('PassageCanvas action lifecycle', () => {
    it('prevents duplicate GPX exports and accurately reports that the export was prepared', () => {
        render(<PassageCanvas payload={makePayload()} />);

        const exportButton = screen.getByRole('button', { name: 'Download track as GPX' });
        fireEvent.click(exportButton);
        fireEvent.click(exportButton);

        expect(passageMocks.downloadRouteGPX).toHaveBeenCalledTimes(1);
        expect(passageMocks.downloadRouteGPX.mock.calls[0][0].waypoints).toEqual([]);
        expect(passageMocks.toastSuccess).toHaveBeenCalledWith('GPX export prepared');
        expect(screen.getByRole('button', { name: 'GPX export prepared' })).toBeDisabled();
    });

    it('cleans the GPX feedback reset timer when unmounted', () => {
        vi.useFakeTimers();
        const { unmount } = render(<PassageCanvas payload={makePayload()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Download track as GPX' }));
        expect(vi.getTimerCount()).toBe(1);

        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts the active wind request when the canvas closes', () => {
        let requestSignal: AbortSignal | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                requestSignal = init?.signal ?? undefined;
                return new Promise<Response>((_resolve, reject) => {
                    requestSignal?.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    });
                });
            }),
        );
        const { unmount } = render(<PassageCanvas payload={makePayload()} />);

        expect(requestSignal?.aborted).toBe(false);
        unmount();
        expect(requestSignal?.aborted).toBe(true);
    });

    it('never renders WW3 wave vectors as wind when the GFS request falls back', async () => {
        const windGrid = {
            u: [new Float32Array([1])],
            v: [new Float32Array([2])],
            speed: [new Float32Array([Math.sqrt(5)])],
            width: 1,
            height: 1,
            lats: [-27.47],
            lons: [153.03],
            north: -27.47,
            south: -27.47,
            west: 153.03,
            east: 153.03,
            totalHours: 1,
        };
        passageMocks.fetchGlobalWindField.mockResolvedValueOnce(windGrid);

        render(<PassageCanvas payload={makePayload()} />);

        await waitFor(() => expect(passageMocks.setWindGrid).toHaveBeenCalledWith(windGrid));
        expect(passageMocks.fetchGlobalWindField).toHaveBeenCalledOnce();
        expect(passageMocks.fetchWW3Grid).not.toHaveBeenCalled();
    });

    it('locks logbook saving synchronously so repeated activation creates one voyage', async () => {
        const pendingSave = deferred<string | null>();
        passageMocks.savePassagePlanToLogbook.mockReturnValueOnce(pendingSave.promise);
        render(<PassageCanvas payload={makePayload()} />);

        const saveButton = screen.getByRole('button', { name: 'Save planned route to logbook' });
        fireEvent.click(saveButton);
        fireEvent.click(saveButton);
        await flushAsyncWork();

        expect(passageMocks.savePassagePlanToLogbook).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Saving planned route to logbook' })).toBeDisabled();

        pendingSave.resolve('voyage-1');
        await flushAsyncWork();

        expect(passageMocks.toastSuccess).toHaveBeenCalledWith('Route to Cairns saved to logbook');
        expect(screen.getByRole('button', { name: 'Planned route saved to logbook' })).toBeDisabled();
    });

    it('does not hand an account-A route to account B while the logbook module is loading', async () => {
        render(<PassageCanvas payload={makePayload()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Save planned route to logbook' }));
        act(() => {
            setAuthIdentityScope('account-b');
        });
        await flushAsyncWork();

        expect(passageMocks.savePassagePlanToLogbook).not.toHaveBeenCalled();
        expect(passageMocks.toastSuccess).not.toHaveBeenCalled();
        expect(passageMocks.toastError).not.toHaveBeenCalled();
    });

    it('does not let an earlier error-reset timer overwrite a retry that is still saving', async () => {
        vi.useFakeTimers();
        const retrySave = deferred<string | null>();
        passageMocks.savePassagePlanToLogbook.mockResolvedValueOnce(null).mockReturnValueOnce(retrySave.promise);
        render(<PassageCanvas payload={makePayload()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Save planned route to logbook' }));
        await flushAsyncWork();
        expect(screen.getByRole('button', { name: 'Retry saving planned route to logbook' })).toBeEnabled();

        fireEvent.click(screen.getByRole('button', { name: 'Retry saving planned route to logbook' }));
        await flushAsyncWork();
        expect(passageMocks.savePassagePlanToLogbook).toHaveBeenCalledTimes(2);

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(screen.getByRole('button', { name: 'Saving planned route to logbook' })).toBeDisabled();

        retrySave.resolve('voyage-2');
        await flushAsyncWork();
        expect(screen.getByRole('button', { name: 'Planned route saved to logbook' })).toBeDisabled();
    });

    it('ignores an old route save completion after the displayed payload changes', async () => {
        const oldRouteSave = deferred<string | null>();
        passageMocks.savePassagePlanToLogbook.mockReturnValueOnce(oldRouteSave.promise);
        const { rerender } = render(<PassageCanvas payload={makePayload()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Save planned route to logbook' }));
        await flushAsyncWork();
        expect(passageMocks.savePassagePlanToLogbook).toHaveBeenCalledOnce();

        rerender(<PassageCanvas payload={makePayload('Townsville', 146.82)} />);
        expect(screen.getByRole('button', { name: 'Save planned route to logbook' })).toBeEnabled();

        oldRouteSave.resolve('old-voyage');
        await flushAsyncWork();

        expect(passageMocks.toastSuccess).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Save planned route to logbook' })).toBeEnabled();
    });

    it('suppresses async feedback after unmount', async () => {
        const pendingSave = deferred<string | null>();
        passageMocks.savePassagePlanToLogbook.mockReturnValueOnce(pendingSave.promise);
        const { unmount } = render(<PassageCanvas payload={makePayload()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Save planned route to logbook' }));
        await flushAsyncWork();
        unmount();

        pendingSave.resolve('voyage-after-close');
        await flushAsyncWork();
        expect(passageMocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('rejects incomplete tracks instead of claiming to export or save them', async () => {
        const incompletePayload = makePayload();
        incompletePayload.track = incompletePayload.track.slice(0, 1);
        render(<PassageCanvas payload={incompletePayload} />);

        fireEvent.click(screen.getByRole('button', { name: 'Download track as GPX' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save planned route to logbook' }));
        await flushAsyncWork();

        expect(passageMocks.downloadRouteGPX).not.toHaveBeenCalled();
        expect(passageMocks.savePassagePlanToLogbook).not.toHaveBeenCalled();
        expect(passageMocks.toastError).toHaveBeenCalledWith(
            'Route needs a departure and destination before it can be exported',
        );
        expect(passageMocks.toastError).toHaveBeenCalledWith(
            'Route needs a departure and destination before it can be saved',
        );
    });
});
