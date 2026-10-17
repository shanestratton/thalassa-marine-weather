import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { ChartNoteWindow } from '../services/community/ChartNotesService';
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../services/community/ChartNotesService', () => ({ readChartNoteWindow: api.read }));
vi.mock('../components/community/ChartNoteSheet', () => ({
    default: ({
        note,
        retired,
        pin,
    }: {
        note?: { message: string };
        retired?: boolean;
        pin: { lat: number; lon: number };
    }) => <div role="dialog">{note?.message ?? (retired ? 'Retired detail' : `Chosen ${pin.lat},${pin.lon}`)}</div>,
}));
import Layer from '../components/map/CommunityChartNotesLayer';
const note = {
    id: '10000000-0000-4000-8000-000000000001',
    revision: '20000000-0000-4000-8000-000000000001',
    kind: 'hazard' as const,
    latitude: -27,
    longitude: 153,
    message: 'Private text kept out of map properties',
    observed_date: '2026-10-17',
    expires_at: '2026-11-16T00:00:00Z',
    confirms: 1,
    denies: 0,
    my_vote: null,
    mine: false,
    reviewed: false,
    photo_id: null,
};
let retire!: () => void,
    current = true;
let source: { setData: ReturnType<typeof vi.fn> },
    map: Record<string, ReturnType<typeof vi.fn>>,
    events: Map<string, (e?: unknown) => void>,
    lease: ChartNoteWindow;
beforeEach(() => {
    events = new Map();
    current = true;
    source = { setData: vi.fn() };
    let hasSource = false,
        hasLayer = false;
    map = {
        getSource: vi.fn(() => (hasSource ? source : undefined)),
        getLayer: vi.fn(() => (hasLayer ? {} : undefined)),
        addSource: vi.fn(() => {
            hasSource = true;
        }),
        addLayer: vi.fn(() => {
            hasLayer = true;
        }),
        removeLayer: vi.fn(() => {
            hasLayer = false;
        }),
        removeSource: vi.fn(() => {
            hasSource = false;
        }),
        getBounds: vi.fn(() => ({ getWest: () => 152, getEast: () => 154, getSouth: () => -28, getNorth: () => -26 })),
        getCenter: vi.fn(() => ({ lat: -27, lng: 153 })),
        on: vi.fn((event: string, ...args: unknown[]) => events.set(event, args.at(-1) as (e?: unknown) => void)),
        off: vi.fn(),
    };
    lease = {
        get notes() {
            return current ? [note] : [];
        },
        truncated: false,
        serverNow: () => Date.parse('2026-10-17'),
        isCurrent: () => current,
        release: vi.fn(() => {
            current = false;
            retire?.();
        }),
    };
    api.read.mockReset().mockImplementation(async (_bbox, signal: AbortSignal, fn: () => void) => {
        retire = fn;
        signal.addEventListener('abort', () => lease.release(), { once: true });
        return lease;
    });
});
afterEach(cleanup);
const ref = () => ({ current: map as unknown as mapboxgl.Map });
describe('actual Obs community layer source boundary', () => {
    it('uses distinct violet display-only points and never puts content/owner/photo in Mapbox', async () => {
        render(<Layer mapRef={ref()} mapReady />);
        await screen.findByText('1 unofficial notes');
        expect(map.addLayer.mock.calls[0][0]).toMatchObject({ type: 'circle', paint: { 'circle-color': '#a78bfa' } });
        const data = source.setData.mock.calls.at(-1)![0];
        expect(data.features[0].properties).toEqual({ id: note.id, opacity: 1 });
        expect(JSON.stringify(data)).not.toContain(note.message);
        act(() => events.get('click')?.({ features: [{ properties: { id: note.id } }] }));
        expect(screen.getByText(note.message)).toBeInTheDocument();
        act(() => {
            current = false;
            retire();
        });
        expect(screen.queryByText(note.message)).toBeNull();
        expect(screen.getByText('Retired detail')).toBeInTheDocument();
        expect(source.setData.mock.calls.at(-1)![0].features).toEqual([]);
    });
    it('requires deliberate Add at map centre and clears detail when view moves', async () => {
        render(<Layer mapRef={ref()} mapReady />);
        await screen.findByText('1 unofficial notes');
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByText('Add at map centre'));
        expect(screen.getByText('Chosen -27,153')).toBeInTheDocument();
        act(() => events.get('movestart')?.());
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(source.setData.mock.calls.at(-1)![0].features).toEqual([]);
    });
    it('does not adopt a late window after hide/unmount and releases source ownership', async () => {
        let resolve!: (v: ChartNoteWindow) => void;
        api.read.mockImplementation((_bbox, _signal, fn) => {
            retire = fn;
            return new Promise((r) => (resolve = r));
        });
        const view = render(<Layer mapRef={ref()} mapReady />);
        view.unmount();
        await act(async () => resolve(lease));
        await waitFor(() => expect(lease.release).toHaveBeenCalled());
        expect(map.removeSource).toHaveBeenCalledWith('community-chart-notes');
        expect(map.removeLayer).toHaveBeenCalledWith('community-chart-notes-unofficial');
    });
});
