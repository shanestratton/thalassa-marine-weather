import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TideCanvas } from '../components/dashboard/tide/TideCanvas';

const props = {
    dataPoints: [
        { time: 0, height: 0.4 },
        { time: 12, height: 2 },
        { time: 24, height: 0.4 },
    ],
    currentHour: 12,
    currentHeight: 2,
    minHeight: 0.4,
    maxHeight: 2,
    domainBuffer: 0.2,
};
let width = 276.5,
    height = 81;
let resize: () => void;
const originalResizeObserver = globalThis.ResizeObserver;
const context = () =>
    new Proxy(
        {
            setTransform: vi.fn(),
            clearRect: vi.fn(),
            lineTo: vi.fn(),
            createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        },
        {
            get(target, key) {
                if (!Reflect.has(target, key)) Reflect.set(target, key, vi.fn());
                return Reflect.get(target, key);
            },
        },
    );
beforeEach(() => {
    width = 276.5;
    height = 81;
    vi.stubGlobal('devicePixelRatio', 3);
    globalThis.ResizeObserver = class {
        constructor(callback: ResizeObserverCallback) {
            resize = () => callback([], this);
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        width,
        height,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({}),
    }));
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.ResizeObserver = originalResizeObserver;
});
describe('tide backing-store lifetime', () => {
    it('keeps one integer surface through repeated same-size layout redraws and resets the transform absolutely', () => {
        const ctx = context();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
        const setWidth = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
        const setHeight = vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set');
        const view = render(<TideCanvas {...props} />);
        const canvas = view.container.querySelector('canvas')!;
        expect(canvas.width).toBe(830);
        expect(canvas.height).toBe(243);
        act(() => {
            resize();
            resize();
        });
        expect(setWidth).toHaveBeenCalledTimes(1);
        expect(setHeight).toHaveBeenCalledTimes(1);
        expect(ctx.setTransform).toHaveBeenCalledTimes(3);
        expect(ctx.setTransform).toHaveBeenLastCalledWith(3, 0, 0, 3, 0, 0);
        expect(ctx.clearRect).toHaveBeenCalledTimes(3);
        height = 100;
        act(() => resize());
        expect(setWidth).toHaveBeenCalledTimes(1);
        expect(setHeight).toHaveBeenCalledTimes(2);
        expect(canvas.height).toBe(300);
    });
    it('does not destroy the bitmap while the host is temporarily zero-sized', () => {
        height = 0;
        const ctx = context();
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
        const setWidth = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
        render(<TideCanvas {...props} />);
        expect(getContext).not.toHaveBeenCalled();
        expect(setWidth).not.toHaveBeenCalled();
        height = 81;
        act(() => resize());
        expect(getContext).toHaveBeenCalledOnce();
        expect(ctx.clearRect).toHaveBeenCalledOnce();
    });
    it('redraws changed vertical headroom without recreating an unchanged backing store', () => {
        const ctx = context();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
        const setWidth = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
        const view = render(<TideCanvas {...props} />);
        const first = structuredClone(vi.mocked(ctx.lineTo).mock.calls);
        vi.mocked(ctx.lineTo).mockClear();
        view.rerender(<TideCanvas {...props} domainBuffer={0.8} />);
        expect(ctx.clearRect).toHaveBeenCalledTimes(2);
        expect(vi.mocked(ctx.lineTo).mock.calls).not.toEqual(first);
        expect(setWidth).toHaveBeenCalledOnce();
    });
});
