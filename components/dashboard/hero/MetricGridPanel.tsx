/**
 * hero/MetricGridPanel — Reusable 2×3 metric grid for HeroSlide cards
 *
 * Renders a 2-row × 3-column grid of weather metrics (e.g. offshore or inland).
 * Extracted from HeroSlide.tsx to reduce monolith size.
 */

import React from 'react';

export interface MetricWidget {
    id: string;
    label: string;
    icon: React.ReactNode;
    headingColor: string;
    labelColor: string;
    dirDeg?: number | null; // Optional direction arrow (degrees)
}

interface MetricGridPanelProps {
    widgets: MetricWidget[];
    getValue: (id: string) => string | number;
    getUnit: (id: string) => string;
}

// Small directional arrow for swell/current cells
const SmallArrow: React.FC<{ degrees: number; size?: number }> = ({ degrees, size = 12 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="shrink-0 opacity-70"
        style={{ transform: `rotate(${degrees}deg)`, transition: 'transform 1s ease' }}
    >
        <path d="M12 2L8 14h8L12 2Z" fill="rgba(94,234,212,0.7)" />
        <path d="M12 22L8 14h8L12 22Z" fill="rgba(148,163,184,0.25)" />
    </svg>
);

const MetricCell: React.FC<{ w: MetricWidget; value: string | number; unit: string }> = ({ w, value, unit }) => (
    <div className="flex flex-col items-center justify-center h-full py-2 px-1 gap-1">
        <div className="flex items-center gap-1.5 opacity-90">
            <span className={`w-3 h-3 ${w.headingColor}`}>{w.icon}</span>
            <span className={`text-[11px] font-sans font-bold tracking-widest uppercase ${w.labelColor}`}>
                {w.label}
            </span>
        </div>
        <div className="flex items-baseline gap-0.5">
            {w.dirDeg !== undefined && w.dirDeg !== null && <SmallArrow degrees={w.dirDeg} />}
            <span
                className="text-[26px] font-mono font-medium tracking-tight text-ivory drop-shadow-md"
                style={{ fontFeatureSettings: '"tnum"' }}
            >
                {value}
            </span>
            {unit && (
                <span className="text-[11px] font-sans text-slate-400 font-medium ml-1 self-end mb-1.5">{unit}</span>
            )}
        </div>
    </div>
);

/**
 * Renders a 2×3 grid of metric cells with dividers.
 * Used by HeroSlide for the secondary metrics panel in forecast cards.
 */
export const MetricGridPanel: React.FC<MetricGridPanelProps> = ({ widgets, getValue, getUnit }) => {
    const topRow = widgets.slice(0, 3);
    const bottomRow = widgets.slice(3, 6);

    return (
        <>
            {/* TOP ROW */}
            <div className="w-full grid grid-cols-3 divide-x divide-white/[0.12] flex-1 min-h-0">
                {topRow.map((w) => (
                    <MetricCell key={w.id} w={w} value={getValue(w.id)} unit={getUnit(w.id)} />
                ))}
            </div>

            {/* Horizontal divider */}
            <div className="w-full h-px bg-white/[0.12] shrink-0" />

            {/* BOTTOM ROW */}
            <div className="w-full grid grid-cols-3 divide-x divide-white/[0.12] flex-1 min-h-0">
                {bottomRow.map((w) => (
                    <MetricCell key={w.id} w={w} value={getValue(w.id)} unit={getUnit(w.id)} />
                ))}
            </div>
        </>
    );
};

export default MetricGridPanel;
