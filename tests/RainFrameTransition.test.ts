import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    RAIN_FRAME_FADE_MS,
    RAIN_FRAME_STAGE_DEADLINE_MS,
    RainFrameTransitionController,
    type RainFrameEventListener,
    type RainFrameMap,
} from '../components/map/rainFrameTransition';

class FakeRainMap implements RainFrameMap {
    readonly layers = new Set<string>();
    readonly layout = new Map<string, 'visible' | 'none'>();
    readonly opacity = new Map<string, number>();
    readonly loadedSources = new Set<string>();
    private readonly listeners: Record<'sourcedata' | 'render', Set<RainFrameEventListener>> = {
        sourcedata: new Set(),
        render: new Set(),
    };

    constructor(...ids: string[]) {
        for (const id of ids) {
            this.layers.add(id);
            this.layout.set(id, 'none');
            this.opacity.set(id, 0.75);
        }
    }

    getLayer(id: string): unknown {
        return this.layers.has(id) ? { id } : undefined;
    }

    setLayoutProperty(id: string, _property: 'visibility', value: 'visible' | 'none'): void {
        this.layout.set(id, value);
    }

    setPaintProperty(id: string, _property: 'raster-opacity', value: number): void {
        this.opacity.set(id, value);
    }

    on(event: 'sourcedata' | 'render', listener: RainFrameEventListener): void {
        this.listeners[event].add(listener);
    }

    off(event: 'sourcedata' | 'render', listener: RainFrameEventListener): void {
        this.listeners[event].delete(listener);
    }

    isSourceLoaded(id: string): boolean {
        return this.loadedSources.has(id);
    }

    emitSourceData(
        sourceId: string,
        extra: {
            sourceDataType?: 'metadata' | 'content' | 'visibility' | 'error';
            isSourceLoaded?: boolean;
            tile?: unknown;
        } = {},
    ): void {
        for (const listener of [...this.listeners.sourcedata]) listener({ sourceId, ...extra });
    }

    emitRender(): void {
        for (const listener of [...this.listeners.render]) listener();
    }

    setCommitted(id: string): void {
        this.layout.set(id, 'visible');
        this.opacity.set(id, 0.75);
    }
}

