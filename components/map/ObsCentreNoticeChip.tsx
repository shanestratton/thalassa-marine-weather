/**
 * ObsCentreNoticeChip — the one calm line Obs shows when what the location
 * box follows has no live fix (Shane 2026-10-06: "If there is no gps from
 * their phone then the last known location with a clear message telling them
 * that").
 *
 * Centred under the top row (zoom readout, base picker, mic/status pair),
 * inside the right rail's gutter, so it covers neither the controls nor the
 * vessel at the centre of the chart, nor the wind loading pill there; under
 * the threat banner or the live-tide badge while those show; under the
 * "Whole route" button while that shows (its wrapped lines reached it). A
 * status line, not a toast: it stays until a live fix arrives
 * (useObsCentreNoticeWatch) or the skipper dismisses it. The live region is
 * always mounted, off Obs too (empty there), so a message still standing is
 * spoken when Obs shows again.
 */
import React, { useEffect, useState } from 'react';
import { clearObsCentreNotice, obsCentreNoticeText, useObsCentreNotice, type ObsBoatNames } from './obsCentre';

/** The age in the line is re-read this often. */
const AGE_REFRESH_MS = 60_000;

/**
 * The centred slot's top while a banner holds the centre of the top row:
 * ThreatBanner (fixed at max(58px, safe top + 56 px), two short lines, about
 * 52 px) and the live-tide badge (64 px from the top, no inset, about 42 px).
 */
const BELOW_THREAT_TOP = 'calc(max(58px, env(safe-area-inset-top) + 56px) + 60px)';
const BELOW_TIDE_TOP = '116px';
const DEFAULT_TOP = 'calc(env(safe-area-inset-top) + 64px)';

/**
 * The centred slot's top while the threat banner or the live-tide badge
 * shows, else undefined (the class's safe top + 64 px stands). The lowered
 * slot, under Whole route at safe top + 164 px, is already below both.
 */
export function obsNoticeStackedTop(
    belowRouteButton: boolean,
    belowThreatBanner: boolean,
    belowTideBadge: boolean,
): string | undefined {
    if (belowRouteButton || !(belowThreatBanner || belowTideBadge)) return undefined;
    const tops = [DEFAULT_TOP];
    if (belowThreatBanner) tops.push(BELOW_THREAT_TOP);
    if (belowTideBadge) tops.push(BELOW_TIDE_TOP);
    return `max(${tops.join(', ')})`;
}

interface ObsCentreNoticeChipProps {
    visible: boolean;
    names: ObsBoatNames;
    /** MapHub's "Whole route" button (safe top + 112 px, left) is showing: sit below it. */
    belowRouteButton?: boolean;
    /** The threat banner is showing at the top centre: sit below it. */
    belowThreatBanner?: boolean;
    /** The live-tide badge is showing at the top centre: sit below it. */
    belowTideBadge?: boolean;
}

export const ObsCentreNoticeChip: React.FC<ObsCentreNoticeChipProps> = ({
    visible,
    names,
    belowRouteButton = false,
    belowThreatBanner = false,
    belowTideBadge = false,
}) => {
    const notice = useObsCentreNotice();
    const [now, setNow] = useState(() => Date.now());
    const showing = visible && notice !== null;
    useEffect(() => {
        if (!showing) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS);
        return () => clearInterval(timer);
    }, [showing, notice?.id]);

    const text = showing ? obsCentreNoticeText(notice, names, now) : '';
    // Inline, so the stacked tops need no generated class.
    const stackedTop = obsNoticeStackedTop(belowRouteButton, belowThreatBanner, belowTideBadge);
    return (
        // Centred under the 48 px top row (safe top + 8 px), clear of the
        // 48 px right rail and its 16 px gutter on both sides: 176 px for the
        // line on a 320 px phone. While the Whole route button shows (left,
        // safe top + 112 px, 44 px) it sits under that instead, in the free
        // left column, still clear of the rail: 232 px on a 320 px phone,
        // three lines that end above the vessel at the chart's centre.
        <div
            className={`thalassa-obs-centre-notice pointer-events-none absolute z-705 flex ${
                belowRouteButton
                    ? 'left-4 right-[72px] top-[calc(env(safe-area-inset-top)+164px)] max-w-[360px] justify-start'
                    : 'left-1/2 top-[calc(env(safe-area-inset-top)+64px)] w-[min(360px,calc(100%-144px))] -translate-x-1/2 justify-center'
            }`}
            style={showing && stackedTop ? { top: stackedTop } : undefined}
        >
            <div
                className={
                    showing
                        ? 'pointer-events-auto flex max-w-full items-center gap-1 rounded-2xl border py-1 pl-3 pr-1 shadow-2xl backdrop-blur-xl'
                        : 'contents'
                }
                style={
                    showing
                        ? {
                              background: 'var(--day-ui-amber-surface, rgba(69, 51, 8, 0.92))',
                              borderColor: 'rgba(251, 191, 36, 0.45)',
                              color: 'var(--day-ui-amber, #fcd34d)',
                          }
                        : undefined
                }
            >
                <p
                    role="status"
                    aria-live="polite"
                    className={showing ? 'min-w-0 py-1.5 text-[12px] font-bold leading-4 wrap-break-word' : 'sr-only'}
                >
                    {text}
                </p>
                {showing && (
                    <button
                        type="button"
                        aria-label="Dismiss position message"
                        onClick={() => clearObsCentreNotice(notice.id)}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl opacity-80 hover:opacity-100 active:scale-95"
                    >
                        <svg
                            aria-hidden="true"
                            className="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                            strokeLinecap="round"
                        >
                            <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
};
