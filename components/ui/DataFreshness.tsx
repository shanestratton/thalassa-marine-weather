/**
 * DataFreshness — universal "Updated Xm ago" pill + retry CTA.
 *
 * Why this exists
 * ---------------
 * The scorecard audit on 2026-05-17 flagged error/offline handling
 * as the single biggest UX deduction. The app fetches weather, log
 * data, vessel state, etc. — but never tells the user when each
 * data surface was last refreshed, and never offers an obvious
 * retry path when a fetch fails. PredictWind and Windy both make
 * the freshness signal a permanent fixture on every data screen;
 * Thalassa was just rendering whatever was in state and trusting
 * the auto-refresh to catch up.
 *
 * This component is the single reusable surface for both signals:
 *
 *   ┌─────────────────────────────────────────┐
 *   │   Updated 12m ago          🔄 Refresh    │   (FRESH / IDLE)
 *   └─────────────────────────────────────────┘
 *
 *   ┌─────────────────────────────────────────┐
 *   │ ⚠ Stale — last fetch 2h ago   ↻ Retry   │   (STALE)
 *   └─────────────────────────────────────────┘
 *
 *   ┌─────────────────────────────────────────┐
 *   │ ⚠ Failed to refresh           ↻ Retry   │   (ERROR)
 *   └─────────────────────────────────────────┘
 *
 *   ┌─────────────────────────────────────────┐
 *   │ ⟳ Refreshing…                            │   (LOADING)
 *   └─────────────────────────────────────────┘
 *
 * The component is dumb on purpose — caller passes the four state
 * inputs (lastUpdatedAt, isLoading, isStale, error) and the
 * onRefresh callback. No data coupling, no context dependency,
 * works on any surface that exposes those four signals.
 */

import React, { useEffect, useState } from 'react';
import { triggerHaptic } from '../../utils/system';

/** Format a millisecond delta as a compact, marine-friendly age. */
function formatAge(ageMs: number): string {
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

interface DataFreshnessProps {
    /**
     * When the data was last successfully fetched. Pass an ISO
     * string (e.g. `weatherData.generatedAt`) or null if there's
     * no successful fetch yet.
     */
    lastUpdatedAt?: string | number | null;
    /** True while a fetch is in flight. Drives the spinner. */
    isLoading?: boolean;
    /**
     * True if data is older than the surface considers acceptable
     * (e.g. weather older than 30 min). The component visualises
     * but doesn't decide — the caller's domain logic does.
     */
    isStale?: boolean;
    /** Error message from the last fetch attempt, if any. */
    error?: string | null;
    /** Called when the user taps the retry / refresh button. */
    onRefresh: () => void | Promise<void>;
    /**
     * Compact mode — single-line pill suitable for header
     * placement. Default. The wider mode (`compact={false}`) shows
     * an explicit "Last updated" prefix + larger CTA.
     */
    compact?: boolean;
    /**
     * Optional aria-label override for the refresh button. Default
     * adapts to state (Retry / Refresh / Refreshing).
     */
    refreshLabel?: string;
    /**
     * Test hook — override Date.now() for unit tests that need
     * deterministic age calculation.
     */
    nowProvider?: () => number;
}

/**
 * Render the freshness pill. Re-renders itself every 30 s while
 * mounted so the "X minutes ago" label keeps ticking without the
 * parent having to re-render.
 */
export const DataFreshness: React.FC<DataFreshnessProps> = ({
    lastUpdatedAt,
    isLoading = false,
    isStale = false,
    error = null,
    onRefresh,
    compact = true,
    refreshLabel,
    nowProvider = Date.now,
}) => {
    // Self-ticking clock — 30 s cadence is plenty for "12m ago"
    // precision without burning CPU. Cleaned up on unmount.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 30_000);
        return () => clearInterval(id);
    }, []);

    // Decide the visual state. ERROR > LOADING > STALE > IDLE.
    const ts =
        typeof lastUpdatedAt === 'string'
            ? new Date(lastUpdatedAt).getTime()
            : typeof lastUpdatedAt === 'number'
              ? lastUpdatedAt
              : null;
    const ageMs = ts !== null && !isNaN(ts) ? nowProvider() - ts : null;

    let mode: 'error' | 'loading' | 'stale' | 'fresh' = 'fresh';
    if (error) mode = 'error';
    else if (isLoading) mode = 'loading';
    else if (isStale) mode = 'stale';

    // Colour tokens per mode. All transparent over the underlying
    // surface so the pill blends with whatever it's pinned to.
    const tone =
        mode === 'error'
            ? { bg: 'bg-red-500/[0.08]', border: 'border-red-500/30', text: 'text-red-300' }
            : mode === 'stale'
              ? { bg: 'bg-amber-500/[0.08]', border: 'border-amber-500/30', text: 'text-amber-300' }
              : mode === 'loading'
                ? { bg: 'bg-sky-500/[0.06]', border: 'border-sky-500/25', text: 'text-sky-300' }
                : { bg: 'bg-white/[0.03]', border: 'border-white/[0.06]', text: 'text-slate-400' };

    const label =
        mode === 'error'
            ? error || 'Failed to refresh'
            : mode === 'loading'
              ? 'Refreshing…'
              : mode === 'stale'
                ? `Stale — ${ageMs !== null ? formatAge(ageMs) : 'unknown age'}`
                : ageMs !== null
                  ? `Updated ${formatAge(ageMs)}`
                  : 'No data yet';

    const ctaLabel = refreshLabel ?? (mode === 'fresh' ? 'Refresh' : mode === 'loading' ? 'Refreshing' : 'Retry');

    const handleClick = () => {
        if (isLoading) return; // debounce — no double-fires
        triggerHaptic('light');
        void onRefresh();
    };

    return (
        <div
            role="status"
            aria-live="polite"
            className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full border ${tone.bg} ${tone.border} ${
                compact ? 'text-[11px]' : 'text-[12px]'
            }`}
        >
            {/* Status dot — solid in error/stale, animated in loading,
                subtle hollow in fresh. The dot itself is the visual
                grammar that ties this component to the rest of the
                Thalassa status-pill language (StatusBadges, etc.). */}
            <span
                aria-hidden="true"
                className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                    mode === 'error'
                        ? 'bg-red-400'
                        : mode === 'stale'
                          ? 'bg-amber-400'
                          : mode === 'loading'
                            ? 'bg-sky-400 animate-pulse'
                            : 'bg-emerald-500/70'
                }`}
            />
            <span className={`font-semibold tracking-wide ${tone.text} whitespace-nowrap`}>{label}</span>
            <button
                type="button"
                onClick={handleClick}
                disabled={isLoading}
                aria-label={`${ctaLabel} data`}
                className={`shrink-0 ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest transition-colors ${
                    mode === 'error' || mode === 'stale'
                        ? 'bg-white/10 hover:bg-white/15 text-white'
                        : 'text-slate-400 hover:text-white hover:bg-white/5'
                } ${isLoading ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}
            >
                {/* Inline refresh glyph — circular arrow. Animates
                    on loading state. */}
                <svg
                    className={`inline-block w-3 h-3 -mt-px mr-0.5 ${isLoading ? 'animate-spin' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4 4v5h.582m15.836 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                </svg>
                {ctaLabel}
            </button>
        </div>
    );
};
