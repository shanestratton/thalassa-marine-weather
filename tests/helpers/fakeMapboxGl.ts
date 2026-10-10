/**
 * A stand-in for mapbox-gl in jsdom, for the Log page's Mapbox maps
 * (components/map/logMap.ts, components/LiveMiniMapGL.tsx and, since
 * 125-13b, components/TrackMapViewerGL.tsx with its popups). It keeps the
 * style's layers and sources in memory, as addReliefBase and the overlays
 * write them, so a test can read what would be drawn: which layers are
 * visible, which tile URLs any source asked for, and what each GeoJSON
 * source holds. Nothing here renders; the browser specs do that.
 */
import { vi } from 'vitest';

export interface FakeLayer {
    id: string;
    type: string;
    source?: string;
    'source-layer'?: string;
    minzoom?: number;
    maxzoom?: number;
    filter?: unknown;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
}

export interface FakeSource {
    spec: Record<string, unknown>;
    data?: unknown;
    setData: (data: unknown) => void;
}

/**
 * The parts of Mapbox dark-v11 the Log map touches: the land background and
 * fills setReliefPalette repaints, the water layer addReliefBase anchors on,
 * and the road, building and label clutter the base hides.
 */
export function darkV11LikeLayers(): FakeLayer[] {
    return [
        { id: 'land', type: 'background', paint: {} },
        { id: 'landuse', type: 'fill', source: 'composite', 'source-layer': 'landuse', paint: {} },
        { id: 'water', type: 'fill', source: 'composite', 'source-layer': 'water', paint: {} },
        { id: 'waterway', type: 'line', source: 'composite', 'source-layer': 'waterway', paint: {} },
        { id: 'land-structure-line', type: 'line', source: 'composite', 'source-layer': 'structure', paint: {} },
        { id: 'building', type: 'fill', source: 'composite', 'source-layer': 'building', paint: {} },
        { id: 'road-primary', type: 'line', source: 'composite', 'source-layer': 'road', paint: {} },
        { id: 'road-label', type: 'symbol', source: 'composite', 'source-layer': 'road', paint: {} },
        { id: 'poi-label', type: 'symbol', source: 'composite', 'source-layer': 'poi_label', paint: {} },
        { id: 'settlement-major-label', type: 'symbol', source: 'composite', 'source-layer': 'place_label' },
    ];
}

type Handler = (event?: unknown) => void;

function makeSource(spec: Record<string, unknown>): FakeSource {
    const source: FakeSource = {
        spec,
        data: spec.data,
        setData: vi.fn((data: unknown) => {
            source.data = data;
        }),
    };
    return source;
}

export class FakeMapboxMap {
    static instances: FakeMapboxMap[] = [];
    /** Every construction asked for, including those that threw. */
    static attempts = 0;
    /**
     * No WebGL context in this web view: the constructor throws as mapbox-gl
     * 3.19 does, after it has dressed the container.
     */
    static failWebGL = false;

    options: Record<string, unknown>;
    layers: FakeLayer[] = [];
    sources = new Map<string, FakeSource>();
    controls: Array<{ control: unknown; position?: string }> = [];
    handlers = new Map<string, Handler[]>();
    removed = false;
    styleSet: unknown[] = [];
    container: HTMLElement;
    canvasContainer: HTMLElement;
    touchZoomRotate?: { disableRotation: ReturnType<typeof vi.fn> };
    /** Mapbox's keyboard handler: Shift+left/right turns the map unless its rotation is disabled. */
    keyboard?: { disableRotation: ReturnType<typeof vi.fn> };
    bearing = 0;
    /**
     * What queryRenderedFeatures answers: the features a test says are drawn
     * under the point, each with its layer id (filtered by options.layers).
     */
    rendered: Array<{ layer: { id: string }; properties: Record<string, unknown>; geometry: unknown }> = [];
    fitBounds = vi.fn();
    jumpTo = vi.fn();
    resize = vi.fn();
    remove = vi.fn(() => {
        this.removed = true;
    });

