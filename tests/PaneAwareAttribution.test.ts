import { beforeEach, describe, expect, it } from 'vitest';
import mapboxgl from 'mapbox-gl';
import { installPaneAwareAttribution } from '../components/map/paneAwareAttribution';

// Use the installed Mapbox AttributionControl itself (no WebGL/network map).
// The test double supplies only its map event/source boundary, so the toggle,
// source credit updates and accessible native button are real vendor code.
function chart(width: number, split = false, height = 0) {
    const pane = document.createElement('section');
    if (split) pane.dataset.splitPane = 'chart';
    const container = document.createElement('div');
    pane.append(container);
    document.body.append(pane);
    let currentWidth = width;
    // jsdom lays nothing out, so an unmeasured map reports 0 tall — the same
    // as a real container before its first layout.
    let currentHeight = height;
    Object.defineProperty(container, 'clientWidth', { get: () => currentWidth });
    Object.defineProperty(container, 'offsetWidth', { get: () => currentWidth });
    Object.defineProperty(container, 'clientHeight', { get: () => currentHeight });
    Object.defineProperty(container, 'offsetHeight', { get: () => currentHeight });
    const listeners = new Map<string, Set<(event?: object) => void>>();
    const controls: mapboxgl.AttributionControl[] = [];
    const style = {
        stylesheet: {},
        _mergedSourceCaches: {
            basemap: {
                used: true,
                getSource: () => ({
                    attribution:
                        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> | <a href="https://www.mapbox.com/about/maps/">© Mapbox</a>',
                }),
            },
        },
    };
    const mapBoundary = {
        style,
        _requestManager: {},
        _getUIString: () => 'Toggle attribution',
        getCanvasContainer: () => container,
        on: (event: string, handler: (event?: object) => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(handler);
        },
        off: (event: string, handler: (event?: object) => void) => listeners.get(event)?.delete(handler),
        addControl: (control: mapboxgl.AttributionControl) => {
            controls.push(control);
            container.append(control.onAdd(mapBoundary as unknown as mapboxgl.Map));
        },
        removeControl: (control: mapboxgl.AttributionControl) => {
            controls.splice(controls.indexOf(control), 1);
            control.onRemove();
        },
    };
    const refresh = installPaneAwareAttribution(mapBoundary as unknown as mapboxgl.Map, container);
    const emit = (event: string, data?: object) => {
        for (const handler of [...(listeners.get(event) ?? [])]) handler(data);
    };
    return {
        pane,
        container,
        controls,
        listeners,
        style,
        refresh,
        emit,
        resize: (value: number) => {
            currentWidth = value;
            refresh();
            emit('resize');
        },
        /** Turn the device: both sides change in one layout pass. */
        rotate: (nextWidth: number, nextHeight: number) => {
            currentWidth = nextWidth;
            currentHeight = nextHeight;
            refresh();
            emit('resize');
        },
    };
}

beforeEach(() => document.body.replaceChildren());

