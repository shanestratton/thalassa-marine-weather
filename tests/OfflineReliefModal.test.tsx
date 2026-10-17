import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReliefProgress } from '../services/OfflineReliefService';
const calls = vi.hoisted(() => ({
    hydrate: vi.fn(async () => undefined),
    download: vi.fn(),
    remove: vi.fn(async (): Promise<void> => undefined),
    storage: { tiles: 12, bytes: 1024 },
    satellite: false,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('../services/OfflineReliefService', () => ({
    hydrateRelief: calls.hydrate,
    reliefStorage: () => calls.storage,
    downloadReliefArea: calls.download,
    deleteSavedRelief: calls.remove,
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => calls.satellite }));
vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ isOpen, title, children }: { isOpen: boolean; title: string; children: React.ReactNode }) =>
        isOpen ? (
            <div role="dialog" aria-label={title}>
                {children}
            </div>
        ) : null,
}));
import { OfflineAreaModal } from '../components/map/OfflineAreaModal';
const map = {
    getBounds: () => ({ getNorth: () => -26.99, getSouth: () => -27, getWest: () => 153, getEast: () => 153.01 }),
} as unknown as mapboxgl.Map;
beforeEach(() => {
    vi.clearAllMocks();
    calls.satellite = false;
    calls.storage = { tiles: 12, bytes: 1024 };
});
describe('relief-only offline workflow', () => {
    it('estimates before fetching and states the basemap/licensed-chart limits plainly', async () => {
        render(<OfflineAreaModal isOpen map={map} onClose={vi.fn()} />);
        await waitFor(() => expect(calls.hydrate).toHaveBeenCalled());
        expect(screen.getByText(/terrain files · about/)).toBeVisible();
        expect(calls.download).not.toHaveBeenCalled();
        expect(screen.getByText(/Mapbox imagery, place labels and public OSM tiles are not stored/)).toBeVisible();
        expect(screen.getByText(/licensed charts require your boat Pi connection/)).toBeVisible();
        expect(screen.getByText(/persistent app storage/)).toBeVisible();
        expect(screen.getByRole('slider', { name: 'Maximum relief detail' })).toHaveAttribute('max', '14');
        expect(screen.getByText(/New Zealand retains native NZVD2016 heights, not MSL/)).toBeVisible();
    });
    it('passes only scoped relief bounds and cancels the active operation', async () => {
        let report: ((p: ReliefProgress) => void) | undefined, finish: (() => void) | undefined;
        calls.download.mockImplementation((_b, _z, _base, _signal, r) => {
            report = r;
            return new Promise<void>((resolve) => {
                finish = resolve;
            });
        });
        const close = vi.fn();
        render(<OfflineAreaModal isOpen map={map} onClose={close} />);
        fireEvent.click(screen.getByRole('button', { name: 'Download relief' }));
        expect(calls.download).toHaveBeenCalledWith(
            expect.objectContaining({ north: -26.99, south: -27, west: 153, east: 153.01 }),
            9,
            'https://tiles.thalassatiles.com/v1',
            expect.any(AbortSignal),
            expect.any(Function),
        );
        act(() =>
            report!({
                phase: 'downloading',
                current: 0,
                total: 12,
                saved: 0,
                missing: 0,
                failed: 0,
                message: 'Starting…',
            }),
        );
        expect(screen.getByRole('button', { name: 'Delete saved relief' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
        expect(calls.download.mock.calls[0][3].aborted).toBe(true);
        await act(async () => finish!());
    });
    it('deletes saved terrain through its dedicated store and respects Satellite Mode', async () => {
        calls.satellite = true;
        render(<OfflineAreaModal isOpen map={map} onClose={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Download relief' })).toBeDisabled();
        expect(screen.getByText(/Satellite Mode blocks bulk relief downloads/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Delete saved relief' }));
        await waitFor(() => expect(calls.remove).toHaveBeenCalledOnce());
        expect(calls.download).not.toHaveBeenCalled();
    });
    it('disables new downloads while saved relief is being deleted', async () => {
        let finish!: () => void;
        calls.remove.mockImplementationOnce(
            () =>
                new Promise<void>((r) => {
                    finish = r;
                }),
        );
        render(<OfflineAreaModal isOpen map={map} onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete saved relief' }));
        expect(screen.getByRole('button', { name: 'Delete saved relief' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Download relief' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Cancel download' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Download relief' }));
        expect(calls.download).not.toHaveBeenCalled();
        await act(async () => finish());
        expect(screen.getByRole('button', { name: 'Download relief' })).toBeEnabled();
    });
});