    constructor(options: Record<string, unknown>) {
        FakeMapboxMap.attempts += 1;
        this.options = options;
        this.container = options.container as HTMLElement;
        this.container.classList.add('mapboxgl-map');
        this.canvasContainer = document.createElement('div');
        this.canvasContainer.className = 'mapboxgl-canvas-container';
        this.container.appendChild(this.canvasContainer);
        if (FakeMapboxMap.failWebGL) throw new Error('Failed to initialize WebGL.');
        // Mapbox builds the gesture handlers only for an interactive map.
        if (options.interactive !== false) {
            this.touchZoomRotate = { disableRotation: vi.fn() };
            this.keyboard = { disableRotation: vi.fn() };
        }
        FakeMapboxMap.instances.push(this);
    }

    on(type: string, handler: Handler) {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        return this;
    }

    once(type: string, handler: Handler) {
        const wrapped: Handler = (event) => {
            this.off(type, wrapped);
            handler(event);
        };
        return this.on(type, wrapped);
    }

    off(type: string, handler: Handler) {
        this.handlers.set(
            type,
            (this.handlers.get(type) ?? []).filter((h) => h !== handler),
        );
        return this;
    }

    fire(type: string, event: Record<string, unknown> = {}) {
        for (const handler of [...(this.handlers.get(type) ?? [])]) handler({ type, target: this, ...event });
    }

    /**
     * What mapbox does when the style arrives: its own sources and layers,
     * then style.load, then load. `layers` defaults to the dark-v11 shape.
     */
    loadStyle(layers: FakeLayer[] = darkV11LikeLayers(), { composite = true } = {}) {
        this.layers = layers.map((layer) => ({ ...layer, layout: { ...layer.layout }, paint: { ...layer.paint } }));
        this.sources = new Map();
        if (composite) this.sources.set('composite', makeSource({ type: 'vector' }));
        this.fire('style.load');
        this.fire('load');
    }

    setStyle(style: unknown) {
        this.styleSet.push(style);
    }

    getStyle() {
        return { layers: this.layers };
    }

    isStyleLoaded() {
        return this.layers.length > 0;
    }

    getSource(id: string) {
        return this.sources.get(id);
    }

    addSource(id: string, spec: Record<string, unknown>) {
        if (this.sources.has(id)) throw new Error(`There is already a source with ID "${id}".`);
        this.sources.set(id, makeSource(spec));
    }

    getLayer(id: string) {
        return this.layers.find((layer) => layer.id === id);
    }

    addLayer(layer: FakeLayer, before?: string) {
        if (this.getLayer(layer.id)) throw new Error(`Layer "${layer.id}" already exists.`);
        const copy = { ...layer, layout: { ...layer.layout }, paint: { ...layer.paint } };
        const at = before ? this.layers.findIndex((l) => l.id === before) : -1;
        if (at < 0) this.layers.push(copy);
        else this.layers.splice(at, 0, copy);
    }

    setLayoutProperty(id: string, property: string, value: unknown) {
        const layer = this.getLayer(id);
        if (!layer) throw new Error(`No layer "${id}".`);
        layer.layout = { ...layer.layout, [property]: value };
    }

    getLayoutProperty(id: string, property: string) {
        return this.getLayer(id)?.layout?.[property];
    }

    setPaintProperty(id: string, property: string, value: unknown) {
        const layer = this.getLayer(id);
        if (!layer) throw new Error(`No layer "${id}".`);
        layer.paint = { ...layer.paint, [property]: value };
    }

    addControl(control: unknown, position?: string) {
        this.controls.push({ control, position });
        return this;
    }

    getContainer() {
        return this.container;
    }

    getBearing() {
        return this.bearing;
    }

    getCanvasContainer() {
        return this.canvasContainer;
    }

    queryRenderedFeatures(_geometry?: unknown, options: { layers?: string[] } = {}) {
        return this.rendered.filter((feature) => !options.layers || options.layers.includes(feature.layer.id));
    }