describe('RainFrameTransitionController', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('keeps the current rain image visible until the requested source is ready', () => {
        const map = new FakeRainMap('radar-0', 'radar-1');
        const controller = new RainFrameTransitionController();
        const committed = vi.fn();
        map.setCommitted('radar-0');

        controller.request(map, 'radar-1', ['radar-0'], committed);

        expect(map.layout.get('radar-0')).toBe('visible');
        expect(map.opacity.get('radar-0')).toBe(0.75);
        expect(map.layout.get('radar-1')).toBe('visible');
        expect(map.opacity.get('radar-1')).toBe(0);
        expect(committed).not.toHaveBeenCalled();
        expect(controller.isTransitioning()).toBe(true);

        map.emitSourceData('radar-1', { tile: {}, isSourceLoaded: false });
        expect(committed).not.toHaveBeenCalled();
        expect(map.layout.get('radar-0')).toBe('visible');

        map.loadedSources.add('radar-1');
        // Mapbox emits this as it applies the visibility write, before it has
        // requested any of the newly unparked raster's tiles. A parked source
        // can still say "loaded" because it has no active requests yet.
        map.emitSourceData('radar-1', { sourceDataType: 'visibility', isSourceLoaded: true });
        expect(committed).not.toHaveBeenCalled();
        expect(map.opacity.get('radar-1')).toBe(0);
        expect(map.layout.get('radar-0')).toBe('visible');

        map.emitSourceData('radar-1', { sourceDataType: 'error', tile: {}, isSourceLoaded: true });
        expect(committed).not.toHaveBeenCalled();
        expect(map.layout.get('radar-0')).toBe('visible');

        map.emitSourceData('radar-1', { tile: {}, isSourceLoaded: true });

        expect(committed).toHaveBeenCalledOnce();
        expect(map.opacity.get('radar-1')).toBe(0.75);
        expect(map.opacity.get('radar-0')).toBe(0);
        expect(map.layout.get('radar-0')).toBe('visible');

        vi.advanceTimersByTime(RAIN_FRAME_FADE_MS);
        expect(map.layout.get('radar-0')).toBe('none');
        expect(map.layout.get('radar-1')).toBe('visible');
        expect(controller.isTransitioning()).toBe(false);
    });

    it('ignores a stale source callback when the scrubber moves again', () => {
        const map = new FakeRainMap('radar-0', 'radar-1', 'rainbow-fc-0');
        const controller = new RainFrameTransitionController();
        const committed = vi.fn();
        map.setCommitted('radar-0');

        controller.request(map, 'radar-1', ['radar-0'], () => committed('radar-1'));
        controller.request(map, 'rainbow-fc-0', ['radar-0'], () => committed('rainbow-fc-0'));

        expect(map.layout.get('radar-1')).toBe('none');
        expect(map.layout.get('radar-0')).toBe('visible');
        expect(map.layout.get('rainbow-fc-0')).toBe('visible');
        expect(map.opacity.get('rainbow-fc-0')).toBe(0);

        map.loadedSources.add('radar-1');
        map.emitSourceData('radar-1', { tile: {}, isSourceLoaded: true });
        expect(committed).not.toHaveBeenCalled();
        expect(map.layout.get('radar-0')).toBe('visible');

        map.loadedSources.add('rainbow-fc-0');
        map.emitSourceData('rainbow-fc-0', { tile: {}, isSourceLoaded: true });
        expect(committed).toHaveBeenCalledTimes(1);
        expect(committed).toHaveBeenLastCalledWith('rainbow-fc-0');
        expect(map.opacity.get('rainbow-fc-0')).toBe(0.75);
    });

    it('hands off a cached frame after the next render without waiting for sourcedata', () => {
        const map = new FakeRainMap('radar-0', 'radar-1');
        const controller = new RainFrameTransitionController();
        const committed = vi.fn();
        map.setCommitted('radar-0');
        map.loadedSources.add('radar-1');

        controller.request(map, 'radar-1', ['radar-0'], committed);
        map.emitRender();

        expect(committed).toHaveBeenCalledOnce();
        expect(map.opacity.get('radar-1')).toBe(0.75);
        expect(map.opacity.get('radar-0')).toBe(0);
    });

    it('keeps the newly committed frame when a further scrub interrupts its fade', () => {
        const map = new FakeRainMap('radar-0', 'radar-1', 'rainbow-fc-0');
        const controller = new RainFrameTransitionController();
        map.setCommitted('radar-0');

        controller.request(map, 'radar-1', ['radar-0'], vi.fn());
        map.loadedSources.add('radar-1');
        map.emitSourceData('radar-1', { tile: {}, isSourceLoaded: true });

        expect(map.opacity.get('radar-1')).toBe(0.75);
        expect(map.opacity.get('radar-0')).toBe(0);

        controller.request(map, 'rainbow-fc-0', ['radar-1'], vi.fn());

        expect(map.layout.get('radar-0')).toBe('none');
        expect(map.layout.get('radar-1')).toBe('visible');
        expect(map.opacity.get('radar-1')).toBe(0.75);
        expect(map.layout.get('rainbow-fc-0')).toBe('visible');
        expect(map.opacity.get('rainbow-fc-0')).toBe(0);
    });

    it('cancels an unloaded staged frame without blanking the committed frame', () => {
        const map = new FakeRainMap('radar-0', 'radar-1');
        const controller = new RainFrameTransitionController();
        map.setCommitted('radar-0');

        controller.request(map, 'radar-1', ['radar-0'], vi.fn());
        controller.cancel(map);

        expect(map.layout.get('radar-1')).toBe('none');
        expect(map.layout.get('radar-0')).toBe('visible');
        expect(map.opacity.get('radar-0')).toBe(0.75);
    });

    it('abandons a staged frame whose tiles never arrive so playback is not wedged', () => {
        // An expired RainViewer path 404s every tile: no commit event ever
        // fires, and before the stage deadline isTransitioning() stayed true
        // forever — permanently freezing autoplay's advance guard.
        const map = new FakeRainMap('radar-0', 'radar-1');
        const controller = new RainFrameTransitionController();
        const committed = vi.fn();
        map.setCommitted('radar-0');

        controller.request(map, 'radar-1', ['radar-0'], committed);
        expect(controller.isTransitioning()).toBe(true);

        vi.advanceTimersByTime(RAIN_FRAME_STAGE_DEADLINE_MS + 1);

        expect(controller.isTransitioning()).toBe(false);
        expect(committed).not.toHaveBeenCalled();
        expect(map.layout.get('radar-1')).toBe('none');
        expect(map.layout.get('radar-0')).toBe('visible');
        expect(map.opacity.get('radar-0')).toBe(0.75);
    });

    it('does not let the stage deadline fire after a successful handoff', () => {
        const map = new FakeRainMap('radar-0', 'radar-1');
        const controller = new RainFrameTransitionController();
        map.setCommitted('radar-0');
        map.loadedSources.add('radar-1');

        controller.request(map, 'radar-1', ['radar-0'], vi.fn());
        map.emitSourceData('radar-1', { tile: {}, isSourceLoaded: true });
        expect(map.layout.get('radar-1')).toBe('visible');

        vi.advanceTimersByTime(RAIN_FRAME_STAGE_DEADLINE_MS + RAIN_FRAME_FADE_MS + 1);

        expect(map.layout.get('radar-1')).toBe('visible');
        expect(map.opacity.get('radar-1')).toBe(0.75);
    });
});
