/**
 * NmeaRateSparkline — diagnostic strip showing per-sentence arrival rate
 * for the System Status modal.
 *
 * Built specifically to answer "is my GPS feed actually steady or is it
 * pulsing?" The 5-second NmeaStore aggregation hides this; the
 * NmeaRateTracker preserves raw timestamps so we can show the truth.
 *
 * Visual design:
 *   - 30 buckets × 10 seconds = 5 minutes of history
 *   - Bar height = # of sentences in that 10s window
 *   - Colour-coded by *consistency*, not just absolute rate:
 *       green  → steady, healthy feed (CV < 0.3 over the window)
 *       amber  → bursty / inconsistent (CV 0.3-0.6)
 *       red    → very gappy or near-zero (CV > 0.6 OR rate < 0.3 sentences/sec)
 *   - "Now" label on the right edge
 *   - Headline: current 60-second rate + total sentences in window
 *
 * Accepts a `category` prop ('gps' or 'all') so the same component can be
 * reused for "GPS arrival rate" and "all NMEA rate".
 */
import React, { useEffect, useState, useMemo } from 'react';
import { NmeaRateTracker } from '../services/NmeaRateTracker';

interface NmeaRateSparklineProps {
    category: 'gps' | 'all';
    label: string;
    /** Bucket width in seconds (default 10s — gives 30 buckets across 5 min). */
    bucketSec?: number;
    /** Number of buckets to show (default 30 = 5 min). */
    bucketCount?: number;
    /** Expected steady rate, in sentences/sec, used for the colour heuristic.
     *  GPS at 1 Hz = 1.0, full N0183 backbone often 5-15. */
    expectedRate?: number;
}

export const NmeaRateSparkline: React.FC<NmeaRateSparklineProps> = ({
    category,
    label,
    bucketSec = 10,
    bucketCount = 30,
    expectedRate = 1.0,
}) => {
    // Re-render when the tracker reports new data (throttled to ~4 Hz inside
    // the tracker so we're not slamming React).
    const [, setTick] = useState(0);
    useEffect(() => {
        const unsub = NmeaRateTracker.subscribe(() => setTick((t) => t + 1));
        // Also refresh on a 1s timer so the chart still scrolls when there's
        // no data arriving (so the "no data" state shows up properly instead
        // of stale-rendering forever).
        const interval = setInterval(() => setTick((t) => t + 1), 1000);
        return () => {
            unsub();
            clearInterval(interval);
        };
    }, []);

    const { buckets, currentRate, total, consistency } = useMemo(() => {
        const b = NmeaRateTracker.getBuckets(category, bucketSec * 1000, bucketCount);
        const r = NmeaRateTracker.getRate(category, 60);
        const t = b.reduce((sum, n) => sum + n, 0);
        // Coefficient of variation across non-zero buckets (skip the leading
        // zero buckets that just mean "we just installed and have no history
        // yet"). If everything is zero we report consistency 0 → red.
        const nonZero = b.filter((n) => n > 0);
        let cv = 0;
        if (nonZero.length > 1) {
            const mean = nonZero.reduce((s, n) => s + n, 0) / nonZero.length;
            const variance = nonZero.reduce((s, n) => s + (n - mean) ** 2, 0) / nonZero.length;
            cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
        }
        return { buckets: b, currentRate: r, total: t, consistency: cv };
    }, [category, bucketSec, bucketCount]);

    // Health heuristic — drives the bar tint and the headline number colour
    const isHealthy = currentRate >= expectedRate * 0.7 && consistency < 0.3;
    const isAlarming = currentRate < expectedRate * 0.3 || consistency > 0.6;
    const tint = isAlarming
        ? { bar: '#ef4444', text: 'text-red-300', dot: 'bg-red-400' }
        : isHealthy
          ? { bar: '#34d399', text: 'text-emerald-300', dot: 'bg-emerald-400' }
          : { bar: '#f59e0b', text: 'text-amber-300', dot: 'bg-amber-400' };

    // Max bar height for normalisation — use the actual peak so the chart
    // self-scales, with a floor at expectedRate * bucketSec * 1.5 so a steady
    // 1 Hz GPS doesn't render as visually maxed-out (= "everything is fine"
    // signal would look identical to "wildly bursting" otherwise).
    const peak = Math.max(...buckets, expectedRate * bucketSec * 1.5);

    const totalSpanMin = (bucketSec * bucketCount) / 60;

    return (
        <div className="rounded-lg border border-white/[0.08] bg-black/30 p-2">
            {/* Header row — label + headline rate */}
            <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${tint.dot}`} />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/60">{label}</span>
                </div>
                <span className={`text-[11px] font-mono font-bold ${tint.text}`}>
                    {currentRate.toFixed(1)} <span className="text-white/40">/sec</span>
                </span>
            </div>

            {/* Sparkline — SVG so the bars stay crisp */}
            <svg className="w-full h-[28px]" viewBox={`0 0 ${bucketCount * 4} 28`} preserveAspectRatio="none">
                {buckets.map((count, i) => {
                    const h = peak > 0 ? Math.max((count / peak) * 24, count > 0 ? 2 : 0) : 0;
                    return (
                        <rect
                            key={i}
                            x={i * 4}
                            y={28 - h}
                            width={3}
                            height={h}
                            fill={count > 0 ? tint.bar : 'rgba(255,255,255,0.05)'}
                            rx={0.6}
                        />
                    );
                })}
            </svg>

            {/* Footer row — total + window + 'now' label */}
            <div className="flex items-center justify-between mt-1 text-[9px] text-white/40 uppercase tracking-wider font-medium">
                <span>
                    {total} in last {totalSpanMin.toFixed(0)}m
                </span>
                <span>now →</span>
            </div>
        </div>
    );
};

NmeaRateSparkline.displayName = 'NmeaRateSparkline';
