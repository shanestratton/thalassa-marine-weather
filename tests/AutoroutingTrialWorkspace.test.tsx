import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AutoroutingTrialWorkspace } from '../components/autorouting/AutoroutingTrialWorkspace';
import { RoutingModeDialog } from '../components/autorouting/RoutingModeDialog';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { PanePortalContext } from '../context/PanePortalContext';
import type { AutoroutingTrialRoute } from '../types/autorouting';

type Handler = (event?: unknown) => void;
const mocks = vi.hoisted(() => ({
    status: vi.fn(),
    calculate: vi.fn(),
    settings: {} as {
        defaultLocationCoords?: { lat: number; lon: number };
        vessel?: { draft: number; cruisingSpeed: number };
    },
    location: { lat: -27.47, lon: 153.02, source: 'initial' },
    maps: [] as Array<{
        options: Record<string, unknown>;
        handlers: Map<string, Handler>;
        source: { setData: ReturnType<typeof vi.fn> };
        loaded: boolean;
        addSource: ReturnType<typeof vi.fn>;
        addLayer: ReturnType<typeof vi.fn>;
        getSource: ReturnType<typeof vi.fn>;
        fitBounds: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        zoomIn: ReturnType<typeof vi.fn>;
        zoomOut: ReturnType<typeof vi.fn>;
        addControl: ReturnType<typeof vi.fn>;
    }>,
}));
vi.mock('../services/autoroutingTrial', () => ({
    getAutoroutingTrialStatus: mocks.status,
    calculateAutoroutingTrial: mocks.calculate,
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: mocks.settings }) } }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({ ...mocks.location }) } }));
vi.mock('mapbox-gl', () => ({
    default: {
        Map: class {
            constructor(options: Record<string, unknown>) {
                const map = {
                    options,
                    handlers: new Map<string, Handler>(),
                    loaded: false,
                    source: { setData: vi.fn() },
                    addSource: vi.fn(),
                    addLayer: vi.fn(),
                    getSource: vi.fn(),
                    fitBounds: vi.fn(),
                    resize: vi.fn(),
                    remove: vi.fn(),
                    on: vi.fn(),
                    touchZoomRotate: { disableRotation: vi.fn() },
                    zoomIn: vi.fn(),
                    zoomOut: vi.fn(),
                    addControl: vi.fn(),
                    getStyle: vi.fn(() => ({ layers: [{ type: 'symbol', id: 'labels' }] })),
                };
                map.on.mockImplementation((event: string, handler: Handler) => {
                    map.handlers.set(event, handler);
                    return map;
                });
                map.addSource.mockImplementation(() => {
                    map.loaded = true;
                });
                map.getSource.mockImplementation(() => (map.loaded ? map.source : undefined));
                mocks.maps.push(map);
                return map;
            }
        },
        LngLatBounds: class {
            extend = vi.fn();
        },
        AttributionControl: class {},
    },
}));

const route: AutoroutingTrialRoute = {
    id: 'proposal-1',
    provider: 'SevenCs',
    createdAt: '2026-09-12T00:00:00Z',
    coordinates: [
        [153.15, -27.2],
        [153.3, -27.1],
        [153.4, -27],
    ],
    warnings: ['Check all charted hazards independently.'],
};
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
async function openWorkspace(onClose = vi.fn()) {
    const view = render(<AutoroutingTrialWorkspace mapboxToken="fixture-token" onClose={onClose} />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    act(() => mocks.maps.at(-1)!.handlers.get('load')!());
    return { ...view, onClose };
}
function fillRequest() {
    fireEvent.click(screen.getByText('Enter coordinates'));
    for (const [label, value] of [
        ['departure latitude', '-27.2'],
        ['departure longitude', '153.15'],
        ['destination latitude', '-27'],
        ['destination longitude', '153.4'],
        ['Trial vessel draft in metres', '1.6'],
        ['Trial cruising speed in knots', '6'],
    ]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
}
const calculateButton = () => screen.getByRole('button', { name: 'Calculate trial route' });
const features = () => mocks.maps.at(-1)!.source.setData.mock.calls.at(-1)?.[0].features as GeoJSON.Feature[];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.maps.length = 0;
    mocks.settings = {};
    mocks.location = { lat: -27.47, lon: 153.02, source: 'initial' };
    setAuthIdentityScope('trial-fixture-account');
    mocks.status.mockResolvedValue({ enabled: true, ready: true });
    mocks.calculate.mockResolvedValue(route);
});
afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('display-light');
});

