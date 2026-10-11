/**
 * OceanMap — the Thalassa Ocean chart table: our Relief sea (GEBCO + GA GBR
 * 30 m, components/map/reliefBase.ts) inside Mapbox dark-v11, on a globe.
 *
 * Loaded lazily (React.lazy in OceanPage), so mapbox-gl and its CSS arrive as
 * the shared vendor-mapbox chunk only once the page has painted.
 *
 * Layers, bottom to top, all under the place labels:
 *  - historical public records (OBIS): a muted pale heatmap to z9, faint
 *    outlined squares from z6.5, and an invisible hit layer for the tooltip;
 *  - the fleet's 0.1° area counts of threatened species (only where at
 *    least 3 boats logged them), as ~11 km discs at every zoom;
 *  - the fleet's other 0.1° cells (to z8) as glowing dots sized by sightings;
 *  - the fleet's public rows (from z8), each with its uncertainty disc. In a
 *    busy area whose rows do not all fit, the cells stay instead, and a note
 *    says so, so zooming in never makes sightings vanish.
 * Nothing covers the Mapbox wordmark or the attribution, which carries the
 * relief and OpenStreetMap credits.
 *
 * SIZE: the map is built only once its box has its laid-out size, and a
 * ResizeObserver keeps it fitted afterwards (Safari can run the module before
 * the page's stylesheet applies; mapbox-gl only follows window resizes).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { addReliefBase, hideBaseClutter, seaBaseLayers, setReliefPalette } from '../../components/map/reliefBase';
import { fetchRowsAll, type ContextFile, type FleetCell, type FleetRow, type Group } from './oceanApi';
import {
    boxKey,
    contextFilter,
    contextGeoJson,
    contextSquaresGeoJson,
    contextWeight,
    fleetCellsGeoJson,
    fleetFilter,
    fleetRowsGeoJson,
    groundRadius,
    placeTip,
    regionBounds,
    rowBoxes,
    visibleTimeout,
} from './mapLayers';
import type { Region } from './regions';
import { GROUPS, groupMeta } from './species';
import { MONTHS_FULL, fmt, precision, when, yearsLabel } from './format';

export interface OceanMapProps {
    token: string;
    cells: readonly FleetCell[];
    /** Fetch public rows at close zoom (only when the fleet has any). */
    rowsEnabled: boolean;
    names: ReadonlyMap<string, string>;
    context: ContextFile | null;
    groups: readonly Group[];
    month: number;
    contextOn: boolean;
    region: Region;
    /** Bumped on every region chip press, so pressing the same chip flies again. */
    flyNonce: number;
    reducedMotion: boolean;
    onFailed: () => void;
    onUserMove: () => void;
}

interface Tip {
    x: number;
    y: number;
    /** Prefer the pointer's left, or below it, near the right or top edge. */
    left: boolean;
    below: boolean;
    pinned: boolean;
    title: string;
    lines: string[];
    credit?: string | null;
    fleet: boolean;
}

const ROWS_MIN_ZOOM = 8;
const ROWS_CACHE = 20;
/** Counted as VISIBLE time only (visibleTimeout), so a background tab never trips it. */
const LOAD_TIMEOUT_MS = 25_000;
const FLEET_LAYERS = ['oc-fleet-rows', 'oc-fleet-dot', 'oc-fleet-coarse'];
const FINE_CELL_LAYERS = ['oc-fleet-glow', 'oc-fleet-dot'];
const ROW_LAYERS = ['oc-fleet-rows-ring', 'oc-fleet-rows'];
const CTX_LAYERS = ['oc-ctx-heat', 'oc-ctx-cells', 'oc-ctx-edges', 'oc-ctx-hit'];
const CTX_HOVER = ['oc-ctx-hit', 'oc-ctx-cells'];
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const colourByGroup = (): unknown[] => ['match', ['get', 'g'], ...GROUPS.flatMap((g) => [g.id, g.colour]), '#cbd5e1'];

