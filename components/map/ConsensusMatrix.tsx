/**
 * ConsensusMatrix — Visual multi-model weather agreement timeline.
 *
 * Features:
 *   A. Scatter Bar — horizontal bar with colored model dots showing agreement/disagreement
 *   B. Outlier Flagging — worst-case model enlarged and bolded
 *   C. Route-Sync Scrubbing — scroll position moves map playhead
 *   D. Comfort Zone — rows exceeding limits flagged with No-Go icon
 *   E. Accessibility — large type, high contrast, cockpit-readable
 */

import React, { useRef, useEffect, useCallback } from 'react';
import type { ConsensusMatrixData, ConsensusRow, ModelPoint } from '../../services/ConsensusMatrixEngine';

interface ConsensusMatrixProps {
    data: ConsensusMatrixData;
    onScrubPosition?: (lat: number, lon: number, hoursFromDep: number) => void;
    onClose?: () => void;
}

// ── Scatter Bar Component ─────────────────────────────────────

const ScatterBar: React.FC<{ models: ModelPoint[]; maxScale?: number }> = ({ models, maxScale = 50 }) => {
    // Scale: 0 kts at left, maxScale at right
    return (
        <div className="relative h-8 bg-white/[0.03] rounded-lg border border-white/[0.06] overflow-hidden">
            {/* Scale ticks */}
            {[0, 10, 20, 30, 40, 50]
                .filter((v) => v <= maxScale)
                .map((v) => (
                    <div
                        key={v}
                        className="absolute top-0 bottom-0 w-px bg-white/[0.05]"
                        style={{ left: `${(v / maxScale) * 100}%` }}
                    />
                ))}

            {/* Model dots */}
            {models.map((m) => {
                const pct = Math.min(100, (m.windKts / maxScale) * 100);
                const isOutlier = m.isOutlier;
                return (
                    <div
                        key={m.model}
                        className="absolute top-1/2 -translate-y-1/2 transition-all duration-200"
                        style={{ left: `${pct}%`, transform: `translate(-50%, -50%) scale(${isOutlier ? 1.4 : 1})` }}
                        title={`${m.model}: ${m.windKts} kts`}
                    >
                        <div
                            className={`rounded-full border-2 ${isOutlier ? 'border-white shadow-lg' : 'border-transparent'}`}
                            style={{
                                width: isOutlier ? 14 : 10,
                                height: isOutlier ? 14 : 10,
                                backgroundColor: m.color,
                                boxShadow: isOutlier
                                    ? `0 0 12px ${m.color}80, 0 0 4px ${m.color}`
                                    : `0 2px 4px ${m.color}40`,
                            }}
                        />
                    </div>
                );
            })}
        </div>
    );
};

// ── Row Component ─────────────────────────────────────────────