describe('isolated autorouting trial workspace', () => {
    it('refits the same proposal after chart resize, then clears bounds and disconnects on unmount', async () => {
        const original = globalThis.ResizeObserver;
        const disconnect = vi.fn();
        let resize = () => {};
        globalThis.ResizeObserver = class {
            constructor(callback: ResizeObserverCallback) {
                resize = () => callback([], this);
            }
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = disconnect;
        };
        try {
            const view = await openWorkspace();
            fillRequest();
            fireEvent.click(calculateButton());
            await screen.findByRole('region', { name: 'Trial proposal' });
            const map = mocks.maps[0];
            expect(map.fitBounds).toHaveBeenCalledTimes(1);
            const bounds = map.fitBounds.mock.calls[0][0];
            act(() => resize());
            expect(map.resize).toHaveBeenCalledTimes(1);
            expect(map.fitBounds).toHaveBeenLastCalledWith(bounds, { padding: 40, duration: 0 });
            expect(map.fitBounds).toHaveBeenCalledTimes(2);
            fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
            act(() => resize());
            expect(map.fitBounds).toHaveBeenCalledTimes(2);
            expect(mocks.maps).toHaveLength(1);
            view.unmount();
            expect(disconnect).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
            globalThis.ResizeObserver = original;
        }
    });
    it('uses only opening snapshots for camera and vessel inputs, keeps endpoints empty, and offers compact zoom', async () => {
        const onClose = vi.fn();
        const view = render(
            <AutoroutingTrialWorkspace
                onClose={onClose}
                mapboxToken="fixture-token"
                initialCenter={{ lat: -26.7, lon: 153.2 }}
                initialDraftM={1.5}
                initialSpeedKts={6}
            />,
        );
        await waitFor(() => expect(mocks.status).toHaveBeenCalled());
        act(() => mocks.maps[0].handlers.get('load')!());
        expect(mocks.maps[0].options.center).toEqual([153.2, -26.7]);
        expect(mocks.maps[0].options.zoom).toBe(10);
        expect(mocks.maps[0].options.style).toBe('mapbox://styles/mapbox/satellite-streets-v12');
        expect(features()).toEqual([]);
        expect(calculateButton()).toBeDisabled();
        expect(screen.getByLabelText('Trial vessel draft in metres')).toHaveValue(1.5);
        expect(screen.getByLabelText('Trial cruising speed in knots')).toHaveValue(6);
        expect(screen.getByText(/air draft and beam are not checked/)).toBeVisible();
        view.rerender(
            <AutoroutingTrialWorkspace
                onClose={onClose}
                mapboxToken="replacement-token"
                initialCenter={{ lat: 50, lon: 0 }}
                initialDraftM={3}
                initialSpeedKts={8}
            />,
        );
        expect(mocks.maps).toHaveLength(1);
        expect(mocks.maps[0].options.center).toEqual([153.2, -26.7]);
        expect(mocks.maps[0].options.accessToken).toBe('fixture-token');
        expect(screen.getByLabelText('Trial vessel draft in metres')).toHaveValue(1.5);
        fireEvent.click(screen.getByRole('button', { name: 'Zoom trial chart in' }));
        fireEvent.click(screen.getByRole('button', { name: 'Zoom trial chart out' }));
        expect(mocks.maps[0].zoomIn).toHaveBeenCalledTimes(1);
        expect(mocks.maps[0].zoomOut).toHaveBeenCalledTimes(1);
        expect(mocks.maps[0].addControl).toHaveBeenCalledWith(expect.anything(), 'bottom-right');
    });
    it('requires explicit inputs and Calculate, paints exact returned geometry, and removes its only map on close', async () => {
        const view = await openWorkspace();
        expect(calculateButton()).toBeDisabled();
        expect(screen.getByText('Not for navigation. Unsaved proposal only.')).toBeVisible();
        expect(features()).toEqual([]);
        fillRequest();
        expect(mocks.calculate).not.toHaveBeenCalled();
        fireEvent.click(calculateButton());
        await screen.findByRole('region', { name: 'Trial proposal' });
        expect(mocks.calculate).toHaveBeenCalledWith(
            { departure: { lat: -27.2, lon: 153.15 }, destination: { lat: -27, lon: 153.4 }, draftM: 1.6, speedKts: 6 },
            expect.any(AbortSignal),
        );
        expect(features().find((feature) => feature.geometry.type === 'LineString')?.geometry).toEqual({
            type: 'LineString',
            coordinates: route.coordinates,
        });
        expect(screen.getByText(route.warnings[0])).toBeVisible();
        expect(mocks.maps).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Close autorouting trial' }));
        expect(view.onClose).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('chart taps set the selected endpoints without recalculating or remounting Mapbox', async () => {
        await openWorkspace();
        const tap = (lat: number, lon: number) =>
            act(() => mocks.maps[0].handlers.get('click')!({ lngLat: { lat, wrap: () => ({ lng: lon }) } }));
        tap(-27.2, 153.15);
        const departureButton = screen.getByRole('button', { name: /^departure/i });
        expect(within(departureButton).getByText('27°12.000′S')).toBeVisible();
        expect(within(departureButton).getByText('153°09.000′E')).toBeVisible();
        expect(screen.getByRole('button', { name: /Destination/i })).toHaveAttribute('aria-pressed', 'true');
        tap(-27, 153.4);
        const destinationButton = screen.getByRole('button', { name: /^destination/i });
        expect(within(destinationButton).getByText('27°00.000′S')).toBeVisible();
        expect(within(destinationButton).getByText('153°24.000′E')).toBeVisible();
        expect(screen.queryByText('Position set')).not.toBeInTheDocument();
        expect(features().map((feature) => feature.geometry)).toEqual([
            { type: 'Point', coordinates: [153.15, -27.2] },
            { type: 'Point', coordinates: [153.4, -27] },
        ]);
        fireEvent.click(screen.getByRole('button', { name: /Departure/i }));
        tap(-27.1, 153.2);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(-27.1);
        expect(within(departureButton).getByText('27°06.000′S')).toBeVisible();
        expect(within(departureButton).getByText('153°12.000′E')).toBeVisible();
        expect(mocks.maps).toHaveLength(1);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each([
        ['19.999999', '-146.82', '20°00.000′N', '146°49.200′W'],
        ['-89.999999', '179.999999', '90°00.000′S', '180°00.000′E'],
        ['90', '-180', '90°00.000′N', '180°00.000′W'],
        ['0', '0', '0°00.000′N', '000°00.000′E'],
    ])(
        'shows manually entered %s, %s without changing the request coordinates',
        async (lat, lon, latitude, longitude) => {
            await openWorkspace();
            fillRequest();
            fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: lat } });
            fireEvent.change(screen.getByLabelText('departure longitude'), { target: { value: lon } });
            const button = screen.getByRole('button', { name: /^departure/i });
            expect(within(button).getByText(latitude)).toBeVisible();
            expect(within(button).getByText(longitude)).toBeVisible();
            fireEvent.click(calculateButton());
            await waitFor(() => expect(mocks.calculate).toHaveBeenCalled());
            expect(mocks.calculate.mock.calls[0][0].departure).toEqual({ lat: +lat, lon: +lon });
        },
    );

    it.each(['', '91'])(
        'removes the displayed coordinates when an endpoint becomes incomplete or invalid (%s)',
        async (lat) => {
            await openWorkspace();
            fillRequest();
            fireEvent.change(screen.getByLabelText('departure latitude'), { target: { value: lat } });
            const button = screen.getByRole('button', { name: /^departure/i });
            expect(button).toHaveTextContent('Tap chart or enter below');
            expect(button).not.toHaveTextContent('°');
            expect(calculateButton()).toBeDisabled();
        },
    );

    it.each([
        'departure latitude',
        'destination longitude',
        'Trial vessel draft in metres',
        'Trial cruising speed in knots',
    ])('editing %s aborts and cannot resurrect an outdated proposal', async (label) => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValueOnce(pending.promise);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        fireEvent.change(screen.getByLabelText(label), { target: { value: label.includes('latitude') ? '-26' : '2' } });
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve(route));
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        expect(features().some((feature) => feature.geometry.type === 'LineString')).toBe(false);
    });

    it('Clear aborts pending work, empties all fields and does not replace the map', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        await act(async () => pending.resolve(route));
        expect(signal.aborted).toBe(true);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        expect(screen.getByLabelText('Trial vessel draft in metres')).toHaveValue(null);
        expect(screen.getByLabelText('Trial cruising speed in knots')).toHaveValue(null);
        for (const endpoint of [/^departure/i, /^destination/i]) {
            const button = screen.getByRole('button', { name: endpoint });
            expect(button).toHaveTextContent('Tap chart or enter below');
            expect(button).not.toHaveTextContent('°');
        }
        expect(features()).toEqual([]);
        expect(calculateButton()).toBeDisabled();
        expect(mocks.maps).toHaveLength(1);
    });

    it('invalidates an already displayed proposal before a failed calculation; never draws a straight-line fallback', async () => {
        await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        await screen.findByRole('region', { name: 'Trial proposal' });
        fireEvent.change(screen.getByLabelText('Trial cruising speed in knots'), { target: { value: '7' } });
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        mocks.calculate.mockRejectedValueOnce(new Error('Trial coverage unavailable.'));
        fireEvent.click(calculateButton());
        expect(await screen.findByRole('alert')).toHaveTextContent('Trial coverage unavailable.');
        expect(features().every((feature) => feature.geometry.type === 'Point')).toBe(true);
    });

    it('closes and aborts calculation on identity change without leaking a late response', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        const { onClose } = await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        act(() => setAuthIdentityScope('another-account'));
        await act(async () => pending.resolve(route));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(true);
        expect(features()).toEqual([]);
        expect(screen.getByLabelText('Trial vessel draft in metres')).toHaveValue(null);
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
    });

    it('unmount aborts both availability and proposal requests and removes subscriptions', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValue(pending.promise);
        const view = await openWorkspace();
        fillRequest();
        fireEvent.click(calculateButton());
        const statusSignal = mocks.status.mock.calls[0][0] as AbortSignal;
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        view.unmount();
        expect(statusSignal.aborted).toBe(true);
        expect(signal.aborted).toBe(true);
        act(() => setAuthIdentityScope('next-account'));
        expect(view.onClose).not.toHaveBeenCalled();
        await act(async () => pending.resolve(route));
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('keeps an authorized unready chart available, but disables Calculate with an honest message', async () => {
        mocks.status.mockResolvedValue({ enabled: true, ready: false, message: 'Trial coverage is being configured.' });
        await openWorkspace();
        fillRequest();
        expect(screen.getByText('Trial coverage is being configured.')).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
        expect(mocks.maps).toHaveLength(1);
    });

    it.each([
        ['departure latitude', '91'],
        ['destination longitude', '181'],
        ['Trial vessel draft in metres', '0'],
        ['Trial vessel draft in metres', '31'],
        ['Trial cruising speed in knots', '101'],
    ])('rejects invalid %s=%s before requesting', async (label, value) => {
        await openWorkspace();
        fillRequest();
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('uses the pane portal and Escape closes only this workspace; daylight starts with a light basemap', async () => {
        document.documentElement.classList.add('display-light');
        const host = document.createElement('div');
        const frame = document.createElement('div');
        host.dataset.panePortal = 'planning';
        document.body.append(host, frame);
        const onClose = vi.fn();
        try {
            render(
                <PanePortalContext.Provider
                    value={{ id: 'planning', host, frameRef: { current: frame }, contentRef: { current: frame } }}
                >
                    <AutoroutingTrialWorkspace mapboxToken="fixture-token" onClose={onClose} />
                </PanePortalContext.Provider>,
            );
            await waitFor(() => expect(mocks.status).toHaveBeenCalled());
            const dialog = screen.getByRole('dialog', { name: 'Autorouting trial' });
            expect(dialog.parentElement).toBe(host);
            expect(dialog).not.toHaveAttribute('aria-modal');
            expect(mocks.maps[0].options.style).toBe('mapbox://styles/mapbox/light-v11');
            act(() => mocks.maps[0].handlers.get('load')!());
            expect(mocks.maps[0].addLayer).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'trial-ocean', type: 'raster' }),
                'labels',
            );
            fireEvent.keyDown(dialog, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
            host.remove();
            frame.remove();
        }
    });

    it('has no persistence, route handoff, event dispatch, live GPS or existing planner dependencies', () => {
        const source = readFileSync('components/autorouting/AutoroutingTrialWorkspace.tsx', 'utf8');
        expect(source).not.toMatch(
            /(?:localStorage|sessionStorage|dispatchEvent|passageHandoff|routeTracer|useVoyageForm|MapHub|GpsService|saveVoyagePlan)/,
        );
    });
});

