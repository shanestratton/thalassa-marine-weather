/**
 * Nav Mesh X-Ray Overlay
 * 
 * Developer tool to visualize the navigation graph on the Leaflet map.
 * Renders nodes as dots and edges as faint lines, color-coded by type:
 *   - Blue dots: regular nav nodes
 *   - Cyan dots: virtual_water grid nodes  
 *   - Green dots: port/starboard markers
 *   - Red edges: heavily penalized (danger zone)
 *   - Faint white edges: normal connections
 * 
 * For performance with 197K+ nodes, only renders what's visible in the viewport.
 * Uses Leaflet Canvas renderer for fast drawing.
 */

import { useEffect, useRef, MutableRefObject } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useNavMeshOverlay');
import L from 'leaflet';

// ── Types ──────────────────────────────────────────────────────────

interface NavGraphData {
    meta: { nodes: number; edges: number; total_nm: number; region: string };
    nodes: number[][];          // [[lon, lat], ...]
    edges: number[][];          // [[from, to, weight], ...]
    markers?: (number | string)[][];  // [[nodeIdx, type], ...]
}

// ── Constants ──────────────────────────────────────────────────────

const MIN_ZOOM_TO_RENDER = 10;      // Only render mesh at zoom 10+
const EDGE_WEIGHT_DANGER = 5.0;     // Edges with weight > this are danger-penalized
const NODE_RADIUS = 2;              // Dot radius in pixels
const EDGE_OPACITY = 0.15;          // Normal edge opacity
const DANGER_OPACITY = 0.6;         // Danger edge opacity

// ── Hook ───────────────────────────────────────────────────────────

export function useNavMeshOverlay(
    mapInstance: MutableRefObject<L.Map | null>,
    visible: boolean,
    supabaseUrl: string,
    region = 'thalassa_graph_australia_se_qld'
) {
    const graphDataRef = useRef<NavGraphData | null>(null);
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const loadingRef = useRef(false);
    const lastBoundsRef = useRef<string>('');

    // Load graph data
    useEffect(() => {
        if (!visible || graphDataRef.current || loadingRef.current) return;
        if (!supabaseUrl) return;

        loadingRef.current = true;
        const url = `${supabaseUrl}/storage/v1/object/public/nav-graphs/${region}.json`;

        fetch(url)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((data: NavGraphData) => {
                graphDataRef.current = data;                loadingRef.current = false;
            })
            .catch(err => {
                log.error('[NavMesh] Failed to load:', err);
                loadingRef.current = false;
            });
    }, [visible, supabaseUrl, region]);

    // Render/update mesh on map
    useEffect(() => {
        const map = mapInstance.current;
        if (!map) return;

        // Clean up when hidden
        if (!visible) {
            if (layerGroupRef.current) {
                map.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
                lastBoundsRef.current = '';
            }
            return;
        }

        const data = graphDataRef.current;
        if (!data) return;

        // Build marker type lookup
        const markerTypes = new Map<number, string>();
        if (data.markers) {
            for (const m of data.markers) {
                markerTypes.set(m[0] as number, m[1] as string);
            }
        }

        // Render function — called on move/zoom
        const renderViewport = () => {
            const currentZoom = map.getZoom();

            // Don't render at low zoom — too many nodes
            if (currentZoom < MIN_ZOOM_TO_RENDER) {
                if (layerGroupRef.current) {
                    map.removeLayer(layerGroupRef.current);
                    layerGroupRef.current = null;
                    lastBoundsRef.current = '';
                }
                return;
            }

            const bounds = map.getBounds();
            const boundsKey = `${bounds.toBBoxString()}_${currentZoom}`;

            // Skip if viewport hasn't changed
            if (boundsKey === lastBoundsRef.current) return;
            lastBoundsRef.current = boundsKey;

            // Remove old layer
            if (layerGroupRef.current) {
                map.removeLayer(layerGroupRef.current);
            }

            const group = L.layerGroup();
            const canvasRenderer = L.canvas({ padding: 0.5 });

            const minLon = bounds.getWest();
            const maxLon = bounds.getEast();
            const minLat = bounds.getSouth();
            const maxLat = bounds.getNorth();

            // Pad viewport slightly for edges that cross boundary
            const padLon = (maxLon - minLon) * 0.1;
            const padLat = (maxLat - minLat) * 0.1;
            const pMinLon = minLon - padLon;
            const pMaxLon = maxLon + padLon;
            const pMinLat = minLat - padLat;
            const pMaxLat = maxLat + padLat;

            // Find visible nodes (with index tracking)
            const visibleNodeIndices = new Set<number>();
            for (let i = 0; i < data.nodes.length; i++) {
                const [lon, lat] = data.nodes[i];
                if (lon >= pMinLon && lon <= pMaxLon && lat >= pMinLat && lat <= pMaxLat) {
                    visibleNodeIndices.add(i);
                }
            }

            // Render edges first (behind nodes)
            let edgeCount = 0;
            let dangerCount = 0;
            for (const edge of data.edges) {
                const [fromIdx, toIdx, weight] = edge;
                if (!visibleNodeIndices.has(fromIdx) && !visibleNodeIndices.has(toIdx)) continue;

                const from = data.nodes[fromIdx];
                const to = data.nodes[toIdx];
                if (!from || !to) continue;

                const isDanger = weight > EDGE_WEIGHT_DANGER;

                L.polyline(
                    [[from[1], from[0]], [to[1], to[0]]],
                    {
                        color: isDanger ? '#ef4444' : '#94a3b8',
                        weight: isDanger ? 1.5 : 0.5,
                        opacity: isDanger ? DANGER_OPACITY : EDGE_OPACITY,
                        renderer: canvasRenderer,
                        interactive: false,
                    }
                ).addTo(group);

                edgeCount++;
                if (isDanger) dangerCount++;
            }

            // Render nodes
            let nodeCount = 0;
            for (const idx of visibleNodeIndices) {
                const [lon, lat] = data.nodes[idx];
                const mType = markerTypes.get(idx);

                let color = '#60a5fa';  // default: blue
                let radius = NODE_RADIUS;

                if (mType === 'virtual_water') {
                    color = '#22d3ee';  // cyan
                    radius = 1.5;
                } else if (mType === 'port') {
                    color = '#ef4444';  // red
                    radius = 3;
                } else if (mType === 'starboard') {
                    color = '#22c55e';  // green
                    radius = 3;
                } else if (mType?.startsWith('cardinal')) {
                    color = '#fbbf24';  // yellow
                    radius = 3;
                } else if (mType === 'fairway') {
                    color = '#a855f7';  // purple
                    radius = 3;
                }

                L.circleMarker(
                    [lat, lon],
                    {
                        radius,
                        color: 'transparent',
                        fillColor: color,
                        fillOpacity: 0.7,
                        renderer: canvasRenderer,
                        interactive: false,
                    }
                ).addTo(group);

                nodeCount++;
            }

            group.addTo(map);
            layerGroupRef.current = group;        };

        // Initial render
        renderViewport();

        // Re-render on map move/zoom
        map.on('moveend', renderViewport);
        map.on('zoomend', renderViewport);

        return () => {
            map.off('moveend', renderViewport);
            map.off('zoomend', renderViewport);
            if (layerGroupRef.current) {
                map.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
            }
            lastBoundsRef.current = '';
        };
    }, [mapInstance.current, visible, graphDataRef.current]);
}
