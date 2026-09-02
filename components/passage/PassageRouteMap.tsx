/**
 * PassageRouteMap — mini passage preview rendered as a STATIC IMAGE from the
 * Mapbox Static Images API, with the depart/arrive/waypoint dots drawn as DOM
 * overlays projected in plain Web-Mercator math.
 *
 * WHY NOT A LIVE MAP. This used to be a full `new mapboxgl.Map()` (already
 * `interactive: false` — a GL engine employed as a picture). The planning
 * page rebuilds its voyage rows on every coalesced reload, which hands this
 * component a fresh `routeCoordinates` array identity each time; the old
 * effect answered with `map.remove()` + `new mapboxgl.Map()` — a full
 * style/worker/GL-context spin-up. WebKit does not promptly return that
 * memory: Shane's JetsamEvent (2026-08-04 12:48) shows our WebContent killed
 * at `reason: per-process-limit` with rpages 131626 (~2.0 GB, lifetimeMax ==
 * rpages — monotonic growth) after ~17 minutes on the planning page.
 *
 * A static image removes the entire class: no GL context, no workers, no
 * tile cache — and prop-identity churn is harmless because the same route
 * values produce the same URL, which the HTTP cache serves for free. The
 * card is non-interactive anyway; "Tap to expand" opens TrackMapViewer for
 * the real, live map.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

interface PassageRouteMapProps {
    routeCoordinates: [number, number][]; // [lon, lat] GeoJSON order
    departLat: number;
    departLon: number;
    arriveLat: number;
    arriveLon: number;
    turnWaypoints?: { id: string; name: string; lat: number; lon: number }[];
    /** Height in pixels, defaults to 200 */
    height?: number;
    className?: string;
}

/** Reject NaN, out-of-range, and the (0,0) uninitialised sentinel. */
const isValidCoord = (lon: number | null | undefined, lat: number | null | undefined): boolean => {
    if (lon == null || lat == null) return false;
    if (typeof lon !== 'number' || typeof lat !== 'number') return false;
    if (isNaN(lon) || isNaN(lat)) return false;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return false;
    if (Math.abs(lon) < 0.0001 && Math.abs(lat) < 0.0001) return false;
    return true;
};

/* ── Web-Mercator (world coords in [0,1] at zoom 0) ───────────── */

const MAX_MERC_LAT = 85.051129;

const mercX = (lon: number): number => (lon + 180) / 360;
const mercY = (lat: number): number => {
    const clamped = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
    const rad = (clamped * Math.PI) / 180;
    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
};

/** Static API caps requests at 1280×1280 per axis (before @2x). */
const MAX_IMAGE_AXIS = 1280;
const FIT_PADDING_PX = 40;
/** Short harbour hops must not zoom into a featureless blue rectangle. */
const MAX_FIT_ZOOM = 13;

/**
 * Google polyline encoding, precision 5 — the format the Static Images API
 * `path-…(…)` overlay expects.
 */
export function encodePolyline(points: readonly [number, number][]): string {
    let output = '';
    let prevLat = 0;
    let prevLon = 0;
    const encodeValue = (value: number, previous: number): string => {
        const rounded = Math.round(value * 1e5);
        let delta = rounded - previous;
        delta = delta < 0 ? ~(delta << 1) : delta << 1;
        let chunk = '';
        while (delta >= 0x20) {
            chunk += String.fromCharCode((0x20 | (delta & 0x1f)) + 63);
            delta >>= 5;
        }
        chunk += String.fromCharCode(delta + 63);
        return chunk;
    };
    for (const [lon, lat] of points) {
        output += encodeValue(lat, prevLat);
        output += encodeValue(lon, prevLon);
        prevLat = Math.round(lat * 1e5);
        prevLon = Math.round(lon * 1e5);
    }
    return output;
}

/** Uniform-stride decimation that always keeps both endpoints. */
export function decimateRoute(points: readonly [number, number][], maxPoints: number): [number, number][] {
    if (points.length <= maxPoints) return [...points];
    const kept: [number, number][] = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) {
        kept.push(points[Math.round(i * step)]);
    }
    kept[kept.length - 1] = points[points.length - 1];
    return kept;
}