const ConsensusRowView: React.FC<{
    row: ConsensusRow;
    onIntersect?: () => void;
    rowRef?: React.RefObject<HTMLDivElement>;
}> = ({ row, onIntersect: _onIntersect, rowRef }) => {
    const bgClass = row.exceedsComfort
        ? 'bg-red-500/[0.06] border-red-500/20'
        : row.confidence === 'low'
          ? 'bg-amber-500/[0.04] border-amber-500/15'
          : 'bg-transparent border-white/[0.04]';

    return (
        <div
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref={rowRef as any}
            data-hours={row.hoursFromDep}
            data-lat={row.lat}
            data-lon={row.lon}
            className={`px-4 py-3 border-b transition-colors ${bgClass}`}
        >
            {/* Top row: time + confidence badge + distance */}
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    {/* Time — LARGE for cockpit readability */}
                    <span className="text-base font-black text-white tabular-nums tracking-tight">{row.timeLabel}</span>

                    {/* Confidence badge */}
                    <span
                        className={`px-1.5 py-0.5 rounded text-[11px] font-black uppercase tracking-widest ${
                            row.confidence === 'high'
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : row.confidence === 'medium'
                                  ? 'bg-amber-500/15 text-amber-400'
                                  : 'bg-red-500/15 text-red-400'
                        }`}
                    >
                        {row.confidence === 'high' ? '✓ AGREE' : row.confidence === 'medium' ? '~ MIXED' : '⚠ SPLIT'}
                    </span>

                    {/* No-Go flag */}
                    {row.exceedsComfort && (
                        <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-[11px] font-black uppercase tracking-widest animate-pulse">
                            🚫 NO-GO
                        </span>
                    )}
                </div>

                {/* Distance */}
                <span className="text-[11px] font-bold text-gray-400 tabular-nums">
                    {row.distanceNM} NM • +{row.hoursFromDep}h
                </span>
            </div>

            {/* Scatter Bar */}
            <ScatterBar models={row.models} />

            {/* Bottom row: model legend + worst case */}
            <div className="flex items-center justify-between mt-2">
                {/* Model dots legend */}
                <div className="flex items-center gap-3">
                    {row.models.map((m) => (
                        <div key={m.model} className="flex items-center gap-1">
                            <div
                                className="rounded-full"
                                style={{
                                    width: m.isOutlier ? 8 : 6,
                                    height: m.isOutlier ? 8 : 6,
                                    backgroundColor: m.color,
                                }}
                            />
                            <span
                                className={`tabular-nums ${
                                    m.isOutlier
                                        ? 'text-sm font-black text-white'
                                        : 'text-[11px] font-bold text-gray-400'
                                }`}
                            >
                                {m.windKts.toFixed(0)}
                            </span>
                        </div>
                    ))}
                </div>

                {/* Worst case callout */}
                <div className="text-right">
                    <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Worst: </span>
                    <span className="text-sm font-black text-white tabular-nums">
                        {row.worstCase.windKts.toFixed(0)}
                    </span>
                    <span className="text-[11px] text-gray-400 ml-0.5">kts</span>
                    <span className="text-[11px] text-gray-500 ml-1.5">G{row.worstCase.gustKts.toFixed(0)}</span>
                </div>
            </div>

            {/* Spread indicator — visual bar showing model disagreement */}
            {row.spreadKts > 3 && (
                <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Spread</span>
                    <div className="flex-1 h-1 rounded-full bg-white/[0.04] overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all ${
                                row.confidence === 'high'
                                    ? 'bg-emerald-500/40'
                                    : row.confidence === 'medium'
                                      ? 'bg-amber-500/40'
                                      : 'bg-red-500/40'
                            }`}
                            style={{ width: `${Math.min(100, (row.spreadKts / 25) * 100)}%` }}
                        />
                    </div>
                    <span className="text-[11px] font-bold text-gray-400 tabular-nums">
                        ±{(row.spreadKts / 2).toFixed(0)} kts
                    </span>
                </div>
            )}
        </div>
    );
};

// ── Main Component ────────────────────────────────────────────

export const ConsensusMatrix: React.FC<ConsensusMatrixProps> = ({ data, onScrubPosition, onClose }) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    // Route-synchronized scrubbing: fire onScrubPosition as user scrolls
    const handleScroll = useCallback(() => {
        if (!scrollRef.current || !onScrubPosition) return;

        const container = scrollRef.current;
        const scrollTop = container.scrollTop;
        const containerHeight = container.clientHeight;
        const centerY = scrollTop + containerHeight / 2;

        // Find the row closest to the center of the viewport
        let closestRow: ConsensusRow | null = null;
        let closestDist = Infinity;

        for (const [idx, el] of rowRefs.current.entries()) {
            const rect = el.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const rowCenter = rect.top - containerRect.top + scrollTop + rect.height / 2;
            const dist = Math.abs(rowCenter - centerY);
            if (dist < closestDist && data.rows[idx]) {
                closestDist = dist;
                closestRow = data.rows[idx];
            }
        }

        if (closestRow) {
            onScrubPosition(closestRow.lat, closestRow.lon, closestRow.hoursFromDep);
        }
    }, [data.rows, onScrubPosition]);

    // Attach scroll listener
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.addEventListener('scroll', handleScroll, { passive: true });
        return () => el.removeEventListener('scroll', handleScroll);
    }, [handleScroll]);

    return (
        <div className="h-full flex flex-col bg-slate-950 border-l border-white/[0.06]">
            {/* Header */}
            <div className="px-4 pt-4 pb-3 border-b border-white/[0.08] shrink-0">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-gradient-to-r from-sky-400 to-purple-400 animate-pulse" />
                        <h2 className="text-[11px] font-black text-white uppercase tracking-[0.15em]">
                            Consensus Matrix
                        </h2>
                    </div>
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="w-9 h-9 flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] hover:bg-white/10 transition-colors active:scale-95"
                            aria-label="Close consensus matrix"
                        >
                            <svg
                                className="w-4 h-4 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>

                {/* Data source + model legend */}
                <div className="flex items-center gap-3 mb-2">
                    <span
                        className={`px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-widest ${
                            data.dataSource === 'live'
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-amber-500/15 text-amber-400'
                        }`}
                    >
                        {data.dataSource === 'live' ? '● LIVE MULTI-MODEL' : '○ GRID ESTIMATE'}
                    </span>
                    {data.modelsUsed.map((model) => {
                        const colorMap: Record<string, string> = {
                            GFS: '#38bdf8',
                            ECMWF: '#a78bfa',
                            ICON: '#34d399',
                            GEM: '#fb923c',
                        };
                        return (
                            <div key={model} className="flex items-center gap-1">
                                <div
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: colorMap[model] || '#888' }}
                                />
                                <span className="text-[11px] font-bold text-gray-400">{model}</span>
                            </div>
                        );
                    })}
                </div>

                {/* Summary stats */}
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                        <span className="text-[11px] font-bold text-gray-500 uppercase">Avg Spread</span>
                        <span className="text-[11px] font-black text-white tabular-nums">
                            {data.summary.avgSpreadKts} kts
                        </span>
                    </div>
                    {data.summary.lowConfidenceCount > 0 && (
                        <div className="flex items-center gap-1">
                            <span className="text-[11px] font-bold text-amber-500 uppercase">⚠ Low Conf</span>
                            <span className="text-[11px] font-black text-amber-400 tabular-nums">
                                {data.summary.lowConfidenceCount}
                            </span>
                        </div>
                    )}
                    {data.summary.comfortBreachCount > 0 && (
                        <div className="flex items-center gap-1">
                            <span className="text-[11px] font-bold text-red-500 uppercase">🚫 No-Go</span>
                            <span className="text-[11px] font-black text-red-400 tabular-nums">
                                {data.summary.comfortBreachCount}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Scrollable rows */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
                {/* Scale header */}
                <div className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-sm px-4 py-1.5 border-b border-white/[0.06]">
                    <div className="flex justify-between text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                        <span>0 kts</span>
                        <span>10</span>
                        <span>20</span>
                        <span>30</span>
                        <span>40</span>
                        <span>50</span>
                    </div>
                </div>

                {data.rows.map((row, i) => (
                    <div
                        key={i}
                        ref={(el) => {
                            if (el) rowRefs.current.set(i, el);
                            else rowRefs.current.delete(i);
                        }}
                    >
                        <ConsensusRowView row={row} />
                    </div>
                ))}

                {/* Bottom padding */}
                <div className="h-20" />
            </div>
        </div>
    );
};
