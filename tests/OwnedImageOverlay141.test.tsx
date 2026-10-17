import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useOwnedImageOverlay,
    validateOwnedImageFrame,
    type OwnedImageFrame,
    type OwnedImageOverlayOptions,
} from '../components/map/useOwnedImageOverlay';
import { ownedVectorFixture } from './helpers/ownedVectorFixture';
import { toast } from '../components/Toast';
vi.mock('../components/Toast', () => ({ toast: { persistentError: vi.fn(() => 1), dismiss: vi.fn() } }));
function fixture() {
    const f = ownedVectorFixture();
    const image: OwnedImageFrame = {
        url: `blob:${new URL(location.href).origin}/00000000-0000-4000-8000-000000000000`,
        width: 1024,
        height: 512,
        coordinates: [
            [170, 70],
            [190, 70],
            [190, 60],
            [170, 60],
        ],
        release: vi.fn(),
    };
    const options: OwnedImageOverlayOptions = {
        id: 'owned-image',
        label: 'Observed image',
        credit: 'Original image credit',
        enabled: true,
        owner: f.view,
        revision: 'exact-frame-window',
        sourceCurrent: f.view.isCurrent,
        prepare: vi.fn(() => image),
        maxEdge: 1024,
    };
    return {
        ...f,
        image,
        options,
        content: () => f.map.emit('sourcedata', { sourceId: 'owned-image-source', sourceDataType: 'content' }),
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('prepared image URL ownership', () => {
    it('hands one bounded local URL to an actual image-source specification and releases once after proven removal', () => {
        const f = fixture();
        const hook = renderHook(() => useOwnedImageOverlay(f.mapRef, true, f.options));
        expect(f.map.addSource).toHaveBeenCalledWith('owned-image-source', {
            type: 'image',
            url: f.image.url,
            coordinates: f.image.coordinates,
        });
        expect(f.image.release).not.toHaveBeenCalled();
        act(f.content);
        expect(hook.result.current).toBe('ready');
        hook.unmount();
        expect(f.map.sources.size).toBe(0);
        expect(f.image.release).toHaveBeenCalledTimes(1);
        act(() => f.map.emit('remove'));
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
    it('never revokes uncertain-visible evidence, even after user-off and unmount', () => {
        const f = fixture();
        const hook = renderHook(({ value }) => useOwnedImageOverlay(f.mapRef, true, value), {
            initialProps: { value: f.options },
        });
        f.map.removeLayer.mockImplementation(() => undefined);
        f.map.setLayoutProperty.mockImplementation(() => undefined);
        hook.rerender({ value: { ...f.options, enabled: false } });
        expect(hook.result.current).toBe('stuck-visible');
        expect(f.image.release).not.toHaveBeenCalled();
        hook.unmount();
        expect(f.image.release).not.toHaveBeenCalled();
        expect(toast.persistentError).toHaveBeenCalledWith(
            expect.stringContaining('Original image credit'),
            expect.anything(),
        );
        act(() => f.map.emit('remove'));
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
    it('keeps a proven-hidden residual source and URL until the original source is absent', () => {
        const f = fixture();
        const hook = renderHook(({ value }) => useOwnedImageOverlay(f.mapRef, true, value), {
            initialProps: { value: f.options },
        });
        const remove = f.map.removeLayer.getMockImplementation()!;
        f.map.removeLayer.mockImplementation(() => undefined);
        hook.rerender({ value: { ...f.options, enabled: false } });
        expect(hook.result.current).toBe('off');
        expect(f.image.release).not.toHaveBeenCalled();
        f.map.removeLayer.mockImplementation(remove);
        act(() => f.map.emit('idle'));
        expect(f.map.sources.size).toBe(0);
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
    it('reuses the same original URL across a restyle without revoking it between styles', () => {
        const f = fixture();
        const hook = renderHook(() => useOwnedImageOverlay(f.mapRef, true, f.options));
        act(f.content);
        act(() => f.map.restyle());
        expect(f.options.prepare).toHaveBeenCalledTimes(1);
        expect(f.map.addSource).toHaveBeenCalledTimes(2);
        expect(f.image.release).not.toHaveBeenCalled();
        act(f.content);
        expect(hook.result.current).toBe('ready');
        hook.unmount();
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
    it('releases an unpresented URL when its original source retires during preparation', () => {
        const f = fixture();
        const hook = renderHook(() =>
            useOwnedImageOverlay(f.mapRef, true, {
                ...f.options,
                prepare: () => {
                    f.retire();
                    return f.image;
                },
            }),
        );
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.addSource).not.toHaveBeenCalled();
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
    it('drops an unreadied URL at the original ten-second rendering deadline', () => {
        const f = fixture();
        const hook = renderHook(() => useOwnedImageOverlay(f.mapRef, true, f.options));
        act(() => vi.advanceTimersByTime(10_001));
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.sources.size).toBe(0);
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
    it.each([
        { width: 1025 },
        { height: 0 },
        { url: 'https://gibs.earthdata.nasa.gov/unbounded.png' },
        { url: 'data:image/svg+xml,<svg/>' },
        {
            coordinates: [
                [0, 90],
                [1, 90],
                [1, 80],
                [0, 80],
            ],
        },
        {
            coordinates: [
                [0, 2],
                [361, 2],
                [361, 0],
                [0, 0],
            ],
        },
    ])('refuses invalid image dimensions/local URL/corners %j', (patch) => {
        const f = fixture();
        expect(() => validateOwnedImageFrame({ ...f.image, ...patch } as OwnedImageFrame, 1024)).toThrow();
        const config: OwnedImageOverlayOptions = {
            ...f.options,
            prepare: () => ({ ...f.image, ...patch }) as OwnedImageFrame,
        };
        const hook = renderHook(() => useOwnedImageOverlay(f.mapRef, true, config));
        expect(hook.result.current).toBe('unavailable');
        expect(f.map.addSource).not.toHaveBeenCalled();
        expect(f.image.release).toHaveBeenCalledTimes(1);
    });
});
