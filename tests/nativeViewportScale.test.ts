import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockNativeViewportScale, NATIVE_VIEWPORT_CONTENT } from '../utils/nativeViewportScale';

type Listener = () => void;

function fakeWindow(scale: number) {
    const listeners = new Set<Listener>();
    const frames: FrameRequestCallback[] = [];
    const viewport = {
        scale,
        addEventListener: (_: string, fn: Listener) => listeners.add(fn),
        removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    };
    const win = {
        visualViewport: viewport,
        requestAnimationFrame: (cb: FrameRequestCallback) => {
            frames.push(cb);
            return frames.length;
        },
    } as unknown as Window;
    return {
        win,
        viewport,
        resize: () => listeners.forEach((fn) => fn()),
        flushFrames: () => frames.splice(0).forEach((cb) => cb(0)),
        listenerCount: () => listeners.size,
    };
}

const viewportMeta = () => document.querySelector('meta[name="viewport"]')!;

describe('lockNativeViewportScale', () => {
    afterEach(() => {
        document.head.innerHTML = '';
    });

    it('locks the scale on the existing viewport meta, keeping the safe-area fit', () => {
        document.head.innerHTML =
            '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />';
        lockNativeViewportScale(document, fakeWindow(1).win);
        const content = viewportMeta().getAttribute('content')!;
        expect(content).toBe(NATIVE_VIEWPORT_CONTENT);
        expect(content).toContain('maximum-scale=1');
        expect(content).toContain('user-scalable=no');
        expect(content).toContain('viewport-fit=cover');
        expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    });

    it('adds a viewport meta if the page has none', () => {
        lockNativeViewportScale(document, fakeWindow(1).win);
        expect(viewportMeta().getAttribute('content')).toBe(NATIVE_VIEWPORT_CONTENT);
    });

    // Shane 2026-09-29: the screen went big and would not come back.
    it('snaps a page that did zoom back to 1x instead of leaving it stuck', () => {
        const w = fakeWindow(1);
        lockNativeViewportScale(document, w.win);
        const writes = vi.spyOn(viewportMeta(), 'setAttribute');
        w.viewport.scale = 1.6;
        w.resize();
        expect(writes).toHaveBeenCalledTimes(1);
        expect(viewportMeta().getAttribute('content')).not.toBe(NATIVE_VIEWPORT_CONTENT);
        // A second event mid-restore does not stack another rewrite.
        w.resize();
        expect(writes).toHaveBeenCalledTimes(1);
        w.flushFrames();
        expect(viewportMeta().getAttribute('content')).toBe(NATIVE_VIEWPORT_CONTENT);
    });

    it('also heals when a field loses focus, and leaves an unzoomed page alone', () => {
        const w = fakeWindow(1);
        lockNativeViewportScale(document, w.win);
        const writes = vi.spyOn(viewportMeta(), 'setAttribute');
        document.dispatchEvent(new Event('focusout'));
        w.resize();
        expect(writes).not.toHaveBeenCalled();
        w.viewport.scale = 1.3;
        document.dispatchEvent(new Event('focusout'));
        expect(writes).toHaveBeenCalledTimes(1);
    });

    it('removes its listeners when disposed', () => {
        const w = fakeWindow(1);
        const dispose = lockNativeViewportScale(document, w.win);
        expect(w.listenerCount()).toBe(1);
        dispose();
        expect(w.listenerCount()).toBe(0);
    });

    // The lock is the iPhone app's. The web page keeps a zoomable viewport:
    // CI's Lighthouse audit fails a page that disables zoom.
    it('is applied only on the native platform, and index.html stays zoomable', () => {
        const root = resolve(__dirname, '..');
        const boot = readFileSync(resolve(root, 'index.tsx'), 'utf8');
        expect(boot).toMatch(
            /if \(Capacitor\.isNativePlatform\(\)[^)]*\) \{\s*lockNativeViewportScale\(document, window\);/,
        );
        const html = readFileSync(resolve(root, 'index.html'), 'utf8');
        const meta = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
        expect(meta).toContain('width=device-width');
        expect(meta).not.toMatch(/maximum-scale|user-scalable/);
    });
});