describe('pane-aware native map attribution', () => {
    it('collapses a 700px iPad split map even though the native 640px cutoff misses it', () => {
        const map = chart(700, true);
        expect(map.controls).toHaveLength(1);
        expect(map.controls[0].options.compact).toBe(true);
        const credits = map.container.querySelector('.mapboxgl-ctrl-attrib')!;
        expect(credits).toHaveClass('mapboxgl-compact');
        const toggle = map.container.querySelector('button')!;
        expect(toggle).toHaveAccessibleName('Toggle attribution');
        toggle.click();
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(credits).toHaveClass('mapboxgl-compact-show');
        expect(map.container.querySelector('a[href="https://www.openstreetmap.org/copyright"]')).toHaveTextContent(
            'OpenStreetMap contributors',
        );
        expect(map.container.querySelector('a[href="https://www.mapbox.com/about/maps/"]')).toHaveTextContent('Mapbox');
        toggle.click();
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('uses the actual map width for a narrow map on a wide browser', () => {
        const map = chart(390);
        expect(map.controls[0].options.compact).toBe(true);
        // The chart names the layout for its own bottom-left controls' CSS:
        // the full strip is always shown and runs left under them.
        expect(map.container.dataset.attributionLayout).toBe('compact');
        map.resize(1100);
        expect(map.controls).toHaveLength(1);
        expect(map.controls[0].options.compact).toBeUndefined();
        expect(map.container.querySelector('.mapboxgl-ctrl-attrib')).not.toHaveClass('mapboxgl-compact');
        expect(map.container.dataset.attributionLayout).toBe('strip');
        map.resize(600);
        expect(map.controls[0].options.compact).toBe(true);
        expect(map.container.querySelectorAll('.mapboxgl-ctrl-attrib')).toHaveLength(1);
        expect(map.container.dataset.attributionLayout).toBe('compact');
    });

    it('restores responsive full credits after leaving split view without listener accumulation', () => {
        const map = chart(720, true);
        const initial = map.controls[0];
        map.refresh();
        expect(map.controls[0]).toBe(initial);
        delete map.pane.dataset.splitPane;
        map.resize(1100);
        expect(map.controls[0].options.compact).toBeUndefined();
        map.pane.dataset.splitPane = 'page';
        map.resize(720);
        expect(map.controls[0].options.compact).toBe(true);
        expect(map.listeners.get('sourcedata')?.size).toBe(1);
        expect(map.listeners.get('styledata')?.size).toBe(1);
    });

    it('also compacts the chart beside its built-in helm passage pane', () => {
        const map = chart(750);
        map.container.dataset.mapPane = 'split';
        map.refresh();
        expect(map.controls[0].options.compact).toBe(true);
    });

    it('continues showing the credits of the currently used source in compact mode', () => {
        const map = chart(700, true);
        map.style._mergedSourceCaches.basemap.getSource = () => ({
            attribution: '<a href="https://www.gebco.net/">GEBCO 2026 Grid</a> | © OpenStreetMap contributors',
        });
        map.emit('sourcedata', { dataType: 'source', sourceDataType: 'metadata' });
        map.container.querySelector('button')!.click();
        expect(map.container.querySelector('a[href="https://www.gebco.net/"]')).toHaveTextContent('GEBCO');
        expect(map.container.querySelector('.mapboxgl-ctrl-attrib-inner')).toHaveTextContent(
            'OpenStreetMap contributors',
        );
    });

    it('keeps the credits behind the ⓘ on a phone in landscape, exactly as in portrait', () => {
        // 852 x 393 is wider than Mapbox's own 640 px cutoff, so it used to
        // print the full strip (twice '© Mapbox') across the chart.
        const map = chart(852, false, 393);
        expect(map.controls).toHaveLength(1);
        expect(map.controls[0].options.compact).toBe(true);
        const credits = map.container.querySelector('.mapboxgl-ctrl-attrib')!;
        expect(credits).toHaveClass('mapboxgl-compact');
        const toggle = map.container.querySelector('button')!;
        expect(toggle).toHaveAccessibleName('Toggle attribution');
        toggle.click();
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(credits).toHaveClass('mapboxgl-compact-show');
        expect(map.container.querySelector('a[href="https://www.openstreetmap.org/copyright"]')).toHaveTextContent(
            'OpenStreetMap contributors',
        );
        expect(map.container.querySelector('a[href="https://www.mapbox.com/about/maps/"]')).toHaveTextContent('Mapbox');
    });

    it('stays compact through a portrait-to-landscape turn without swapping the control', () => {
        const map = chart(393, false, 852);
        const portrait = map.controls[0];
        expect(portrait.options.compact).toBe(true);
        map.rotate(852, 393);
        expect(map.controls).toHaveLength(1);
        expect(map.controls[0]).toBe(portrait);
        expect(map.container.querySelectorAll('.mapboxgl-ctrl-attrib')).toHaveLength(1);
        expect(map.listeners.get('sourcedata')?.size).toBe(1);
    });

    it('gives an iPad on its side, or a roomy window, the full credit line', () => {
        const ipad = chart(1024, false, 768);
        expect(ipad.controls[0].options.compact).toBeUndefined();
        expect(ipad.container.querySelector('.mapboxgl-ctrl-attrib')).not.toHaveClass('mapboxgl-compact');

        // A phone that turns back from landscape into a tall window returns to
        // Mapbox's responsive default, with one control and no leftovers.
        const phone = chart(852, false, 393);
        expect(phone.controls[0].options.compact).toBe(true);
        phone.rotate(1100, 800);
        expect(phone.controls).toHaveLength(1);
        expect(phone.controls[0].options.compact).toBeUndefined();
        expect(phone.container.querySelectorAll('.mapboxgl-ctrl-attrib')).toHaveLength(1);
    });

    it('does not force collapse on a genuinely roomy desktop split pane', () => {
        const map = chart(1200, true);
        expect(map.controls[0].options.compact).toBeUndefined();
        expect(map.container.querySelector('.mapboxgl-ctrl-attrib')).not.toHaveClass('mapboxgl-compact');
    });
});