/** Test hooks (rendered-feature counts) only under automation or ?debug: they cost a full-viewport query per idle. */
const DEBUG_COUNTS =
    typeof navigator !== 'undefined' &&
    (navigator.webdriver === true || new URLSearchParams(window.location.search).has('debug'));

function addOceanLayers(map: mapboxgl.Map) {
    const before = map.getStyle()?.layers?.find((l) => l.type === 'symbol')?.id;
    const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
    for (const id of ['oc-ctx', 'oc-ctx-squares', 'oc-cells', 'oc-rows']) {
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
    }
    const colour = colourByGroup();
    const layers: Array<Record<string, unknown>> = [
        {
            id: 'oc-ctx-heat',
            type: 'heatmap',
            source: 'oc-ctx',
            maxzoom: 9,
            paint: {
                'heatmap-weight': contextWeight(0),
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 2, 3, 2.6, 6, 3, 9, 3.5],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 6, 3, 14, 5, 20, 7, 30, 9, 44],
                'heatmap-color': [
                    'interpolate',
                    ['linear'],
                    ['heatmap-density'],
                    // A neutral chalk mist: muted, and unlike any blue of the sea.
                    0,
                    'rgba(226,232,240,0)',
                    0.04,
                    'rgba(226,232,240,0.35)',
                    0.2,
                    'rgba(232,237,244,0.62)',
                    0.5,
                    'rgba(240,244,248,0.85)',
                    1,
                    'rgba(252,253,254,1)',
                ],
                'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 7, 0.45, 9, 0],
            },
        },
        {
            // Close in, a record cell is drawn as the square it is: mostly
            // outline, because many species' squares stack on one bay.
            id: 'oc-ctx-cells',
            type: 'fill',
            source: 'oc-ctx-squares',
            minzoom: 6.5,
            paint: {
                'fill-color': 'rgba(226,232,240,1)',
                'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6.5, 0, 7.5, 0.045, 9, 0.02],
            },
        },
        {
            id: 'oc-ctx-edges',
            type: 'line',
            source: 'oc-ctx-squares',
            minzoom: 6.5,
            paint: {
                'line-color': 'rgba(226,232,240,0.45)',
                'line-width': 0.8,
                'line-opacity': ['interpolate', ['linear'], ['zoom'], 6.5, 0, 8, 1],
            },
        },
        {
            // Invisible: what the pointer hits, so the heatmap can say what it is.
            id: 'oc-ctx-hit',
            type: 'circle',
            source: 'oc-ctx',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 5, 8, 9, 16],
                'circle-opacity': 0,
            },
        },
        {
            // Threatened species' area counts: never rows, so at every zoom.
            id: 'oc-fleet-coarse',
            type: 'circle',
            source: 'oc-cells',
            paint: {
                'circle-radius': groundRadius('r0', 5),
                'circle-color': colour,
                'circle-opacity': 0.26,
                'circle-blur': 0.55,
                'circle-stroke-color': colour,
                'circle-stroke-opacity': 0.55,
                'circle-stroke-width': 1,
                'circle-pitch-alignment': 'map',
            },
        },
        {
            id: 'oc-fleet-glow',
            type: 'circle',
            source: 'oc-cells',
            maxzoom: ROWS_MIN_ZOOM,
            paint: {
                'circle-radius': ['+', 10, ['*', 5, ['sqrt', ['get', 'n']]]],
                'circle-color': colour,
                'circle-opacity': 0.6,
                'circle-blur': 0.9,
            },
        },
        {
            id: 'oc-fleet-dot',
            type: 'circle',
            source: 'oc-cells',
            maxzoom: ROWS_MIN_ZOOM,
            paint: {
                'circle-radius': ['+', 3, ['*', 1.6, ['sqrt', ['get', 'n']]]],
                'circle-color': colour,
                'circle-stroke-color': 'rgba(255,255,255,0.9)',
                'circle-stroke-width': 1.2,
            },
        },
        {
            id: 'oc-fleet-rows-ring',
            type: 'circle',
            source: 'oc-rows',
            minzoom: ROWS_MIN_ZOOM,
            paint: {
                'circle-radius': groundRadius('r0', 6),
                'circle-color': colour,
                'circle-opacity': 0.12,
                'circle-stroke-color': colour,
                'circle-stroke-opacity': 0.7,
                'circle-stroke-width': 1,
                'circle-pitch-alignment': 'map',
            },
        },
        {
            id: 'oc-fleet-rows',
            type: 'circle',
            source: 'oc-rows',
            minzoom: ROWS_MIN_ZOOM,
            paint: {
                'circle-radius': 5,
                'circle-color': colour,
                'circle-stroke-color': '#04131f',
                'circle-stroke-width': 1.2,
            },
        },
    ];
    for (const layer of layers) {
        if (!map.getLayer(layer.id as string)) map.addLayer(layer as unknown as mapboxgl.AnyLayer, before);
    }
}