interface ProjectedMarker {
    key: string;
    leftPct: number;
    topPct: number;
    kind: 'depart' | 'arrive' | 'waypoint';
}

interface StaticMapModel {
    url: string;
    markers: ProjectedMarker[];
}

/** Keep well under the ~8 KB practical URL ceiling. */
const URL_BUDGET_CHARS = 7000;
const DECIMATION_LADDER = [160, 90, 50] as const;

export const PassageRouteMap: React.FC<PassageRouteMapProps> = React.memo(
    ({ routeCoordinates, departLat, departLon, arriveLat, arriveLon, turnWaypoints, height = 200, className = '' }) => {
        const containerRef = useRef<HTMLDivElement>(null);
        // Width is quantised to 16px so trivial layout jitter never mints a
        // new image URL. Markers are positioned in PERCENT, so the ≤4%
        // display stretch from quantisation cannot misplace them.
        const [measuredWidth, setMeasuredWidth] = useState(0);
        const [failed, setFailed] = useState(false);

        useEffect(() => {
            const element = containerRef.current;
            if (!element || typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver((entries) => {
                const width = entries[0]?.contentRect.width ?? 0;
                if (width > 0) {
                    setMeasuredWidth(Math.min(MAX_IMAGE_AXIS, Math.max(64, Math.round(width / 16) * 16)));
                }
            });
            observer.observe(element);
            return () => observer.disconnect();
        }, []);

        const model = useMemo<StaticMapModel | null>(() => {
            const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
            if (!token || measuredWidth === 0) return null;

            const route = routeCoordinates.filter(([lon, lat]) => isValidCoord(lon, lat));
            if (route.length < 2) return null;

            const markerCoords: { lon: number; lat: number; kind: ProjectedMarker['kind']; key: string }[] = [];
            if (isValidCoord(departLon, departLat)) {
                markerCoords.push({ lon: departLon, lat: departLat, kind: 'depart', key: 'depart' });
            }
            if (isValidCoord(arriveLon, arriveLat)) {
                markerCoords.push({ lon: arriveLon, lat: arriveLat, kind: 'arrive', key: 'arrive' });
            }
            for (const wp of (turnWaypoints ?? []).slice(0, 40)) {
                if (isValidCoord(wp.lon, wp.lat)) {
                    markerCoords.push({ lon: wp.lon, lat: wp.lat, kind: 'waypoint', key: `wp-${wp.id}` });
                }
            }

            // Antimeridian: when the raw span exceeds 180° the points straddle
            // the date line — shift western longitudes +360 so mercator space
            // is continuous, and normalise the centre back for the URL.
            const allLons = [...route.map(([lon]) => lon), ...markerCoords.map((m) => m.lon)];
            const rawSpan = Math.max(...allLons) - Math.min(...allLons);
            const shiftLon = (lon: number): number => (rawSpan > 180 && lon < 0 ? lon + 360 : lon);

            const xs: number[] = [];
            const ys: number[] = [];
            const collect = (lon: number, lat: number) => {
                xs.push(mercX(shiftLon(lon)));
                ys.push(mercY(lat));
            };
            for (const [lon, lat] of route) collect(lon, lat);
            for (const m of markerCoords) collect(m.lon, m.lat);

            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;

            const width = measuredWidth;
            const paddingX = Math.min(FIT_PADDING_PX, width / 4);
            const paddingY = Math.min(FIT_PADDING_PX, height / 4);
            const availableW = width - 2 * paddingX;
            const availableH = height - 2 * paddingY;
            const spanX = maxX - minX;
            const spanY = maxY - minY;
            const zoomForSpan = (available: number, span: number): number =>
                span > 0 ? Math.log2(available / (512 * span)) : Number.POSITIVE_INFINITY;
            let zoom = Math.min(zoomForSpan(availableW, spanX), zoomForSpan(availableH, spanY), MAX_FIT_ZOOM);
            if (!Number.isFinite(zoom)) zoom = 11;
            zoom = Math.max(0, Math.round(zoom * 100) / 100);

            const worldPx = 512 * Math.pow(2, zoom);
            const project = (lon: number, lat: number): { leftPct: number; topPct: number } => ({
                leftPct: ((width / 2 + (mercX(shiftLon(lon)) - centerX) * worldPx) / width) * 100,
                topPct: ((height / 2 + (mercY(lat) - centerY) * worldPx) / height) * 100,
            });

            const markers: ProjectedMarker[] = markerCoords.map((m) => ({
                key: m.key,
                kind: m.kind,
                ...project(m.lon, m.lat),
            }));

            // The centre longitude for the URL must be in [-180, 180]. Invert
            // mercX: x∈[0,1] → lon∈[-180,180]; a shifted centre (>1) wraps.
            let centerLon = centerX * 360 - 180;
            if (centerLon > 180) centerLon -= 360;
            const centerLat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * centerY))) * 180) / Math.PI;

            // Triple-layer glow collapses to two path overlays: each overlay
            // repeats the whole encoded polyline in the URL, so every extra
            // layer costs the full route again against the URL budget.
            const buildUrl = (maxPoints: number): string => {
                const encoded = encodeURIComponent(encodePolyline(decimateRoute(route, maxPoints)));
                const paths = `path-5+0ea5e9-0.25(${encoded}),path-2+38bdf8-0.9(${encoded})`;
                return (
                    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${paths}/` +
                    `${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom}/${width}x${height}@2x` +
                    `?logo=false&attribution=false&access_token=${token}`
                );
            };
            let url = buildUrl(DECIMATION_LADDER[0]);
            for (let i = 1; i < DECIMATION_LADDER.length && url.length > URL_BUDGET_CHARS; i++) {
                url = buildUrl(DECIMATION_LADDER[i]);
            }

            return { url, markers };
        }, [routeCoordinates, departLat, departLon, arriveLat, arriveLon, turnWaypoints, height, measuredWidth]);

        useEffect(() => {
            setFailed(false);
        }, [model?.url]);

        const markerStyle = (marker: ProjectedMarker): React.CSSProperties => {
            const base: React.CSSProperties = {
                position: 'absolute',
                left: `${marker.leftPct}%`,
                top: `${marker.topPct}%`,
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                pointerEvents: 'none',
            };
            if (marker.kind === 'depart') {
                return {
                    ...base,
                    width: 10,
                    height: 10,
                    backgroundColor: '#22c55e',
                    border: '2px solid rgba(255,255,255,0.6)',
                    boxShadow: '0 0 6px rgba(34,197,94,0.5)',
                };
            }
            if (marker.kind === 'arrive') {
                return {
                    ...base,
                    width: 10,
                    height: 10,
                    backgroundColor: '#f59e0b',
                    border: '2px solid rgba(255,255,255,0.6)',
                    boxShadow: '0 0 6px rgba(245,158,11,0.5)',
                };
            }
            return {
                ...base,
                width: 6,
                height: 6,
                backgroundColor: '#ffffff',
                opacity: 0.7,
                boxShadow: '0 0 4px rgba(255,255,255,0.3)',
            };
        };

        return (
            <div
                className={`relative rounded-xl overflow-hidden border border-white/10 bg-slate-900/80 ${className}`}
                style={{ height }}
            >
                <div ref={containerRef} className="w-full h-full">
                    {model && !failed && (
                        <>
                            <img
                                key={model.url}
                                src={model.url}
                                alt="Passage route preview"
                                className="w-full h-full"
                                draggable={false}
                                onError={() => setFailed(true)}
                            />
                            {model.markers.map((marker) => (
                                <div key={marker.key} style={markerStyle(marker)} />
                            ))}
                            {/* Required when the API's baked-in attribution is
                                disabled via ?attribution=false. */}
                            <span className="absolute bottom-0.5 left-1.5 text-xs text-white/70 pointer-events-none select-none">
                                © Mapbox © OpenStreetMap
                            </span>
                        </>
                    )}
                </div>
            </div>
        );
    },
);

PassageRouteMap.displayName = 'PassageRouteMap';
