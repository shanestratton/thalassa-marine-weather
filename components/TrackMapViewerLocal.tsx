/** Local-only recorded-position plot; no map SDK, imagery, provider or authentication request. */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { TrackMapViewerGLHandle, TrackMapViewerGLProps } from './TrackMapViewerGL';
import type { ShipLogEntry } from '../types';
import { windBucket } from '../services/shiplog/trackViz';
import { TRACK_GRAPH_GAP_MS } from '../services/piTrackReplay';

type Padding = { top: number; right: number; bottom: number; left: number };
const near = (lon: number, reference: number) => reference + ((((lon - reference) % 360) + 540) % 360) - 180;
const northing = (lat: number) =>
    (Math.log(Math.tan(Math.PI / 4 + (Math.max(-89.999, Math.min(89.999, lat)) * Math.PI) / 360)) * 180) / Math.PI;
export function localTrackGeometry(entries: ShipLogEntry[], width: number, height: number, padding?: number | Padding) {
    let previous: number | undefined;
    const points = entries
        .filter(
            (e) =>
                Number.isFinite(e.latitude) &&
                Number.isFinite(e.longitude) &&
                Math.abs(e.latitude) <= 90 &&
                Math.abs(e.longitude) <= 180,
        )
        .map((entry) => {
            const lon = previous === undefined ? entry.longitude : near(entry.longitude, previous);
            previous = lon;
            return { entry, lon, y: northing(entry.latitude) };
        });
    let west = Infinity,
        east = -Infinity,
        south = Infinity,
        north = -Infinity;
    for (const point of points) {
        west = Math.min(west, point.lon);
        east = Math.max(east, point.lon);
        south = Math.min(south, point.y);
        north = Math.max(north, point.y);
    }
    const p =
        typeof padding === 'object'
            ? padding
            : { top: padding ?? 40, right: padding ?? 40, bottom: padding ?? 40, left: padding ?? 40 };
    const safe =
        width > p.left + p.right + 20 && height > p.top + p.bottom + 20
            ? p
            : { top: 40, right: 40, bottom: 40, left: 40 };
    const usableWidth = Math.max(1, width - safe.left - safe.right),
        usableHeight = Math.max(1, height - safe.top - safe.bottom);
    const scale = Math.min(
        usableWidth / Math.max(0.00001, east - west),
        usableHeight / Math.max(0.00001, north - south),
    );
    const center = points.length ? (west + east) / 2 : 0,
        centerY = points.length ? (north + south) / 2 : 0;
    const unwrappedPoint = (lat: number, lon: number) => ({
        x: safe.left + usableWidth / 2 + (lon - center) * scale,
        y: safe.top + usableHeight / 2 - (northing(lat) - centerY) * scale,
    });
    return {
        points: points.map((point) => ({ ...point, ...unwrappedPoint(point.entry.latitude, point.lon) })),
        project: (lat: number, lon: number) => unwrappedPoint(lat, near(lon, center)),
    };
}
const TrackMapViewerLocal = forwardRef<TrackMapViewerGLHandle, TrackMapViewerGLProps>(function TrackMapViewerLocal(
    { entries, colorMode, framePadding },
    ref,
) {
    const box = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 300, height: 640 });
    const [vessel, setVessel] = useState<{ lat: number; lon: number } | null>(null);
    useImperativeHandle(ref, () => ({ moveVessel: (lat, lon) => setVessel({ lat, lon }) }), []);
    useEffect(() => {
        const measure = () => {
            const node = box.current;
            if (node) setSize({ width: node.clientWidth, height: node.clientHeight });
        };
        measure();
        const observer = new ResizeObserver(measure);
        if (box.current) observer.observe(box.current);
        return () => observer.disconnect();
    }, []);
    const geometry = useMemo(
        () => localTrackGeometry(entries, size.width, size.height, framePadding?.()),
        [entries, size, framePadding],
    );
    const boat = vessel && geometry.project(vessel.lat, vessel.lon);
    return (
        <div ref={box} className="absolute inset-0 bg-[#1f5a85]">
            <svg
                data-private-track-plot
                role="img"
                aria-label="Logged positions on a local coordinate plot, without chart imagery"
                className="absolute inset-0 h-full w-full"
                viewBox={`0 0 ${size.width} ${size.height}`}
            >
                {geometry.points.map((point, i) => {
                    const before = geometry.points[i - 1];
                    const gap =
                        before &&
                        Date.parse(point.entry.timestamp) - Date.parse(before.entry.timestamp) > TRACK_GRAPH_GAP_MS;
                    return (
                        <g key={point.entry.id}>
                            {before && !gap && (
                                <path
                                    data-recorded-track
                                    d={`M${before.x},${before.y}L${point.x},${point.y}`}
                                    fill="none"
                                    stroke={colorMode === 'wind' ? windBucket(point.entry.windSpeed).color : '#38bdf8'}
                                    strokeWidth="4"
                                    strokeLinecap="round"
                                />
                            )}
                            <circle
                                cx={point.x}
                                cy={point.y}
                                r={i === 0 || i === geometry.points.length - 1 ? 6 : 3}
                                fill={i === 0 ? '#34d399' : i === geometry.points.length - 1 ? '#ef4444' : '#ffffff'}
                                stroke="#0f172a"
                                strokeWidth="1"
                            >
                                <title>
                                    {new Date(point.entry.timestamp).toISOString()} {point.entry.latitude.toFixed(5)},{' '}
                                    {point.entry.longitude.toFixed(5)}
                                </title>
                            </circle>
                        </g>
                    );
                })}
                {boat && (
                    <circle
                        data-playback-vessel
                        cx={boat.x}
                        cy={boat.y}
                        r="8"
                        fill="#00f0ff"
                        stroke="white"
                        strokeWidth="2"
                    />
                )}
            </svg>
        </div>
    );
});
export default TrackMapViewerLocal;
