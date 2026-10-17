import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { LocalChartDisplay } from '../services/charts/localChartDisplay';

const notices = vi.hoisted(() => ({ persistentError: vi.fn(() => 1), dismiss: vi.fn() }));
vi.mock('../components/Toast', () => ({ toast: notices }));
const SOURCE = 'retained-local-chart-source',
    LAYER = 'retained-local-chart-layer';
class ChartMap {
    sources = new Map<string, object>();
    layers = new Map<string, mapboxgl.LayerSpecification | mapboxgl.CustomLayerInterface>();
    listeners = new Map<string, Set<(event: never) => void>>();
    element = document.createElement('div');
    failRemove = false;
    getContainer = () => this.element;
    getSource = (id: string) => this.sources.get(id);
    getLayer = (id: string) => this.layers.get(id);
    getStyle = () => ({ layers: [...this.layers.values()] });
    addSource = vi.fn((id: string, _source: unknown) => {
        this.sources.set(id, {});
    });
    addLayer = vi.fn((layer: mapboxgl.LayerSpecification) => {
        this.layers.set(layer.id, layer);
    });
    removeLayer = vi.fn((id: string) => {
        if (this.failRemove) throw new Error('Busy style');
        this.layers.delete(id);
    });
    removeSource = vi.fn((id: string) => {
        if (this.failRemove) throw new Error('Busy source');
        this.sources.delete(id);
    });
    on = (event: string, listener: (event: never) => void) => {
        const group = this.listeners.get(event) ?? new Set();
        group.add(listener);
        this.listeners.set(event, group);
    };
    off = (event: string, listener: (event: never) => void) => {
        this.listeners.get(event)?.delete(listener);
    };
    once = (event: string, listener: (event: never) => void) => {
        const wrapped = (value: never) => {
            this.off(event, wrapped);
            listener(value);
        };
        this.on(event, wrapped);
    };
    triggerRepaint = vi.fn();
    emit(event: string, value: unknown = {}) {
        for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value as never);
    }
}
async function setup() {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope('a');
    const { mountLocalChartPresentation } = await import('../components/map/localChartPresentation');
    const map = new ChartMap(),
        release = vi.fn(),
        status = vi.fn();
    let sourceLive = true;
    const display: LocalChartDisplay = {
        source: {
            type: 'image',
            url: 'blob:http://localhost/chart',
            coordinates: [
                [150, -26],
                [151, -26],
                [151, -27],
                [150, -27],
            ],
        },
        bounds: [150, -27, 151, -26],
        name: 'Private fictional chart',
        note: 'Own/open only. Display only.',
        isCurrent: () => sourceLive,
        release,
    };
    const mount = () => mountLocalChartPresentation(map as unknown as mapboxgl.Map, display, () => true, status);
    return {
        map,
        release,
        status,
        mount,
        identity,
        retireSource: () => {
            sourceLive = false;
        },
    };
}
beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
    vi.useRealTimers();
});
describe('local private raster presentation ownership', () => {
    it('refuses a foreign custom layer without reading absent metadata or removing it', async () => {
        const f = await setup();
        const custom: mapboxgl.CustomLayerInterface = { id: LAYER, type: 'custom', render() {} };
        f.map.layers.set(LAYER, custom);
        const owner = f.mount();
        expect(f.map.layers.get(LAYER)).toBe(custom);
        expect(f.map.removeLayer).not.toHaveBeenCalled();
        expect(f.status).toHaveBeenLastCalledWith('unavailable');
        expect(owner.done()).toBe(true);
    });
    it('keeps the privacy hold and honest warning if a foreign source appears before the clean retirement render', async () => {
        const f = await setup(),
            owner = f.mount();
        f.identity.setAuthIdentityScope('b');
        f.map.sources.set(SOURCE, {});
        f.map.emit('render');
        expect(f.map.element.style.visibility).toBe('hidden');
        expect(owner.done()).toBe(false);
        expect(f.status).toHaveBeenLastCalledWith('stuck-visible');
        expect(f.release).toHaveBeenCalledTimes(1);
        f.map.emit('remove');
        expect(owner.done()).toBe(true);
    });
    it('displays only an owned loaded source and releases once after confirmed retirement', async () => {
        const f = await setup(),
            owner = f.mount();
        expect(f.status).toHaveBeenLastCalledWith('loading');
        f.map.emit('sourcedata', { sourceId: SOURCE, isSourceLoaded: true });
        expect(f.status).toHaveBeenLastCalledWith('displayed');
        owner.retire();
        owner.retire();
        expect(owner.done()).toBe(true);
        expect(f.release).toHaveBeenCalledTimes(1);
        expect(f.map.sources.size).toBe(0);
        expect(f.map.layers.size).toBe(0);
    });
    it('does not adopt, update or remove an initial foreign source', async () => {
        const f = await setup();
        const foreign = {};
        f.map.sources.set(SOURCE, foreign);
        const owner = f.mount();
        expect(f.map.addSource).not.toHaveBeenCalled();
        expect(f.map.removeSource).not.toHaveBeenCalled();
        expect(f.map.getSource(SOURCE)).toBe(foreign);
        expect(f.status).toHaveBeenLastCalledWith('unavailable');
        expect(owner.done()).toBe(true);
        expect(f.release).toHaveBeenCalledOnce();
    });
    it('retains a URL when a foreign layer replaces the exact owned marker', async () => {
        const f = await setup(),
            owner = f.mount();
        f.map.layers.set(LAYER, { id: LAYER, type: 'raster', source: SOURCE });
        owner.retire();
        expect(owner.done()).toBe(false);
        expect(f.release).not.toHaveBeenCalled();
        expect(f.map.removeLayer).not.toHaveBeenCalled();
        expect(notices.persistentError).toHaveBeenCalledOnce();
        f.map.emit('remove');
        expect(f.release).toHaveBeenCalledOnce();
    });
    it('keeps a failed removal and URL until an actual lifecycle retry succeeds', async () => {
        const f = await setup(),
            owner = f.mount();
        f.map.failRemove = true;
        owner.retire();
        expect(owner.done()).toBe(false);
        expect(f.release).not.toHaveBeenCalled();
        expect(f.status).toHaveBeenLastCalledWith('stuck-visible');
        f.map.failRemove = false;
        f.map.emit('idle');
        expect(owner.done()).toBe(true);
        expect(f.release).toHaveBeenCalledOnce();
    });
    it('recreates its source after a real style reset and refuses a foreign replacement', async () => {
        const f = await setup(),
            owner = f.mount();
        const first = f.map.getSource(SOURCE);
        f.map.sources.clear();
        f.map.layers.clear();
        f.map.emit('style.load');
        expect(f.map.addSource).toHaveBeenCalledTimes(2);
        expect(f.map.getSource(SOURCE)).not.toBe(first);
        const foreign = {};
        f.map.sources.set(SOURCE, foreign);
        f.map.emit('style.load');
        expect(f.map.getSource(SOURCE)).toBe(foreign);
        expect(owner.done()).toBe(false);
        expect(f.map.removeSource).not.toHaveBeenCalled();
        f.map.emit('remove');
    });
    it('hides the old account’s rendered pixels synchronously through A/B/A until a clean render', async () => {
        const f = await setup(),
            owner = f.mount();
        f.identity.setAuthIdentityScope('b');
        f.identity.setAuthIdentityScope('a');
        expect(f.map.element.style.visibility).toBe('hidden');
        expect(f.map.triggerRepaint).toHaveBeenCalled();
        expect(owner.done()).toBe(false);
        expect(f.release).toHaveBeenCalledOnce();
        f.map.emit('render');
        expect(f.map.element.style.visibility).toBe('');
        expect(owner.done()).toBe(true);
    });
    it('keeps the map hidden across an account switch when private-source removal fails', async () => {
        const f = await setup(),
            owner = f.mount();
        f.map.failRemove = true;
        f.identity.setAuthIdentityScope('b');
        f.map.emit('render');
        expect(f.map.element.style.visibility).toBe('hidden');
        expect(f.release).not.toHaveBeenCalled();
        f.map.failRemove = false;
        f.map.emit('idle');
        expect(f.map.element.style.visibility).toBe('hidden');
        expect(owner.done()).toBe(false);
        f.map.emit('render');
        expect(f.map.element.style.visibility).toBe('');
        expect(owner.done()).toBe(true);
    });
    it('retires an invalidated retained-file proof without another file read', async () => {
        const f = await setup(),
            owner = f.mount();
        f.retireSource();
        owner.verify();
        expect(owner.done()).toBe(true);
        expect(f.map.getSource(SOURCE)).toBeUndefined();
        expect(f.release).toHaveBeenCalledOnce();
    });
    it('refuses late or absent source readiness at the unchanged 10-second presentation deadline', async () => {
        const f = await setup();
        f.mount();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.status).toHaveBeenLastCalledWith('unavailable');
        expect(f.release).toHaveBeenCalledOnce();
        f.map.emit('sourcedata', { sourceId: SOURCE, isSourceLoaded: true });
        expect(f.status).toHaveBeenLastCalledWith('unavailable');
    });
});