    /** Every tile URL template any source in the style asked for. */
    tileUrls(): string[] {
        return [...this.sources.values()].flatMap((source) => (source.spec.tiles as string[] | undefined) ?? []);
    }

    /** A layer's visibility as mapbox reads it: unset means visible. */
    visibility(id: string): string | undefined {
        const layer = this.getLayer(id);
        if (!layer) return undefined;
        return (layer.layout?.visibility as string | undefined) ?? 'visible';
    }
}

export class FakeAttributionControl {
    constructor(public options?: Record<string, unknown>) {}
}

/**
 * mapboxgl.Popup as the track map uses it: placed, filled with DOM, added to
 * a map (its element joins the map's box), and 'close' on remove().
 */
export class FakePopup {
    static instances: FakePopup[] = [];
    options: Record<string, unknown>;
    lngLat: unknown = null;
    content: Node | null = null;
    html: string | null = null;
    map: FakeMapboxMap | null = null;
    removed = false;
    element = document.createElement('div');
    private handlers = new Map<string, Handler[]>();

    constructor(options: Record<string, unknown> = {}) {
        this.options = options;
        this.element.className = `mapboxgl-popup ${String(options.className ?? '')}`.trim();
        FakePopup.instances.push(this);
    }
    setLngLat(lngLat: unknown) {
        this.lngLat = lngLat;
        return this;
    }
    setDOMContent(node: Node) {
        this.content = node;
        this.element.replaceChildren(node);
        return this;
    }
    setHTML(html: string) {
        this.html = html;
        this.element.innerHTML = html;
        return this;
    }
    addTo(map: FakeMapboxMap) {
        this.map = map;
        map.getContainer().appendChild(this.element);
        return this;
    }
    isOpen() {
        return !!this.map && !this.removed;
    }
    getElement() {
        return this.element;
    }
    on(type: string, handler: Handler) {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        return this;
    }
    remove() {
        if (this.removed) return this;
        this.removed = true;
        this.element.remove();
        for (const handler of this.handlers.get('close') ?? []) handler({ type: 'close', target: this });
        return this;
    }
}

export const fakeMapboxGl = { Map: FakeMapboxMap, AttributionControl: FakeAttributionControl, Popup: FakePopup };

/**
 * A controllable IntersectionObserver (tests/setup.ts's never calls back).
 * Like a browser it reports once on observe(): on screen while
 * `visibleOnObserve` is true. show() moves every observed element.
 */
export class FakeIntersectionObserver {
    static all: FakeIntersectionObserver[] = [];
    static visibleOnObserve = true;
    elements: Element[] = [];
    constructor(private callback: IntersectionObserverCallback) {
        FakeIntersectionObserver.all.push(this);
    }
    observe(element: Element) {
        this.elements.push(element);
        this.report([element], FakeIntersectionObserver.visibleOnObserve);
    }
    unobserve() {}
    disconnect() {
        this.elements = [];
    }
    takeRecords() {
        return [];
    }
    private report(targets: Element[], ...crossings: boolean[]) {
        const entries = crossings.flatMap((visible) =>
            targets.map((target) => ({ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }) as never),
        );
        if (entries.length) this.callback(entries, this as never);
    }
    static show(visible: boolean) {
        for (const observer of FakeIntersectionObserver.all) observer.report(observer.elements, visible);
    }
    /**
     * Several crossings handed over in ONE callback, oldest first, as a busy
     * main thread delivers them (in, then out, during a fling).
     */
    static deliver(...crossings: boolean[]) {
        for (const observer of FakeIntersectionObserver.all) observer.report(observer.elements, ...crossings);
    }
    static reset() {
        FakeIntersectionObserver.all.length = 0;
        FakeIntersectionObserver.visibleOnObserve = true;
    }
}

/**
 * Swap it in for tests/setup.ts's (a plain writable window property, so not
 * vi.stubGlobal). Returns the restore.
 */
export function installFakeIntersectionObserver(): () => void {
    const original = window.IntersectionObserver;
    FakeIntersectionObserver.reset();
    window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    return () => {
        window.IntersectionObserver = original;
    };
}
