/**
 * DepthSummaryCard — GEBCO Depth Analysis Summary for passage routes.
 *
 * Shows minimum depth along the route, number of shallow segments,
 * and a visual depth profile bar with safety-classified segments.
 */

import React from 'react';

interface DepthSegment {
    depth_m: number | null;
    safety: string; // 'safe' | 'caution' | 'danger' | 'land' | 'unknown'
    costMultiplier: number;
}

interface DepthSummaryData {
    minDepth: number | null;
    shallowSegments: number;
    totalSegments: number;
    segments: DepthSegment[];
}

interface DepthSummaryCardProps {
    data: DepthSummaryData;
    vesselDraft?: number;
}

const SAFETY_COLORS = {
    safe: { bg: 'bg-emerald-500', text: 'text-emerald-400', label: 'Deep Water' },
    caution: { bg: 'bg-amber-500', text: 'text-amber-400', label: 'Shallow' },
    danger: { bg: 'bg-red-500', text: 'text-red-400', label: 'Very Shallow' },
    land: { bg: 'bg-red-700', text: 'text-red-500', label: 'LAND' },
    unknown: { bg: 'bg-gray-600', text: 'text-gray-400', label: 'Unknown' },
};

export const DepthSummaryCard: React.FC<DepthSummaryCardProps> = ({ data, vesselDraft = 2.5 }) => {
    const hasDanger = data.segments.some((s) => s.safety === 'danger' || s.safety === 'land');
    const hasCaution = data.segments.some((s) => s.safety === 'caution');

    const overallStatus = hasDanger ? 'danger' : hasCaution ? 'caution' : 'safe';
    const statusStyle = {
        safe: {
            bg: 'bg-emerald-500/10',
            border: 'border-emerald-500/30',
            text: 'text-emerald-400',
            label: 'DEPTH CLEAR',
            icon: '✅',
        },
        caution: {
            bg: 'bg-amber-500/10',
            border: 'border-amber-500/30',
            text: 'text-amber-400',
            label: 'SHALLOW WATER',
            icon: '⚠️',
        },
        danger: {
            bg: 'bg-red-500/10',
            border: 'border-red-500/30',
            text: 'text-red-400',
            label: 'DEPTH HAZARD',
            icon: '🔴',
        },
    }[overallStatus];

    // Count segments by safety
    const counts = data.segments.reduce(
        (acc, s) => {
            acc[s.safety] = (acc[s.safety] || 0) + 1;
            return acc;
        },
        {} as Record<string, number>,
    );

    return (
        <div className="space-y-4">
            {/* Status Banner */}
            <div
                className={`${statusStyle.bg} ${statusStyle.border} border rounded-xl px-4 py-3 flex items-center gap-3`}
            >
                <span className="text-2xl">{statusStyle.icon}</span>
                <div className="flex-1">
                    <div className={`text-sm font-black uppercase tracking-widest ${statusStyle.text}`}>
                        {statusStyle.label}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                        {data.shallowSegments} of {data.totalSegments} segments flagged • Draft: {vesselDraft}m
                    </div>
                </div>
                <div className="text-right shrink-0">
                    <div className="text-lg font-bold text-white">
                        {data.minDepth !== null ? `${Math.abs(data.minDepth)}m` : '--'}
                    </div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Min Depth</div>
                </div>
            </div>

            {/* Visual Depth Profile Bar */}
            <div>
                <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2">
                    Route Depth Profile
                </div>
                <div className="flex h-6 rounded-lg overflow-hidden border border-white/10 bg-black/40">
                    {data.segments.map((seg, i) => {
                        const safety = (seg.safety as keyof typeof SAFETY_COLORS) || 'unknown';
                        const color = SAFETY_COLORS[safety] || SAFETY_COLORS.unknown;
                        const widthPct = 100 / data.segments.length;

                        return (
                            <div
                                key={i}
                                className={`${color.bg} relative group cursor-default transition-opacity hover:opacity-80`}
                                style={{ width: `${widthPct}%` }}
                                title={`Depth: ${seg.depth_m !== null ? `${Math.abs(seg.depth_m)}m` : 'unknown'} (${safety})`}
                            >
                                {/* Tooltip on hover */}
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-black/90 rounded text-[10px] text-white font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 border border-white/10">
                                    {seg.depth_m !== null ? `${Math.abs(seg.depth_m)}m` : '?'}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Safety Legend */}
            <div className="flex flex-wrap gap-3">
                {Object.entries(counts).map(([safety, count]) => {
                    const s = SAFETY_COLORS[safety as keyof typeof SAFETY_COLORS] || SAFETY_COLORS.unknown;
                    return (
                        <div key={safety} className="flex items-center gap-1.5">
                            <div className={`w-3 h-3 rounded ${s.bg}`} />
                            <span className={`text-[11px] font-bold ${s.text}`}>{s.label}</span>
                            <span className="text-[10px] text-gray-500">({count})</span>
                        </div>
                    );
                })}
            </div>

            {/* Depth Stats Grid */}
            <div className="grid grid-cols-3 gap-3">
                <div className="bg-white/[0.03] rounded-xl px-3 py-2.5 text-center border border-white/[0.06]">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Min Depth</div>
                    <div
                        className={`text-lg font-bold ${
                            data.minDepth !== null && Math.abs(data.minDepth) < vesselDraft * 2
                                ? 'text-red-400'
                                : 'text-white'
                        }`}
                    >
                        {data.minDepth !== null ? `${Math.abs(data.minDepth)}m` : '--'}
                    </div>
                </div>
                <div className="bg-white/[0.03] rounded-xl px-3 py-2.5 text-center border border-white/[0.06]">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">
                        Vessel Draft
                    </div>
                    <div className="text-lg font-bold text-sky-400">{vesselDraft}m</div>
                </div>
                <div className="bg-white/[0.03] rounded-xl px-3 py-2.5 text-center border border-white/[0.06]">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-1">Clearance</div>
                    <div
                        className={`text-lg font-bold ${
                            data.minDepth !== null
                                ? Math.abs(data.minDepth) - vesselDraft < 2
                                    ? 'text-red-400'
                                    : 'text-emerald-400'
                                : 'text-gray-500'
                        }`}
                    >
                        {data.minDepth !== null ? `${(Math.abs(data.minDepth) - vesselDraft).toFixed(1)}m` : '--'}
                    </div>
                </div>
            </div>
        </div>
    );
};