const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

function tipFor(
    feature: mapboxgl.MapboxGeoJSONFeature,
    names: ReadonlyMap<string, string>,
    month: number,
): Omit<Tip, 'x' | 'y' | 'left' | 'below' | 'pinned'> {
    const p = (feature.properties ?? {}) as Record<string, unknown>;
    const group = groupMeta(String(p.g) as Group);
    const sci = typeof p.sci === 'string' && p.sci ? p.sci : null;
    if (CTX_HOVER.includes(feature.layer?.id ?? '')) {
        const days = Number(month ? p[`m${month}`] : p.d) || 0;
        const span = yearsLabel(Number.isFinite(Number(p.y0)) && p.y0 !== null ? [Number(p.y0), Number(p.y1)] : null);
        return {
            title: String(p.name ?? sci ?? group.one),
            lines: [
                `Recorded on ${plural(days, 'day')} here${month ? ` in ${MONTHS_FULL[month - 1]}` : ''}`,
                // The span is the species', not this cell's.
                `Historical public records (OBIS)${span ? `; the species’ records span ${span}` : ''}`,
            ],
            fleet: false,
        };
    }
    const name = String(p.name ?? (sci ? (names.get(sci) ?? sci) : group.one));
    const generalised = p.gen === true;
    if (feature.layer?.id === 'oc-fleet-rows') {
        const count = Number(p.n) || 1;
        const credit = typeof p.credit === 'string' && HANDLE.test(p.credit) ? p.credit : null;
        return {
            title: name,
            lines: [
                `${plural(count, 'animal')}${p.calf === true ? ', with calf' : ''}`,
                `${when(String(p.t))} · ${precision(Number(p.u) || 0, false)}`,
            ],
            credit,
            fleet: true,
        };
    }
    const n = Number(p.n) || 0;
    const m = Number(p.m) || 0;
    return {
        title: name,
        lines: [
            `${plural(n, 'sighting')} · ${plural(Number(p.a) || 0, 'animal')}`,
            `${m ? `${MONTHS_FULL[m - 1]} ${p.y}` : ''} · ${generalised ? 'in this 10 km square, from at least 3 boats' : 'in this 10 km square'}`,
        ],
        fleet: true,
    };
}

function fitRegion(map: mapboxgl.Map, region: Region, duration: number) {
    if (region.id === 'world') map.easeTo({ center: [150, -20], zoom: 1.3, duration });
    else map.fitBounds(regionBounds(region.bbox), { padding: 32, duration });
}

