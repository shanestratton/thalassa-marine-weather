import React, { useRef, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';

const mocks = vi.hoisted(() => ({
    clean: true,
    deactivation: 'absent' as 'absent' | 'hidden' | 'failed',
    deactivate: vi.fn(),
    isUnmounted: vi.fn(),
    isMounted: vi.fn(() => true),
    mount: vi.fn(),
    fetch: vi.fn(),
    status: vi.fn(() => ({ generation: 'g-20260806', sourceDate: '2026-08-06T00:00:00Z' })),
    release: vi.fn(),
    persistentError: vi.fn(),
    dismiss: vi.fn(),
}));

vi.mock('../components/map/MpaLayer', () => ({
    MPA_FILL_ID: 'mpa-aus-fill',
    deactivateMpaLayerAndProveSafe: mocks.deactivate,
    isMpaLayerUnmounted: mocks.isUnmounted,
    isMpaLayerMounted: mocks.isMounted,
    mountMpaLayer: mocks.mount,
}));

vi.mock('../services/weather/api/mpaDataset', () => ({
    MPA_CACHE_TTL_MS: 60_000,
    fetchVerifiedMpaGeoJson: mocks.fetch,
    getVerifiedMpaDatasetStatus: mocks.status,
    releaseMpaDataset: mocks.release,
}));

vi.mock('../components/Toast', () => ({
    toast: {
        persistentError: mocks.persistentError,
        dismiss: mocks.dismiss,
    },
}));

let useMpaLayerHook: typeof import('../components/map/useMpaLayer').useMpaLayer;

beforeAll(async () => {
    vi.stubEnv('VITE_MPA_ENABLED', 'true');
    ({ useMpaLayer: useMpaLayerHook } = await import('../components/map/useMpaLayer'));
});

afterAll(() => vi.unstubAllEnvs());

function fakeMap() {
    const lifecycleHandlers = new Map<string, () => void>();
    return {
        on: vi.fn((event: string, ...args: unknown[]) => {
            const handler = args.at(-1);
            if ((event === 'styledata' || event === 'idle') && typeof handler === 'function') {
                lifecycleHandlers.set(event, handler as () => void);
            }
        }),
        off: vi.fn((event: string) => lifecycleHandlers.delete(event)),
        queryRenderedFeatures: vi.fn(() => []),
        getCanvas: vi.fn(() => ({ style: {}, focus: vi.fn() })),
        lifecycleHandlers,
    };
}

function Harness({ map, initialVisible = true }: { map: ReturnType<typeof fakeMap>; initialVisible?: boolean }) {
    const mapRef = useRef(map as unknown as mapboxgl.Map);
    const [visible, setVisible] = useState(initialVisible);
    useMpaLayerHook(mapRef, true, visible, setVisible);
    return <div>{visible ? 'mpa-selected' : 'mpa-off'}</div>;
}

describe('MPA fail-closed Retry lifecycle', () => {
    beforeEach(() => {
        mocks.clean = true;
        mocks.deactivation = 'absent';
        mocks.deactivate.mockReset().mockImplementation(() => {
            if (mocks.deactivation === 'absent') mocks.clean = true;
            return mocks.deactivation;
        });
        mocks.isUnmounted.mockReset().mockImplementation(() => mocks.clean);
        mocks.isMounted.mockClear();
        mocks.mount.mockReset().mockResolvedValue(true);
        mocks.fetch.mockReset();
        mocks.release.mockClear();
        mocks.persistentError.mockReset().mockImplementation(() => mocks.persistentError.mock.calls.length);
        mocks.dismiss.mockClear();
    });

    it('deselects after a safely hidden verification failure and Retry starts a fresh fetch only after absence', async () => {
        mocks.fetch.mockResolvedValueOnce(null).mockResolvedValueOnce({ type: 'FeatureCollection', features: [] });
        mocks.deactivation = 'hidden';
        const map = fakeMap();
        render(<Harness map={map} />);

        expect(await screen.findByText('mpa-off')).toBeInTheDocument();
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.persistentError).toHaveBeenCalled();
        const retry = mocks.persistentError.mock.calls[0]?.[1]?.onClick as (() => void) | undefined;

        await act(async () => {
            retry?.();
        });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(screen.getByText('mpa-off')).toBeInTheDocument();

        mocks.deactivation = 'absent';
        const latestRetry = mocks.persistentError.mock.calls.at(-1)?.[1]?.onClick as (() => void) | undefined;
        await act(async () => {
            latestRetry?.();
        });

        expect(await screen.findByText('mpa-selected')).toBeInTheDocument();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.mount).toHaveBeenCalledOnce();
        expect(mocks.release).toHaveBeenCalled();
    });

    it('blocks even the manifest fetch while a prior hidden presentation cannot be fully removed', async () => {
        mocks.clean = false;
        mocks.deactivation = 'hidden';
        mocks.fetch.mockResolvedValue({ type: 'FeatureCollection', features: [] });
        render(<Harness map={fakeMap()} />);

        expect(await screen.findByText('mpa-off')).toBeInTheDocument();
        expect(mocks.fetch).not.toHaveBeenCalled();

        const retry = mocks.persistentError.mock.calls.at(-1)?.[1]?.onClick as (() => void) | undefined;
        await act(async () => retry?.());
        expect(mocks.fetch).not.toHaveBeenCalled();

        mocks.deactivation = 'absent';
        const finalRetry = mocks.persistentError.mock.calls.at(-1)?.[1]?.onClick as (() => void) | undefined;
        await act(async () => finalRetry?.());
        expect(await screen.findByText('mpa-selected')).toBeInTheDocument();
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });

    it('keeps an honest Retry notice available while user-off cleanup remains unsafe', async () => {
        mocks.clean = false;
        mocks.deactivation = 'failed';
        const map = fakeMap();
        render(<Harness map={map} initialVisible={false} />);

        expect(screen.getByText('mpa-off')).toBeInTheDocument();
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.persistentError).toHaveBeenCalledTimes(1);
        expect(mocks.persistentError.mock.calls[0]?.[0]).toMatch(/may still be visible\. Do not rely/i);

        const retry = mocks.persistentError.mock.calls[0]?.[1]?.onClick as (() => void) | undefined;
        await act(async () => retry?.());
        expect(mocks.persistentError).toHaveBeenCalledTimes(2);
        expect(map.lifecycleHandlers.has('idle')).toBe(true);

        mocks.deactivation = 'absent';
        const finalRetry = mocks.persistentError.mock.calls.at(-1)?.[1]?.onClick as (() => void) | undefined;
        await act(async () => finalRetry?.());
        expect(mocks.release).toHaveBeenCalled();
        expect(mocks.dismiss).toHaveBeenCalled();
        expect(map.lifecycleHandlers.size).toBe(0);
    });

    it('dismisses the owned cleanup notice when the off-effect is disposed before absence', () => {
        mocks.clean = false;
        mocks.deactivation = 'failed';
        const map = fakeMap();
        const view = render(<Harness map={map} initialVisible={false} />);

        expect(mocks.persistentError).toHaveBeenCalledTimes(1);
        view.unmount();
        view.unmount();

        expect(mocks.dismiss).toHaveBeenCalledOnce();
        expect(map.lifecycleHandlers.size).toBe(0);
    });
});
