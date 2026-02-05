/**
 * Mini Track Map - Shows a compact SVG preview of the voyage track
 */

import React, { useMemo } from 'react';
import { ShipLogEntry } from '../types';

interface MiniTrackMapProps {
    entries: ShipLogEntry[];
    height?: number;
}

export const MiniTrackMap: React.FC<MiniTrackMapProps> = ({ entries, height = 100 }) => {
    const pathData = useMemo(() => {
        // Filter entries with valid coordinates
        const validEntries = entries.filter(e => e.latitude && e.longitude);
        if (validEntries.length < 2) return null;

        // Get bounds
        const lats = validEntries.map(e => e.latitude!);
        const lons = validEntries.map(e => e.longitude!);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);

        // Add padding
        const padding = 10;
        const width = 100; // Percentage
        const latRange = maxLat - minLat || 1;
        const lonRange = maxLon - minLon || 1;

        // Scale coordinates to SVG viewBox
        const scale = (lat: number, lon: number) => {
            const x = padding + ((lon - minLon) / lonRange) * (width - padding * 2);
            const y = padding + ((maxLat - lat) / latRange) * (height - padding * 2);
            return { x, y };
        };

        // Build path
        const points = validEntries.map(e => scale(e.latitude!, e.longitude!));
        const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

        // Start and end points
        const start = points[0];
        const end = points[points.length - 1];

        return { pathD, start, end, width, height };
    }, [entries, height]);

    if (!pathData) {
        return (
            <div className="w-full h-16 bg-slate-800/50 rounded-lg flex items-center justify-center text-slate-500 text-xs">
                Start tracking to see your voyage path
            </div>
        );
    }

    return (
        <div className="w-full bg-slate-800/30 border border-white/5 rounded-lg overflow-hidden">
            <svg
                viewBox={`0 0 100 ${height}`}
                className="w-full"
                style={{ height }}
                preserveAspectRatio="none"
            >
                {/* Grid lines */}
                <defs>
                    <pattern id="miniGrid" width="10" height="10" patternUnits="userSpaceOnUse">
                        <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
                    </pattern>
                </defs>
                <rect width="100" height={height} fill="url(#miniGrid)" />

                {/* Track line with glow */}
                <path
                    d={pathData.pathD}
                    fill="none"
                    stroke="rgba(56, 189, 248, 0.3)"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <path
                    d={pathData.pathD}
                    fill="none"
                    stroke="#38bdf8"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />

                {/* Start point */}
                <circle cx={pathData.start.x} cy={pathData.start.y} r="3" fill="#22c55e" />
                <circle cx={pathData.start.x} cy={pathData.start.y} r="5" fill="none" stroke="#22c55e" strokeWidth="1" opacity="0.5" />

                {/* End point */}
                <circle cx={pathData.end.x} cy={pathData.end.y} r="3" fill="#ef4444" />
                <circle cx={pathData.end.x} cy={pathData.end.y} r="5" fill="none" stroke="#ef4444" strokeWidth="1" opacity="0.5" />
            </svg>
        </div>
    );
};
