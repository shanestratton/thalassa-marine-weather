import React, { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLightningLayer } from '../components/map/useLightningLayer';

const mocks = vi.hoisted(() => ({
    listeners: new Set<(strike: unknown) => void>(),
    subscribe: vi.fn(),
    stats: vi.fn(),
}));
vi.mock('../services/weather/api/blitzortungLightning', () => ({
    subscribeLightningStrikes: mocks.subscribe,
    setLightningViewportStats: mocks.stats,
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

function makeMap() {
    const layers = new Map<string, unknown>();
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const images = new Set<string>();
    return {
        layers,
        sources,
        images,
        map: {
            getSource: (id: string) => sources.get(id),
            addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
            removeSource: (id: string) => sources.delete(id),
            getLayer: (id: string) => layers.get(id),
            addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
            removeLayer: (id: string) => layers.delete(id),
            hasImage: (id: string) => images.has(id),
            addImage: (id: string) => images.add(id),
            removeImage: (id: string) => images.delete(id),
            getStyle: () => ({ layers: [] }),
            getZoom: () => 3,
            getBounds: () => ({ contains: () => true }),
            flyTo: vi.fn(),
        },
    };
}

describe('lightning lifecycle', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    beforeEach(() => {
        mocks.listeners.clear();
        mocks.subscribe.mockReset().mockImplementation((listener: (strike: unknown) => void) => {
            mocks.listeners.add(listener);
            return () => mocks.listeners.delete(listener);
        });
        mocks.stats.mockClear();
        frames.clear();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        // The Blitzortung layer sits behind its licence flag, OFF by default
        // since build 123 (tests/BlitzortungLicenceFlag.test.tsx). This file
        // tests the layer itself, so it runs with the flag flipped on.
        vi.stubEnv('VITE_BLITZORTUNG_ENABLED', 'true');
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('restarts its subscription and animation after StrictMode cleanup replay', () => {
        const { map, layers, sources } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(() => useLightningLayer(ref, true, true), {
            wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
        });
        expect(mocks.subscribe).toHaveBeenCalledTimes(2);
        expect(mocks.listeners.size).toBe(1);
        expect(frames.size).toBe(1);
        expect(layers.size).toBe(6);
        expect(sources.size).toBe(1);
        hook.unmount();
        expect(mocks.listeners.size).toBe(0);
        expect(frames.size).toBe(0);
        expect(layers.size).toBe(0);
        expect(sources.size).toBe(0);
        expect(mocks.stats).toHaveBeenLastCalledWith(0, 0);
    });

    it('can cycle readiness and visibility without retaining stale strikes or dead subscriptions', () => {
        const { map, sources, layers } = makeMap();
        const ref = { current: map as never };
        const hook = renderHook(({ ready, visible }) => useLightningLayer(ref, ready, visible), {
            initialProps: { ready: true, visible: true },
        });
        act(() => {
            for (const listener of mocks.listeners)
                listener({ id: 'strike', time: Date.now(), lat: -27, lon: 153, polarity: 'unknown' });
            const [id, callback] = [...frames][0];
            frames.delete(id);
            callback(500);
        });
        expect(sources.get('lightning-blitz-source')?.setData).toHaveBeenLastCalledWith(
            expect.objectContaining({ features: [expect.anything()] }),
        );
        hook.rerender({ ready: false, visible: true });
        expect(mocks.listeners.size).toBe(0);
        expect(layers.size).toBe(0);
        hook.rerender({ ready: true, visible: true });
        expect(mocks.listeners.size).toBe(1);
        expect(frames.size).toBe(1);
        hook.rerender({ ready: true, visible: false });
        expect(mocks.listeners.size).toBe(0);
        expect(layers.size).toBe(0);
        hook.rerender({ ready: true, visible: true });
        expect(mocks.listeners.size).toBe(1);
        expect(mocks.subscribe).toHaveBeenCalledTimes(3);
        hook.unmount();
    });
});
