import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const mocks = vi.hoisted(() => ({ read: vi.fn(), markers: [] as any[] }));
vi.mock('../services/plannerVesselPosition', async (original) => ({
    ...(await original<typeof import('../services/plannerVesselPosition')>()),
    readPlannerVesselPosition: mocks.read,
}));
vi.mock('mapbox-gl', () => ({
    default: {
        Marker: class {
            options: any;
            setLngLat = vi.fn(() => this);
            addTo = vi.fn(() => this);
            remove = vi.fn();
            constructor(options: any) {
                this.options = options;
                mocks.markers.push(this);
            }
            getElement() {
                return this.options.element;
            }
        },
    },
}));
import { PlannerVesselLocator } from '../components/map/PlannerVesselLocator';
const fix = (age = 0) => ({ latitude: -20.2, longitude: 148.8, timestamp: Date.now() - age, rung: 'cloud' });
let canvas: HTMLDivElement;
let flyTo: ReturnType<typeof vi.fn>;
let mapRef: React.MutableRefObject<mapboxgl.Map | null>;
beforeEach(() => {
    vi.clearAllMocks();
    mocks.markers.length = 0;
    setAuthIdentityScope('owner');
    canvas = document.createElement('div');
    flyTo = vi.fn();
    mapRef = {
        current: {
            getCanvasContainer: () => canvas,
            getContainer: () => canvas,
            getZoom: () => 10,
            flyTo,
        } as unknown as mapboxgl.Map,
    };
    mocks.read.mockResolvedValue(fix());
});
afterEach(cleanup);
describe('yacht locator on the planning chart', () => {
    it('centres a fresh empty chart once, with a coordinate-centred marker', async () => {
        render(<PlannerVesselLocator mapRef={mapRef} mapReady autoCenter />);
        await waitFor(() => expect(flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [148.8, -20.2] })));
        expect(mocks.markers[0].options.anchor).toBe('center');
        expect(mocks.markers[0].setLngLat).toHaveBeenCalledWith([148.8, -20.2]);
        expect(mocks.read).toHaveBeenCalledTimes(1);
    });
    it('does not move a loaded route until Locate yacht is pressed', async () => {
        render(<PlannerVesselLocator mapRef={mapRef} mapReady autoCenter={false} />);
        await waitFor(() => expect(mocks.markers).toHaveLength(1));
        expect(flyTo).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Locate yacht' }));
        await waitFor(() => expect(flyTo).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('status')).toHaveTextContent('reported just now');
    });
    it('does not steal the camera after the skipper begins using the map', async () => {
        let resolve!: (value: unknown) => void;
        mocks.read.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        render(<PlannerVesselLocator mapRef={mapRef} mapReady autoCenter />);
        fireEvent.pointerDown(canvas);
        await act(async () => resolve(fix()));
        expect(flyTo).not.toHaveBeenCalled();
    });
    it('shows stale positions in amber; flies to them only on an explicit tap', async () => {
        mocks.read.mockResolvedValue(fix(120000));
        render(<PlannerVesselLocator mapRef={mapRef} mapReady autoCenter />);
        await waitFor(() => expect(mocks.markers).toHaveLength(1));
        expect(flyTo).not.toHaveBeenCalled();
        expect(mocks.markers[0].getElement().getAttribute('aria-label')).toContain('Last reported');
        fireEvent.click(screen.getByRole('button', { name: 'Locate yacht' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 min ago'));
        expect(flyTo).toHaveBeenCalledTimes(1);
    });
    it('never substitutes home or the computer when the boat cannot be located', async () => {
        mocks.read.mockResolvedValue(null);
        render(<PlannerVesselLocator mapRef={mapRef} mapReady autoCenter />);
        fireEvent.click(screen.getByRole('button', { name: 'Locate yacht' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Yacht position unavailable'));
        expect(flyTo).not.toHaveBeenCalled();
        expect(mocks.markers).toHaveLength(0);
    });
    it('removes markers at sign-out and discards an in-flight old-account position', async () => {
        render(<PlannerVesselLocator mapRef={mapRef} mapReady />);
        await waitFor(() => expect(mocks.markers).toHaveLength(1));
        let resolve!: (value: unknown) => void;
        mocks.read.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Locate yacht' }));
        act(() => setAuthIdentityScope(null));
        await act(async () => resolve(fix()));
        expect(mocks.markers[0].remove).toHaveBeenCalled();
        expect(flyTo).not.toHaveBeenCalled();
    });
});