export default function OceanMap(props: OceanMapProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = useState(false);
    const [tip, setTip] = useState<Tip | null>(null);
    const [busy, setBusy] = useState(false);
    const live = useRef(props);
    live.current = props;
    const userMoved = useRef(false);
    const rowsCache = useRef(new Map<string, { rows: FleetRow[]; complete: boolean }>());

    // Create the map once its box has its real size.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        let map: mapboxgl.Map | null = null;
        let loaded = false;
        let cancelled = false;
        let waitTimer = 0;
        let stopTimeout = () => {};
        let observer: ResizeObserver | null = null;
        const fail = (why: unknown) => {
            if (loaded || cancelled) return;
            console.warn('[ocean] the map could not load:', why instanceof Error ? why.message : why);
            live.current.onFailed();
        };
        const laidOut = () => el.clientHeight > 0 && window.getComputedStyle(el).position === 'absolute';
        const start = () => {
            try {
                map = new mapboxgl.Map({
                    container: el,
                    accessToken: live.current.token,
                    style: 'mapbox://styles/mapbox/dark-v11',
                    projection: 'globe',
                    bounds: regionBounds(live.current.region.bbox),
                    fitBoundsOptions: { padding: 24 },
                    attributionControl: false,
                    cooperativeGestures: true,
                    dragRotate: false,
                    pitchWithRotate: false,
                    touchPitch: false,
                    maxPitch: 0,
                });
            } catch (error) {
                fail(error);
                return;
            }
            const m = map;
            mapRef.current = m;
            m.touchZoomRotate.disableRotation();
            m.keyboard.disableRotation();
            m.addControl(new mapboxgl.AttributionControl({ compact: true }));
            m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
            stopTimeout = visibleTimeout(LOAD_TIMEOUT_MS, () => fail('timed out'));
            m.on('error', (event) => {
                // Tile failures name their source and leave the vector sea showing;
                // only a style-level failure before load means there is no map.
                const { sourceId, error } = event as { sourceId?: string; error?: unknown };
                if (!sourceId) fail(error ?? 'style error');
            });
            m.on('style.load', () => {
                m.setFog({
                    color: '#081420',
                    'high-color': '#0e2840',
                    'horizon-blend': 0.06,
                    'space-color': '#040d17',
                    'star-intensity': 0.12,
                });
                addReliefBase(m);
                for (const [id, visible] of seaBaseLayers('relief')) {
                    if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
                }
                setReliefPalette(m, 'day');
                hideBaseClutter(m);
                addOceanLayers(m);
            });
            m.on('load', () => {
                loaded = true;
                stopTimeout();
                el.dataset.mapState = 'ready';
                setReady(true);
            });
            if (DEBUG_COUNTS) {
                m.on('idle', () => {
                    const count = (layers: string[]) =>
                        m.queryRenderedFeatures({ layers: layers.filter((id) => m.getLayer(id)) }).length;
                    el.dataset.ctxRendered = String(count(['oc-ctx-hit']));
                    el.dataset.fleetRendered = String(count(FLEET_LAYERS));
                });
            }
            const userMove = (event: object) => {
                if ((event as { originalEvent?: unknown }).originalEvent) {
                    userMoved.current = true;
                    live.current.onUserMove();
                }
            };
            m.on('dragstart', userMove);
            m.on('zoomstart', userMove);
            // Keep the canvas the size of its box, and refit the chosen
            // region while the visitor has not moved the map themselves.
            let fitted = { w: el.clientWidth, h: el.clientHeight };
            if (typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(() => {
                    const w = el.clientWidth;
                    const h = el.clientHeight;
                    if (w === 0 || h === 0) return;
                    m.resize();
                    if (!userMoved.current && (Math.abs(w - fitted.w) > 2 || Math.abs(h - fitted.h) > 2)) {
                        fitRegion(m, live.current.region, 0);
                    }
                    fitted = { w, h };
                });
                observer.observe(el);
            }
        };
        let tries = 0;
        const wait = () => {
            if (cancelled) return;
            // Up to 3 s for the stylesheet; then build anyway, and the
            // observer fixes the size when it lands.
            if (laidOut() || tries >= 60) start();
            else {
                tries += 1;
                waitTimer = window.setTimeout(wait, 50);
            }
        };
        wait();
        return () => {
            cancelled = true;
            window.clearTimeout(waitTimer);
            stopTimeout();
            observer?.disconnect();
            mapRef.current = null;
            map?.remove();
        };
    }, []);

    // Data.
    useEffect(() => {
        const source = mapRef.current?.getSource('oc-cells') as mapboxgl.GeoJSONSource | undefined;
        source?.setData(fleetCellsGeoJson(props.cells) as GeoJSON.FeatureCollection);
    }, [ready, props.cells]);
    useEffect(() => {
        const map = mapRef.current;
        (map?.getSource('oc-ctx') as mapboxgl.GeoJSONSource | undefined)?.setData(
            contextGeoJson(props.context) as GeoJSON.FeatureCollection,
        );
        (map?.getSource('oc-ctx-squares') as mapboxgl.GeoJSONSource | undefined)?.setData(
            contextSquaresGeoJson(props.context) as GeoJSON.FeatureCollection,
        );
    }, [ready, props.context]);

    // Filters, month and the context switch.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !ready) return;
        const fleet = fleetFilter(props.groups, props.month);
        const set = (id: string, filter: unknown[]) =>
            map.getLayer(id) && map.setFilter(id, filter as mapboxgl.FilterSpecification);
        set('oc-fleet-coarse', ['all', ['==', ['get', 'gen'], true], ...fleet.slice(1)]);
        set('oc-fleet-glow', ['all', ['==', ['get', 'gen'], false], ...fleet.slice(1)]);
        set('oc-fleet-dot', ['all', ['==', ['get', 'gen'], false], ...fleet.slice(1)]);
        set('oc-fleet-rows', fleet);
        set('oc-fleet-rows-ring', fleet);
        const ctx = contextFilter(props.groups, props.month);
        for (const id of CTX_LAYERS) {
            set(id, ctx);
            map.setLayoutProperty(id, 'visibility', props.contextOn ? 'visible' : 'none');
        }
        map.setPaintProperty(
            'oc-ctx-heat',
            'heatmap-weight',
            contextWeight(props.month) as mapboxgl.ExpressionSpecification,
        );
        setTip(null);
    }, [ready, props.groups, props.month, props.contextOn]);

    // Region fly-to.
    const firstFly = useRef(true);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !ready) return;
        if (firstFly.current) {
            firstFly.current = false;
            return;
        }
        userMoved.current = false;
        fitRegion(map, props.region, props.reducedMotion ? 0 : 1200);
    }, [ready, props.region, props.flyNonce, props.reducedMotion]);

    // Public rows at close zoom: whole-degree boxes, split at the dateline,
    // paged, cached. A box with more rows than the page cap keeps its cells.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !ready || !props.rowsEnabled) return;
        let timer = 0;
        let cancelled = false;
        const mode = (complete: boolean) => {
            for (const id of FINE_CELL_LAYERS) {
                if (map.getLayer(id)) map.setLayerZoomRange(id, 0, complete ? ROWS_MIN_ZOOM : 24);
            }
            for (const id of ROW_LAYERS) {
                if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', complete ? 'visible' : 'none');
            }
            setBusy(!complete);
        };
        const load = async () => {
            if (map.getZoom() < ROWS_MIN_ZOOM) {
                setBusy(false);
                return;
            }
            const b = map.getBounds();
            if (!b) return;
            const boxes = rowBoxes(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
            const cache = rowsCache.current;
            await Promise.all(
                boxes
                    .filter((box) => !cache.has(boxKey(box)))
                    .map(async (box) => {
                        const got = await fetchRowsAll(box);
                        if (!got) return;
                        cache.set(boxKey(box), got);
                        while (cache.size > ROWS_CACHE) cache.delete(cache.keys().next().value as string);
                    }),
            );
            if (cancelled) return;
            const entries = boxes.map((box) => cache.get(boxKey(box)));
            const complete = entries.every((e) => e?.complete === true);
            const seen = new Set<string>();
            const rows = entries.flatMap((e) => e?.rows ?? []).filter((r) => !seen.has(r.id) && seen.add(r.id));
            (map.getSource('oc-rows') as mapboxgl.GeoJSONSource | undefined)?.setData(
                fleetRowsGeoJson(complete ? rows : []) as GeoJSON.FeatureCollection,
            );
            mode(complete);
        };
        const onMove = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(load, 400);
        };
        map.on('moveend', onMove);
        onMove();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            map.off('moveend', onMove);
        };
    }, [ready, props.rowsEnabled]);

    // Tooltips: hover on a mouse, tap to pin (and reach the boat link) anywhere.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !ready) return;
        const pick = (point: mapboxgl.Point) => {
            const layers = [...FLEET_LAYERS, ...CTX_HOVER].filter((id) => map.getLayer(id));
            const box: [mapboxgl.PointLike, mapboxgl.PointLike] = [
                [point.x - 6, point.y - 6],
                [point.x + 6, point.y + 6],
            ];
            const hits = map.queryRenderedFeatures(box, { layers });
            return hits.find((f) => !CTX_HOVER.includes(f.layer?.id ?? '')) ?? hits[0] ?? null;
        };
        const show = (event: mapboxgl.MapMouseEvent, pinned: boolean) => {
            const feature = pick(event.point);
            const { names, month } = live.current;
            setTip((current) => {
                if (!feature) return current?.pinned && !pinned ? current : null;
                if (current?.pinned && !pinned) return current;
                const { x, y } = event.point;
                const left = x > map.getContainer().clientWidth * 0.55;
                return { x, y, left, below: y < 130, pinned, ...tipFor(feature, names, month) };
            });
            map.getCanvas().style.cursor = feature ? 'pointer' : '';
        };
        const onMove = (event: mapboxgl.MapMouseEvent) => show(event, false);
        const onClick = (event: mapboxgl.MapMouseEvent) => show(event, true);
        const onLeave = () => setTip((current) => (current?.pinned ? current : null));
        const fine = window.matchMedia?.('(hover: hover)').matches ?? true;
        if (fine) map.on('mousemove', onMove);
        map.on('click', onClick);
        map.on('mouseout', onLeave);
        return () => {
            map.off('mousemove', onMove);
            map.off('click', onClick);
            map.off('mouseout', onLeave);
        };
    }, [ready]);

    // Place the tip inside the map, measured, before it paints.
    useLayoutEffect(() => {
        const el = tipRef.current;
        const box = wrapRef.current;
        if (!el || !box || !tip) return;
        const at = placeTip(
            tip,
            { w: el.offsetWidth, h: el.offsetHeight },
            { w: box.clientWidth, h: box.clientHeight },
        );
        el.style.left = `${at.x}px`;
        el.style.top = `${at.y}px`;
        el.style.visibility = 'visible';
    }, [tip]);

    return (
        <>
            <div ref={wrapRef} className="oc-map" data-map-state="loading" />
            {busy && (
                <div className="oc-map-note" role="status">
                    Busy area: shown as 10 km counts
                </div>
            )}
            {tip && (
                <div
                    ref={tipRef}
                    className={`oc-tip${tip.pinned ? ' is-pinned' : ''}`}
                    style={{ left: 0, top: 0, visibility: 'hidden' }}
                    role={tip.pinned ? 'dialog' : 'tooltip'}
                    aria-label={tip.title}
                >
                    <b>{tip.title}</b>
                    {tip.lines.map((line) => (
                        <span key={line}>{line}</span>
                    ))}
                    {tip.fleet &&
                        (tip.credit ? (
                            <a href={`https://${tip.credit}.thalassawx.app`} target="_blank" rel="noopener noreferrer">
                                Logged aboard {tip.credit}
                            </a>
                        ) : (
                            <span className="oc-tip-credit">A Thalassa sailor</span>
                        ))}
                    {tip.pinned && (
                        <button type="button" className="oc-tip-close" onClick={() => setTip(null)} aria-label="Close">
                            ×
                        </button>
                    )}
                </div>
            )}
        </>
    );
}
