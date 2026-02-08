/**
 * Mini Track Map - Premium SVG preview of the voyage track
 * Shows gradient-colored path with glowing start/end markers
 */

import React, { useMemo } from 'react';
import { t } from '../theme';
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
        const padding = 12;
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
            <div className="w-full h-20 bg-slate-800/30 ${t.border.subtle} rounded-xl flex flex-col items-center justify-center gap-1.5">
                <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                <span className="text-slate-600 text-sm font-medium">Start tracking to see your voyage</span>
            </div>
        );
    }

    return (
        <div className={`w-full bg-slate-800/20 ${t.border.subtle} rounded-xl overflow-hidden`}>
            <svg
                viewBox={`0 0 100 ${height}`}
                className="w-full"
                style={{ height }}
                preserveAspectRatio="none"
            >
                {/* Defs for gradients */}
                <defs>
                    {/* Background grid */}
                    <pattern id="miniGrid" width="10" height="10" patternUnits="userSpaceOnUse">
                        <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
                    </pattern>

                    {/* Track gradient: green → sky → red */}
                    <linearGradient id="trackGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#22c55e" />
                        <stop offset="50%" stopColor="#38bdf8" />
                        <stop offset="100%" stopColor="#ef4444" />
                    </linearGradient>

                    {/* Glow gradient */}
                    <linearGradient id="trackGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
                        <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.2" />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity="0.25" />
                    </linearGradient>

                    {/* Start/end glows */}
                    <radialGradient id="startGlow">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity="0.6" />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="endGlow">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity="0.6" />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
                    </radialGradient>
                </defs>

                {/* Grid */}
                <rect width="100" height={height} fill="url(#miniGrid)" />

                {/* Track outer glow */}
                <path
                    d={pathData.pathD}
                    fill="none"
                    stroke="url(#trackGlow)"
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />

                {/* Track main line with gradient */}
                <path
                    d={pathData.pathD}
                    fill="none"
                    stroke="url(#trackGradient)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />

                {/* Start point glow & dot */}
                <circle cx={pathData.start.x} cy={pathData.start.y} r="8" fill="url(#startGlow)" />
                <circle cx={pathData.start.x} cy={pathData.start.y} r="3.5" fill="#22c55e" />
                <circle cx={pathData.start.x} cy={pathData.start.y} r="5" fill="none" stroke="#22c55e" strokeWidth="1" opacity="0.4" />

                {/* End point glow & dot */}
                <circle cx={pathData.end.x} cy={pathData.end.y} r="8" fill="url(#endGlow)" />
                <circle cx={pathData.end.x} cy={pathData.end.y} r="3.5" fill="#ef4444" />
                <circle cx={pathData.end.x} cy={pathData.end.y} r="5" fill="none" stroke="#ef4444" strokeWidth="1" opacity="0.4" />
            </svg>
        </div>
    );
};
