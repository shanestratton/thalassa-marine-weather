import React from 'react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type mapboxgl from 'mapbox-gl';
const api = vi.hoisted(() => ({ rpc: vi.fn(), available: true }));
vi.mock('../services/supabase', () => ({
    get supabase() {
        return api.available ? { rpc: (...args: unknown[]) => api.rpc(...args) } : null;
    },
}));
import Layer from '../components/map/ReceiverCoverageLayer';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const now = 1800000000000;
const reply = () => ({
    error: null,
    data: {
        schema: 1,
        state: 'available',
        cells: ['v1:31:166'],
        partial: false,
        asOf: now - 300000,
        expiresAt: now + 60000,
    },
});
function fixture(boundsAvailable = true) {
    let data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    const sources = new Map<string, { setData(v: GeoJSON.FeatureCollection): void }>(),
        layers = new Set<string>(),
        listeners = new Map<string, Set<() => void>>();
    const map = {
        isStyleLoaded: () => true,
        getBounds: () =>
            boundsAvailable
                ? { getWest: () => 150, getSouth: () => -30, getEast: () => 155, getNorth: () => -24 }
                : null,
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, v: { data: GeoJSON.FeatureCollection }) => {
            data = v.data;
            sources.set(id, {
                setData: (v) => {
                    data = v;
                },
            });
        },
        getLayer: (id: string) => layers.has(id),
        addLayer: (v: { id: string }) => layers.add(v.id),
        removeLayer: (id: string) => layers.delete(id),
        removeSource: (id: string) => sources.delete(id),
        on: (event: string, fn: () => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
    };
    return {
        mapRef: { current: map as unknown as mapboxgl.Map },
        data: () => data,
        layers,
        emit: (event: string) => listeners.get(event)?.forEach((fn) => fn()),
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    api.rpc.mockReset();
    api.available = true;
    setAuthIdentityScope('10000000-0000-4000-8000-000000000001');
});
afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
});
it('an unready camera makes no coverage request and remains unavailable', () => {
    const f = fixture(false),
        status = vi.fn();
    render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    expect(api.rpc).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', partial: false, cells: 0, asOf: null });
    expect(f.data().features).toEqual([]);
});
it('an unavailable backend client makes no request or geometry', () => {
    api.available = false;
    const f = fixture(),
        status = vi.fn();
    render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    expect(api.rpc).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', partial: false, cells: 0, asOf: null });
    expect(f.data().features).toEqual([]);
});
it('default off and anonymous views make no coverage request or geometry', () => {
    const f = fixture(),
        status = vi.fn();
    const view = render(<Layer mapRef={f.mapRef} mapReady active={false} onStatus={status} />);
    expect(api.rpc).not.toHaveBeenCalled();
    setAuthIdentityScope(null);
    view.rerender(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ state: 'signed-out', partial: false, cells: 0, asOf: null });
    expect(api.rpc).not.toHaveBeenCalled();
});
it('auth A/B/A during actual RPC await clears and rejects an old account result', async () => {
    const f = fixture(),
        status = vi.fn();
    let resolve!: (v: ReturnType<typeof reply>) => void;
    api.rpc.mockImplementation(() => ({
        abortSignal: () =>
            new Promise((r) => {
                resolve = r;
            }),
    }));
    render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    expect(api.rpc).toHaveBeenCalledTimes(1);
    act(() => {
        setAuthIdentityScope('10000000-0000-4000-8000-000000000002');
        setAuthIdentityScope('10000000-0000-4000-8000-000000000001');
    });
    await act(async () => {
        resolve(reply());
        await Promise.resolve();
    });
    expect(f.data().features).toEqual([]);
    expect(f.layers.size).toBe(0);
    expect(status.mock.calls.some(([s]) => s.state === 'available')).toBe(false);
});
it('current cells paint only the fixed original geometry, expire, and are removed on unmount', async () => {
    const f = fixture(),
        status = vi.fn();
    api.rpc.mockImplementation(() => ({ abortSignal: async () => reply() }));
    const view = render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    await act(async () => {
        await Promise.resolve();
    });
    expect(f.data().features).toHaveLength(1);
    expect(f.layers.size).toBe(2);
    expect(f.data().features[0].properties).toEqual({ cell: 'v1:31:166' });
    await act(async () => {
        vi.advanceTimersByTime(60000);
        await Promise.resolve();
    });
    expect(f.data().features).toEqual([]);
    view.unmount();
    expect(f.layers.size).toBe(0);
});
it('map movement invalidates an old response even before the next request is sent', async () => {
    const f = fixture(),
        status = vi.fn();
    let resolve!: (v: ReturnType<typeof reply>) => void;
    api.rpc.mockImplementation(() => ({
        abortSignal: () =>
            new Promise((r) => {
                resolve = r;
            }),
    }));
    render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    act(() => f.emit('moveend'));
    await act(async () => {
        resolve(reply());
        await Promise.resolve();
    });
    expect(f.data().features).toEqual([]);
    expect(f.layers.size).toBe(0);
});
it('a short response expiry clears geometry and status before the next minute refresh', async () => {
    const f = fixture(),
        status = vi.fn(),
        short = reply();
    short.data.expiresAt = now + 2000;
    api.rpc.mockImplementation(() => ({ abortSignal: async () => short }));
    const view = render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    await act(async () => {
        await Promise.resolve();
    });
    expect(f.data().features).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1999));
    expect(f.data().features).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(f.data().features).toEqual([]);
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', partial: false, cells: 0, asOf: null });
    expect(api.rpc).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
it('ignored native cancellation remains bounded across timeouts and remounts', async () => {
    const f = fixture(),
        status = vi.fn(),
        resolves: ((v: ReturnType<typeof reply>) => void)[] = [];
    api.rpc.mockImplementation(() => ({
        abortSignal: () =>
            new Promise((r) => {
                resolves.push(r);
            }),
    }));
    let view = render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    await act(async () => {
        await vi.advanceTimersByTimeAsync(5500);
    });
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', partial: false, cells: 0, asOf: null });
    view.unmount();
    view = render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    await act(async () => {
        await vi.advanceTimersByTimeAsync(5500);
    });
    view.unmount();
    view = render(<Layer mapRef={f.mapRef} mapReady active onStatus={status} />);
    expect(api.rpc).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', partial: false, cells: 0, asOf: null });
    await act(async () => {
        resolves.forEach((resolve) => resolve(reply()));
        await Promise.resolve();
    });
    expect(f.data().features).toEqual([]);
    view.unmount();
});
