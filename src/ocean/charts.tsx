/**
 * Small hand-written SVG charts for the species sheet (no chart library: the
 * whole page has to fit the app's bundle budget). Each is role="img" with a
 * label that says what it shows, plus a text summary for screen readers.
 */
import type { Histogram } from './oceanApi';
import { MONTHS_FULL, MONTHS_SHORT, fmt } from './format';

const peakIndex = (values: readonly number[]) => values.reduce((best, v, i) => (v > values[best] ? i : best), 0);

export function SeasonClock({ values, colour, label }: { values: readonly number[]; colour: string; label: string }) {
    const max = Math.max(0, ...values);
    const cx = 110;
    const cy = 110;
    const r0 = 34;
    const r1 = 90;
    const at = (a: number, r: number) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    const peak = max > 0 ? peakIndex(values) : -1;
    const summary =
        max > 0
            ? `${label}: most in ${MONTHS_FULL[peak]}. ${values.map((v, i) => `${MONTHS_SHORT[i]} ${fmt(v)}`).join(', ')}.`
            : `${label}: nothing yet.`;
    return (
        <svg viewBox="0 0 220 220" role="img" aria-label={summary} className="oc-chart">
            <circle cx={cx} cy={cy} r={r1} className="oc-chart-rule" fill="none" />
            <circle cx={cx} cy={cy} r={r0} className="oc-chart-rule" fill="none" />
            {values.map((v, i) => {
                const a0 = (i / 12) * Math.PI * 2 - Math.PI / 2 + 0.03;
                const a1 = ((i + 1) / 12) * Math.PI * 2 - Math.PI / 2 - 0.03;
                const am = ((i + 0.5) / 12) * Math.PI * 2 - Math.PI / 2;
                const rr = max > 0 ? r0 + ((r1 - r0) * v) / max : r0;
                return (
                    <g key={i}>
                        {v > 0 && (
                            <path
                                d={`M${at(a0, r0)} L${at(a0, rr)} A${rr} ${rr} 0 0 1 ${at(a1, rr)} L${at(a1, r0)} A${r0} ${r0} 0 0 0 ${at(a0, r0)}Z`}
                                fill={colour}
                                fillOpacity={0.35 + (0.6 * v) / max}
                            />
                        )}
                        <text
                            x={(cx + (r1 + 11) * Math.cos(am)).toFixed(1)}
                            y={(cy + (r1 + 11) * Math.sin(am)).toFixed(1)}
                            className="oc-chart-tick"
                            textAnchor="middle"
                            dominantBaseline="middle"
                        >
                            {MONTHS_SHORT[i][0]}
                        </text>
                    </g>
                );
            })}
            <text x={cx} y={cy - 3} className="oc-chart-centre" textAnchor="middle">
                {peak >= 0 ? MONTHS_SHORT[peak] : '–'}
            </text>
            <text x={cx} y={cy + 13} className="oc-chart-tick" textAnchor="middle">
                {peak >= 0 ? 'peak' : 'no data'}
            </text>
        </svg>
    );
}

/** Bars over integer bins (hours 0..23, or 1 °C sea-temperature bins). */
export function BinBars({
    hist,
    from,
    to,
    colour,
    name,
    tickEvery,
    label,
}: {
    hist: Histogram;
    from: number;
    to: number;
    colour: string;
    name: (bin: number) => string;
    tickEvery: number;
    label: string;
}) {
    const bins = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const values = bins.map((b) => hist[b] ?? 0);
    const max = Math.max(1, ...values);
    const w = 220;
    const h = 120;
    const bw = (w - 20) / bins.length;
    const parts = bins.flatMap((b, i) => (values[i] > 0 ? [`${name(b)}: ${fmt(values[i])}`] : []));
    return (
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}. ${parts.join(', ')}.`} className="oc-chart">
            {bins.map((b, i) => {
                const bh = ((h - 30) * values[i]) / max;
                return (
                    <g key={b}>
                        {values[i] > 0 && (
                            <rect
                                x={(10 + i * bw + 1).toFixed(1)}
                                y={(h - 18 - bh).toFixed(1)}
                                width={Math.max(1, bw - 2).toFixed(1)}
                                height={bh.toFixed(1)}
                                rx={2}
                                fill={colour}
                                fillOpacity={0.85}
                            />
                        )}
                        {(b - from) % tickEvery === 0 && (
                            <text
                                x={(10 + (i + 0.5) * bw).toFixed(1)}
                                y={h - 4}
                                className="oc-chart-tick"
                                textAnchor="middle"
                            >
                                {name(b)}
                            </text>
                        )}
                    </g>
                );
            })}
            <line x1={10} x2={w - 10} y1={h - 18} y2={h - 18} className="oc-chart-rule" />
        </svg>
    );
}

export const monthsFrom = (hist: Histogram): number[] => MONTHS_SHORT.map((_, i) => hist[i + 1] ?? 0);
