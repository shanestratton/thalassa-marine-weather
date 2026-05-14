import React from 'react';

/**
 * Compact instrument dials for the Voyage Log telemetry panel — scaled-down
 * cousins of Thalassa's ArcGauge / CompassGauge, sized to sit in the sidebar.
 */

// ── Shared geometry ────────────────────────────────────────────
const polar = (cx: number, cy: number, r: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};
const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number): string => {
    const s = polar(cx, cy, r, a0);
    const e = polar(cx, cy, r, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
};

const DialFrame: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex flex-col items-center gap-0.5">
        <svg viewBox="0 0 88 88" className="w-[66px] h-[66px]">
            {children}
        </svg>
        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.15em]">{label}</span>
    </div>
);

// ── ArcDial — 240° speed-style gauge ───────────────────────────
const ARC_START = 150;
const ARC_SWEEP = 240;

export const ArcDial: React.FC<{
    value: number | null;
    max: number;
    unit: string;
    label: string;
    accent: string;
}> = ({ value, max, unit, label, accent }) => {
    const cx = 44;
    const cy = 46;
    const r = 33;
    const live = value != null;
    const frac = live ? Math.max(0, Math.min(1, value / max)) : 0;
    return (
        <DialFrame label={label}>
            <path
                d={arcPath(cx, cy, r, ARC_START, ARC_START + ARC_SWEEP)}
                fill="none"
                stroke="rgba(255,255,255,0.1)"
                strokeWidth="6"
                strokeLinecap="round"
            />
            {live && frac > 0.01 && (
                <path
                    d={arcPath(cx, cy, r, ARC_START, ARC_START + frac * ARC_SWEEP)}
                    fill="none"
                    stroke={accent}
                    strokeWidth="6"
                    strokeLinecap="round"
                />
            )}
            <text
                x={cx}
                y={cy + 1}
                textAnchor="middle"
                fill="#fff"
                fontSize="19"
                fontWeight="800"
                fontFamily="ui-monospace, monospace"
            >
                {live ? (Number.isInteger(value) ? value : value.toFixed(1)) : '--'}
            </text>
            <text x={cx} y={cy + 12} textAnchor="middle" fill="#94a3b8" fontSize="7" fontWeight="700">
                {unit}
            </text>
        </DialFrame>
    );
};

// ── CompassDial — bearing needle on a rose ─────────────────────
export const CompassDial: React.FC<{ value: number | null; label: string; accent: string }> = ({
    value,
    label,
    accent,
}) => {
    const cx = 44;
    const cy = 40;
    const r = 32;
    const live = value != null;
    return (
        <DialFrame label={label}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
            {[0, 90, 180, 270].map((d) => {
                const o = polar(cx, cy, r, d);
                const i = polar(cx, cy, r - 5, d);
                return (
                    <line
                        key={d}
                        x1={i.x}
                        y1={i.y}
                        x2={o.x}
                        y2={o.y}
                        stroke={d === 0 ? '#f87171' : 'rgba(255,255,255,0.4)'}
                        strokeWidth="1.5"
                    />
                );
            })}
            {live && (
                <g transform={`rotate(${value} ${cx} ${cy})`}>
                    <polygon points={`${cx},${cy - r + 3} ${cx - 3.5},${cy} ${cx + 3.5},${cy}`} fill={accent} />
                    <polygon
                        points={`${cx},${cy + r - 9} ${cx - 3},${cy} ${cx + 3},${cy}`}
                        fill="rgba(255,255,255,0.22)"
                    />
                </g>
            )}
            <circle cx={cx} cy={cy} r="2.5" fill="#0f172a" stroke={accent} strokeWidth="1" />
            <text
                x={cx}
                y={cy + r + 12}
                textAnchor="middle"
                fill="#fff"
                fontSize="14"
                fontWeight="800"
                fontFamily="ui-monospace, monospace"
            >
                {live ? `${Math.round(value)}°` : '--'}
            </text>
        </DialFrame>
    );
};

// ── WindDial — apparent wind arrow + speed in the hub ──────────
export const WindDial: React.FC<{
    awa: number | null;
    aws: number | null;
    label: string;
    accent: string;
}> = ({ awa, aws, label, accent }) => {
    const cx = 44;
    const cy = 44;
    const r = 32;
    const haveAngle = awa != null;
    return (
        <DialFrame label={label}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
            {/* Bow marker at top */}
            <polygon
                points={`${cx},${cy - r - 2} ${cx - 3},${cy - r + 4} ${cx + 3},${cy - r + 4}`}
                fill="rgba(255,255,255,0.55)"
            />
            {[90, 180, 270].map((d) => {
                const o = polar(cx, cy, r, d);
                const i = polar(cx, cy, r - 4, d);
                return (
                    <line key={d} x1={i.x} y1={i.y} x2={o.x} y2={o.y} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
                );
            })}
            {/* Apparent wind arrow — points from where the wind blows */}
            {haveAngle && (
                <g transform={`rotate(${awa} ${cx} ${cy})`}>
                    <line
                        x1={cx}
                        y1={cy - r + 4}
                        x2={cx}
                        y2={cy + 5}
                        stroke={accent}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                    />
                    <polygon points={`${cx},${cy + 9} ${cx - 4},${cy + 1} ${cx + 4},${cy + 1}`} fill={accent} />
                </g>
            )}
            <circle cx={cx} cy={cy} r="9.5" fill="#0f172a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
            <text
                x={cx}
                y={cy + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#fff"
                fontSize="12"
                fontWeight="800"
                fontFamily="ui-monospace, monospace"
            >
                {aws != null ? Math.round(aws) : '--'}
            </text>
        </DialFrame>
    );
};