function RoutingFlow({ onManual = vi.fn(), onClose = vi.fn() }: { onManual?: () => void; onClose?: () => void }) {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <button onClick={() => setOpen(true)}>Open routing choice</button>
            {open && (
                <RoutingModeDialog
                    mapboxToken="fixture-token"
                    onManual={() => {
                        onManual();
                        setOpen(false);
                    }}
                    onClose={() => {
                        onClose();
                        setOpen(false);
                    }}
                />
            )}
        </>
    );
}

function openChoice() {
    fireEvent.click(screen.getByRole('button', { name: 'Open routing choice' }));
    return screen.getByRole('dialog', { name: 'Choose routing mode' });
}

async function chooseAuto() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Auto routing' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
    await screen.findByRole('dialog', { name: 'Autorouting trial' });
    await waitFor(() => expect(mocks.maps.length).toBeGreaterThan(0));
    act(() => mocks.maps.at(-1)!.handlers.get('load')!());
}

describe('explicit routing mode choice', () => {
    it('does no availability or map work until mounted and immediately offers Manual while Auto is pending', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        render(<RoutingFlow />);
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.maps).toHaveLength(0);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const dialog = openChoice();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(0);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('Manual closes immediately without a calculation, map or extra status call and fences the old status', async () => {
        const pending = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValue(pending.promise);
        const onManual = vi.fn();
        const onClose = vi.fn();
        render(<RoutingFlow onManual={onManual} onClose={onClose} />);
        openChoice();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Manual routing' }));
        expect(onManual).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve({ enabled: true, ready: true }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(mocks.maps).toHaveLength(0);
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it.each(['denied', 'failed', 'signed out'] as const)(
        'keeps Manual available and Auto disabled when %s',
        async (state) => {
            if (state === 'denied') mocks.status.mockResolvedValue({ enabled: false, ready: false });
            if (state === 'failed') mocks.status.mockRejectedValue(new Error('Availability failed'));
            if (state === 'signed out') setAuthIdentityScope(null);
            const onManual = vi.fn();
            render(<RoutingFlow onManual={onManual} />);
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Open routing choice' }));
            });
            expect(screen.getByRole('dialog', { name: 'Choose routing mode' })).toBeVisible();
            expect(screen.getByRole('button', { name: 'Manual routing' })).toBeEnabled();
            expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
            if (state === 'signed out') expect(mocks.status).not.toHaveBeenCalled();
            fireEvent.click(screen.getByRole('button', { name: 'Auto routing' }));
            expect(mocks.maps).toHaveLength(0);
            fireEvent.click(screen.getByRole('button', { name: 'Manual routing' }));
            expect(onManual).toHaveBeenCalledTimes(1);
            expect(mocks.calculate).not.toHaveBeenCalled();
        },
    );

    it('opens Auto only after server authorization and snapshots selected location and vessel without changing settings', async () => {
        const pending = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValueOnce(pending.promise);
        mocks.location = { lat: -26.7, lon: 153.2, source: 'map_pin' };
        mocks.settings = { vessel: { draft: 6, cruisingSpeed: 7 } };
        render(<RoutingFlow />);
        openChoice();
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
        await act(async () => pending.resolve({ enabled: true, ready: true }));
        await chooseAuto();
        expect(mocks.maps[0].options.center).toEqual([153.2, -26.7]);
        expect(screen.getByLabelText('Trial vessel draft in metres')).toHaveValue(1.829);
        expect(screen.getByLabelText('Trial cruising speed in knots')).toHaveValue(7);
        expect(features()).toEqual([]);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        fireEvent.change(screen.getByLabelText('Trial vessel draft in metres'), { target: { value: '2' } });
        expect(mocks.settings.vessel).toEqual({ draft: 6, cruisingSpeed: 7 });
        expect(mocks.location).toEqual({ lat: -26.7, lon: 153.2, source: 'map_pin' });
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('uses saved location only when the location store is initial and never moves the shared location', async () => {
        mocks.settings = { defaultLocationCoords: { lat: -23.9, lon: 152.4 } };
        render(<RoutingFlow />);
        openChoice();
        await chooseAuto();
        expect(mocks.maps[0].options.center).toEqual([152.4, -23.9]);
        expect(mocks.location).toEqual({ lat: -27.47, lon: 153.02, source: 'initial' });
        expect(mocks.settings).toEqual({ defaultLocationCoords: { lat: -23.9, lon: 152.4 } });
    });

    it('lets an authorized but unready user open Auto without enabling Calculate', async () => {
        mocks.status.mockResolvedValue({ enabled: true, ready: false, message: 'Setup in progress.' });
        render(<RoutingFlow />);
        openChoice();
        await chooseAuto();
        fillRequest();
        expect(screen.getByText('Setup in progress.')).toBeVisible();
        expect(calculateButton()).toBeDisabled();
        expect(mocks.calculate).not.toHaveBeenCalled();
    });

    it('Cancel aborts pending authorization; a late success cannot reopen the flow and remount rechecks fresh', async () => {
        const old = deferred<{ enabled: boolean; ready: boolean }>();
        const fresh = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Close routing choice' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve({ enabled: true, ready: true }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        openChoice();
        expect(mocks.status).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        await act(async () => fresh.resolve({ enabled: false, ready: false }));
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
    });

    it('Escape closes the choice and restores its opener without choosing either route mode', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        const onClose = vi.fn();
        const onManual = vi.fn();
        render(<RoutingFlow onClose={onClose} onManual={onManual} />);
        const opener = screen.getByRole('button', { name: 'Open routing choice' });
        opener.focus();
        const dialog = openChoice();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onManual).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(mocks.maps).toHaveLength(0);
    });

    it('traps keyboard focus among available choices while authorization is pending', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        render(<RoutingFlow />);
        openChoice();
        const close = screen.getByRole('button', { name: 'Close routing choice' });
        const manual = screen.getByRole('button', { name: 'Manual routing' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(manual).toHaveFocus();
        fireEvent.keyDown(manual, { key: 'Tab' });
        expect(close).toHaveFocus();
        expect(mocks.maps).toHaveLength(0);
    });

    it('centres the choice and cancels only on its backdrop, not its content', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        const dialog = openChoice();
        const backdrop = dialog.parentElement!;
        expect(backdrop).toHaveClass('flex', 'items-center', 'justify-center');
        fireEvent.click(dialog);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps).toHaveLength(0);
    });

    it('Escape from Auto closes the whole flow without revealing a stale mode choice', async () => {
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await chooseAuto();
        const close = screen.getByRole('button', { name: 'Close autorouting trial' });
        close.focus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
    });

    it('account changes close and discard the choice rather than rechecking the old dialog', async () => {
        const old = deferred<{ enabled: boolean; ready: boolean }>();
        mocks.status.mockReturnValueOnce(old.promise).mockResolvedValue({ enabled: false, ready: false });
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        const signal = mocks.status.mock.calls[0][0] as AbortSignal;
        act(() => setAuthIdentityScope('not-entitled'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve({ enabled: true, ready: true }));
        expect(mocks.status).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        openChoice();
        await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
        expect(screen.getByRole('button', { name: 'Auto routing' })).toBeDisabled();
        expect(mocks.maps).toHaveLength(0);
    });

    it('account changes discard an open Auto map and prevent its late calculation from resurfacing', async () => {
        const pending = deferred<AutoroutingTrialRoute>();
        mocks.calculate.mockReturnValueOnce(pending.promise);
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await chooseAuto();
        fillRequest();
        fireEvent.click(calculateButton());
        const signal = mocks.calculate.mock.calls[0][1] as AbortSignal;
        act(() => setAuthIdentityScope('another-account'));
        await act(async () => pending.resolve(route));
        expect(signal.aborted).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
        expect(mocks.status).toHaveBeenCalledTimes(2);
    });

    it('closing Auto closes the entire flow and reopening takes fresh snapshots with no retained inputs or proposal', async () => {
        const onClose = vi.fn();
        render(<RoutingFlow onClose={onClose} />);
        openChoice();
        await chooseAuto();
        fillRequest();
        fireEvent.click(calculateButton());
        await screen.findByRole('region', { name: 'Trial proposal' });
        fireEvent.click(screen.getByRole('button', { name: 'Close autorouting trial' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.maps[0].remove).toHaveBeenCalledTimes(1);
        mocks.location = { lat: -23.9, lon: 152.4, source: 'map_pin' };
        mocks.settings = { vessel: { draft: 5, cruisingSpeed: 8 } };
        openChoice();
        await chooseAuto();
        expect(mocks.maps).toHaveLength(2);
        expect(mocks.maps[1].options.center).toEqual([152.4, -23.9]);
        expect(screen.getByLabelText('Trial vessel draft in metres')).toHaveValue(1.524);
        expect(screen.getByLabelText('departure latitude')).toHaveValue(null);
        expect(screen.getByLabelText('destination latitude')).toHaveValue(null);
        expect(features()).toEqual([]);
        expect(screen.queryByRole('region', { name: 'Trial proposal' })).not.toBeInTheDocument();
        expect(mocks.calculate).toHaveBeenCalledTimes(1);
    });

    it('scopes the centred choice to its pane, leaves the other pane usable and ignores its Escape', () => {
        mocks.status.mockReturnValue(new Promise(() => undefined));
        const host = document.createElement('div');
        const frame = document.createElement('div');
        const otherPane = document.createElement('div');
        const otherControl = document.createElement('button');
        host.dataset.panePortal = 'planning';
        frame.dataset.splitPane = 'planning';
        otherPane.dataset.splitPane = 'weather';
        otherPane.append(otherControl);
        document.body.append(host, frame, otherPane);
        const onClose = vi.fn();
        try {
            render(
                <PanePortalContext.Provider
                    value={{ id: 'planning', host, frameRef: { current: frame }, contentRef: { current: frame } }}
                >
                    <RoutingFlow onClose={onClose} />
                </PanePortalContext.Provider>,
            );
            const dialog = openChoice();
            expect(host.contains(dialog)).toBe(true);
            expect(dialog).not.toHaveAttribute('aria-modal');
            expect(frame).toHaveAttribute('inert');
            expect(otherPane).not.toHaveAttribute('inert');
            otherControl.focus();
            fireEvent.keyDown(otherControl, { key: 'Escape' });
            expect(onClose).not.toHaveBeenCalled();
            expect(dialog).toBeVisible();
            const close = screen.getByRole('button', { name: 'Close routing choice' });
            close.focus();
            fireEvent.keyDown(close, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(frame).not.toHaveAttribute('inert');
            expect(otherPane).not.toHaveAttribute('inert');
            expect(mocks.maps).toHaveLength(0);
        } finally {
            cleanup();
            host.remove();
            frame.remove();
            otherPane.remove();
        }
    });

    it('does not import planner, persistence, live GPS or route handoff machinery', () => {
        const source = readFileSync('components/autorouting/RoutingModeDialog.tsx', 'utf8');
        expect(source).not.toMatch(
            /(?:localStorage|sessionStorage|dispatchEvent|passageHandoff|routeTracer|useVoyageForm|MapHub|GpsService|saveVoyagePlan|useWeather)/,
        );
    });
});
