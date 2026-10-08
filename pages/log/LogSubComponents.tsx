/**
 * Log Page Sub-Components
 *
 * Extracted from LogPage.tsx — VoyageCard, FollowRouteButton, MenuBtn, StatBox.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ShipLogEntry } from '../../types';
import { formatVoyageDuration, voyageElapsedMs } from '../../utils/voyageTiming';
import { isLandVoyage, type VoyageSummary } from '../../services/shiplog/VoyageSummary';
import { classifyCompletedVoyage } from '../../utils/passageClass';
import { useFollowRoute } from '../../context/FollowRouteContext';
import { useEndpointNames } from './useEndpointNames';
import { useToast } from '../../components/Toast';
import { publishFollowedRouteDetailed } from '../../services/shiplog/publishFollowedRoute';
import { VoyageLogService } from '../../services/VoyageLogService';
import { DateGroupedTimeline } from '../../components/DateGroupedTimeline';
import { LiveMiniMap } from '../../components/LiveMiniMap';
import {
    groupEntriesByDate,
    groupEntriesByNoonWindow,
    computePropulsionSplit,
    shouldShowDayRuns,
    dayRunLabel,
} from '../../utils/voyageData';
import { createLogger } from '../../utils/createLogger';
import { usePersistedState } from '../../hooks/usePersistedState';
import { traceCheckDayLabel, type TraceFollowStatus } from '../../services/traceVerification';
import { TRACE_ROUTE_USE_BLOCK_PREFIX } from './logPageTypes';

const log = createLogger('LogPage');

export const StatBox: React.FC<{ label: string; value: string | number }> = React.memo(({ label, value }) => (
    <div className="bg-white/3 border border-white/6 rounded-2xl p-3 text-center">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">{label}</div>
        <div className="text-xl font-bold text-white tabular-nums">{value}</div>
    </div>
));

// ── MenuBtn — one row of the Log actions dialog ──
//
// A plain button, not role="menuitem": the Log kebab opens the same titled
// dialog as the Route Planner's (UX audit run 5). Disabled rows keep a legible
// label (no opacity fade — the old slate-500 at 40% measured ~2.95:1 and read
// as "broken") that is still visibly dimmer than an enabled row. The ink is
// the `ui-disabled-ink` token (styles/legibility.css), not slate-400: the
// app-wide caption lift turns slate-400 into the same ink as the enabled
// rows' slate-200, so four waiting rows looked tappable and did nothing (UX
// scorecard run 9). The reason line above the rows says why they wait. The
// trailing clock went: it read as "history" or "scheduled", not "not yet"
// (run 7). Not a lock either: the app's lock means "pay to unlock" (run 6).

export const MenuBtn: React.FC<{
    /** Glyph shown before the label — the app's stroke SVG icons, not emoji. */
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    accent?: boolean;
    /** Id of the line that says why a disabled row is waiting. */
    describedBy?: string;
}> = React.memo(({ icon, label, onClick, disabled, danger, accent, describedBy }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-describedby={describedBy}
        className={`w-full min-h-[44px] rounded-xl px-4 py-3 text-left text-sm font-medium flex items-center gap-3 transition-colors ${
            disabled
                ? 'ui-disabled-ink cursor-not-allowed'
                : danger
                  ? 'text-red-400 hover:bg-red-500/10'
                  : accent
                    ? 'text-amber-400 hover:bg-amber-500/10'
                    : 'text-slate-200 hover:bg-white/5'
        }`}
    >
        <span
            className={`w-5 h-5 flex items-center justify-center shrink-0 ${disabled ? 'opacity-40' : ''}`}
            aria-hidden="true"
        >
            {icon}
        </span>
        {label}
    </button>
));

// ── FollowRouteChoice — one row of the cast-off "Following a route?" sheet ──
//
// A row per planned route. Every row used to read "🧭 Suggested route", so the
// sheet asked the skipper to pick between rows that were word-for-word
// identical, distinguishable only by distance (Shane 2026-07-19: "the heading
// on all of the routes is the same... they should really be the name of the
// route"). It names each route by its endpoints, via the same hook the voyage
// cards use — so the row and the card agree about what a route is called.
//
// A component rather than inline JSX because each row needs its own lookup,
// and hooks cannot run inside a .map() callback.
export const FollowRouteChoice: React.FC<{
    summary: VoyageSummary;
    /** This route has a saved reverse, collapsed into this row. */
    reversible?: boolean;
    /** The follow status (build 124; Shane 2026-10-08: "maybe just a warning
     *  rather than having to almost start again"). Five designs in two months:
     *  pick-then-refuse, hide-the-blocked, show-them-disabled, tap-to-fix, and
     *  now three states — green follows; AMBER follows too, with its reason on
     *  the row and a trailing Check now; RED (a real check's finding nobody
     *  acknowledged) takes two taps, like Sail. null = an ordinary plan. */
    followStatus?: TraceFollowStatus | null;
    /** A background check of this route is running. */
    checking?: boolean;
    /** "Checking… 12 of 41" — a cold check can run minutes on a passage. */
    checkingLabel?: string;
    onCheckNow?: () => void;
    onStopCheck?: () => void;
    /** Red and acknowledgeable here: opens the route report in place. */
    onReview?: () => void;
    /** Red and not acknowledgeable (land): the fix is an edit. */
    onFixInTracer?: () => void;
    loading?: boolean;
    disabled?: boolean;
    /** This route is a LEG of a passage, sitting under its heading. Marked by
     *  the dog-leg arrow alone — legs are flush, not indented (Shane
     *  2026-08-27). */
    isLeg?: boolean;
    /** Trailing "(2nd Leg)" paint, rendered OUTSIDE the truncating name span
     *  so a long name can never eat it — the saved-routes grammar rule. */
    legBadge?: string;
    /** The saved trace's display name (badge-stripped). Preferred over the
     *  geocoded endpoint guess: it is the name the PLAN library shows, so the
     *  two surfaces agree about what a route is called (Shane 2026-09-02). */
    savedName?: string;
    /** `acceptFinding` is true only for a red row's armed second tap. */
    onPick: (acceptFinding?: boolean) => void;
}> = ({
    summary,
    reversible = false,
    followStatus = null,
    checking = false,
    checkingLabel,
    onCheckNow,
    onStopCheck,
    onReview,
    onFixInTracer,
    loading = false,
    disabled = false,
    isLeg = false,
    legBadge,
    savedName,
    onPick,
}) => {
    const first = summary.firstLat != null ? { latitude: summary.firstLat, longitude: summary.firstLon } : undefined;
    const last = summary.lastLat != null ? { latitude: summary.lastLat, longitude: summary.lastLon } : undefined;
    const { startLabel, endLabel } = useEndpointNames(first, last);
    const tone = followStatus?.tone ?? null;
    const red = tone === 'finding';
    // Red: the first tap arms "Tap again to follow anyway" for 4 s — the
    // pattern Sail uses for a route with no-go legs (MapHub).
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 4_000);
        return () => clearTimeout(timer);
    }, [armed]);

    // The saved route's own name wins when it exists — endpoints are a guess
    // (two offshore fixes both geocoded to "Coral Sea" and collapsed to a
    // single word on the cast-off sheet, 2026-09-02). Round trips and
    // single-fix plans still collapse; "Suggested route" survives only as the
    // honest last resort when nothing resolved.
    const geocodedName =
        startLabel && endLabel && startLabel !== endLabel
            ? `${startLabel} → ${endLabel}`
            : (startLabel ?? endLabel ?? 'Suggested route');
    const routeName = savedName?.trim() || geocodedName;

    const trailing = red
        ? onReview
            ? { label: 'Review', onClick: onReview }
            : onFixInTracer
              ? { label: 'Fix in tracer', onClick: onFixInTracer }
              : null
        : tone === 'unchecked' && followStatus?.code !== 'nodraft'
          ? checking
              ? onStopCheck
                  ? { label: 'Stop', onClick: onStopCheck }
                  : null
              : onCheckNow
                ? { label: 'Check now', onClick: onCheckNow }
                : null
          : null;
    const detail = loading
        ? 'Loading route…'
        : `${summary.totalDistanceNM.toFixed(1)} NM · ${summary.entryCount} pts${
              tone === 'checked' && followStatus?.checkedAt
                  ? ` · checked ${traceCheckDayLabel(followStatus.checkedAt)}`
                  : ''
          }`;
    const note = tone === 'unchecked' && checking ? (checkingLabel ?? 'Checking…') : followStatus?.reason;

    return (
        <div
            data-follow-tone={tone ?? 'plain'}
            className={`flex w-full items-stretch rounded-xl border ${
                red
                    ? 'border-red-500/40 bg-red-500/8'
                    : tone === 'unchecked'
                      ? 'border-amber-500/25 bg-amber-500/6'
                      : 'border-white/10 bg-slate-800/60'
            }`}
        >
            <button
                type="button"
                onClick={() => {
                    if (red && !armed) {
                        setArmed(true);
                        return;
                    }
                    setArmed(false);
                    onPick(red ? true : undefined);
                }}
                // Only while another row is loading — a row is never a dead end.
                disabled={disabled}
                aria-busy={loading || checking}
                className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2 text-left active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
            >
                {/* The saved-routes grammar, shared with the Passage Planning
                    picker and the PLAN library (Shane 2026-08-30: "the gold
                    standard"). A pin for a day sail, the ↳ dog-leg for a leg
                    under its passage heading; the ⇄ badge sits OUTSIDE the
                    truncating span so a long name cannot eat it. */}
                <span aria-hidden="true" className="shrink-0 text-base leading-none">
                    {isLeg ? '↳' : '📍'}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5 text-[13px] font-bold text-gray-100">
                        <span className="min-w-0 truncate">{routeName}</span>
                        {legBadge && <span className="shrink-0">{legBadge}</span>}
                        {/* The return leg is a separate saved voyage, folded into
                            this row — marked, because a direction was chosen on
                            the skipper's behalf. */}
                        {reversible && (
                            <span
                                className="shrink-0 text-[11px] font-black text-gray-500"
                                title="Return leg also saved"
                            >
                                ⇄
                            </span>
                        )}
                    </span>
                    {/* Distance and pins UNDER the name (Shane 2026-09-02). */}
                    <span className="mt-0.5 block text-[11px] font-bold text-sky-300">{detail}</span>
                    {note && (
                        <span
                            className={`mt-0.5 block text-[11px] leading-snug ${red ? 'text-red-200' : 'text-amber-200'}`}
                        >
                            {note}
                        </span>
                    )}
                    {red && armed && (
                        <span className="mt-0.5 block text-[11px] font-black text-red-300">
                            Tap again to follow anyway
                        </span>
                    )}
                </span>
            </button>
            {trailing && (
                <button
                    type="button"
                    onClick={trailing.onClick}
                    aria-label={`${trailing.label} — ${routeName}`}
                    className={`min-h-[44px] w-14 shrink-0 rounded-r-xl border-l px-1 text-center text-[11px] font-black leading-tight active:scale-95 ${
                        red ? 'border-red-500/30 text-red-200' : 'border-amber-500/25 text-amber-200'
                    }`}
                >
                    {trailing.label}
                </button>
            )}
        </div>
    );
};

// ── FollowRouteButton — appears on planned route voyage cards ──

/** The card's words for a red finding's refusal: its reason, and how to
 *  follow anyway from here (the sheet's own message says "the route"). */
function cardFindingMessage(message: string, canAccept: boolean): string {
    const reason = message
        .slice(TRACE_ROUTE_USE_BLOCK_PREFIX.length)
        .replace(/\s*Tap the route twice to follow anyway\.?\s*$/, '')
        .trim();
    return canAccept ? `${reason} Tap Follow again to follow anyway.` : reason;
}

export const FollowRouteButton: React.FC<{
    voyageId: string;
    onFollow: () => Promise<boolean>;
    /** A red finding's armed second tap accepts it — the routecheck's own
     *  two-tap, as on the follow sheet (package 125-05 review fix-up). */
    onAcceptFinding?: () => void;
}> = ({ voyageId, onFollow, onAcceptFinding }) => {
    const { isFollowing, voyageId: followingVoyageId } = useFollowRoute();
    const toast = useToast();
    const [isStarting, setIsStarting] = useState(false);
    const isThisFollowed = isFollowing && followingVoyageId === voyageId;
    // A red finding (a routecheck's, or a plan red where no tide clears it,
    // package 125-05): the first tap says why and arms "tap again to follow
    // anyway" for 4 s, as the follow sheet's rows do (FollowRouteChoice). It
    // used to fall through to "Couldn't load this saved route" on every tap,
    // so the card could never follow it (review, 2026-10-09).
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 4_000);
        return () => clearTimeout(timer);
    }, [armed]);

    const handleFollow = useCallback(async () => {
        if (isThisFollowed || isStarting) return;
        if (armed) onAcceptFinding?.();
        setArmed(false);
        setIsStarting(true);
        try {
            let started = false;
            try {
                started = await onFollow();
            } catch (error) {
                if (error instanceof Error && error.message.startsWith(TRACE_ROUTE_USE_BLOCK_PREFIX)) {
                    toast.error(cardFindingMessage(error.message, !!onAcceptFinding));
                    if (onAcceptFinding) setArmed(true);
                    return;
                }
                log.warn('Could not load followed route:', error);
            }
            if (!started) {
                toast.error('Couldn’t load this saved route — please try again');
                return;
            }
            // Publish to the PUBLIC page (Shane 2026-07-17) — tied to an
            // active voyage (option A). Following a different route mid-
            // voyage re-links, so the public page swaps to it; following
            // while not tracking just draws the chart line with a hint.
            try {
                const { result, hold } = await publishFollowedRouteDetailed(voyageId);
                if (result === 'linked') toast.success('Your public page now follows this route');
                else if (result === 'not-tracking')
                    toast.info('Following on your chart — Slide to Start Tracking to show it on your public page');
                else if (result === 'held-elsewhere' && hold) {
                    // Another device's route stands. The page owns the
                    // centred confirm that names it (authorship 2026-09-08)
                    // — never a toast for a two-line decision.
                    window.dispatchEvent(
                        new CustomEvent('thalassa:follow-held-elsewhere', { detail: { planVoyageId: voyageId, hold } }),
                    );
                } else
                    toast.error(VoyageLogService.lastError ?? 'Following locally — couldn’t update your public page');
            } catch (error) {
                log.warn('Followed locally but could not publish route:', error);
                toast.error('Following locally — couldn’t update your public page');
            }
        } finally {
            setIsStarting(false);
        }
    }, [isThisFollowed, isStarting, armed, onAcceptFinding, onFollow, toast, voyageId]);

    const label = isThisFollowed
        ? 'Currently following this route'
        : isStarting
          ? 'Loading saved route'
          : armed
            ? 'Tap again to follow anyway'
            : 'Follow this route';
    return (
        <button
            aria-label={label}
            onClick={() => void handleFollow()}
            disabled={isThisFollowed || isStarting}
            className={`w-14 flex flex-col items-center justify-center py-2 border-t border-white/5 transition-colors ${
                isThisFollowed
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : isStarting
                      ? 'text-sky-300 bg-sky-500/10'
                      : armed
                        ? 'text-red-300 bg-red-500/10'
                        : 'text-sky-400 hover:text-sky-300 hover:bg-white/5'
            }`}
            title={label}
        >
            {isThisFollowed ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                </svg>
            ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
                    />
                </svg>
            )}
            <span className="text-[10px] uppercase font-bold tracking-wider mt-0.5">
                {isThisFollowed ? 'Active' : isStarting ? 'Loading' : armed ? 'Anyway' : 'Follow'}
            </span>
        </button>
    );
};

// ── VoyageCard — compact past voyage summary ──

export const VoyageCard: React.FC<{
    /** Aggregated voyage roll-up — drives the collapsed card (no points). */
    summary: VoyageSummary;
    /** Resident points for THIS voyage (lazy-loaded on expand; may be []). */
    entries: ShipLogEntry[];
    isSelected: boolean;
    isExpanded: boolean;
    onToggle: (voyageId: string) => void;
    onSelect: (voyageId: string) => void;
    onDelete: (voyageId: string) => void;
    onArchive: (voyageId: string) => void;
    onShowMap: (voyageId: string) => void;
    /** Follow this saved plan using its recovered dense route geometry. */
    onFollowPlannedRoute: (summary: VoyageSummary) => Promise<boolean>;
    /** Accept this plan's red finding: the Follow button's armed second tap. */
    onAcceptPlannedRouteFinding?: (voyageId: string) => void;
    /** Request this voyage's full points be lazy-loaded (planned actions). */
    onNeedEntries?: (voyageId: string) => void;
    /**
     * Unmount the inline mini map while a fullscreen map is open. iOS
     * WebKit composites Leaflet's transformed tile layers ABOVE fixed
     * overlays regardless of z-index — the "two tracks on screen" bug.
     */
    suppressMiniMap?: boolean;
    /** First card only: carries the swipe hint until the skipper has swiped once. */
    showSwipeHint?: boolean;
    /** Career record this voyage holds, if any — shows a gold trophy badge. */
    recordBadge?: 'longest' | 'fastest' | 'longestTrip' | null;
    filteredEntries: ShipLogEntry[];
    onDeleteEntry: (id: string) => void;
    onEditEntry: (entry: ShipLogEntry) => void;
    /** True only for the voyage this device is recording right now — drives the LIVE badge. */
    isLiveVoyage?: boolean;
}> = React.memo(
    ({
        summary,
        entries,
        isLiveVoyage = false,
        isSelected,
        isExpanded,
        onToggle,
        onSelect,
        onDelete,
        onArchive,
        onShowMap,
        onFollowPlannedRoute,
        onAcceptPlannedRouteFinding,
        onNeedEntries,
        suppressMiniMap,
        showSwipeHint = false,
        recordBadge,
        filteredEntries,
        onDeleteEntry,
        onEditEntry,
    }) => {
        const voyageId = summary.voyageId;
        // --- Swipe-to-reveal actions ---
        const [swipeOffset, setSwipeOffset] = useState(0);
        // Archive/Delete live behind a swipe with no other affordance, so the
        // first card carries a hint until the skipper has swiped once.
        const [swipeHintSeen, setSwipeHintSeen] = usePersistedState('log_swipe_hint_seen', false);
        const touchStartX = useRef(0);
        const plannedEntriesRequestedRef = useRef(false);
        const deleteThreshold = 160; // wide enough for both Archive + Delete buttons
        const handleSwipeStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
        };
        const handleSwipeMove = (e: React.TouchEvent) => {
            const diff = touchStartX.current - e.touches[0].clientX;
            if (diff > 24 && !swipeHintSeen) setSwipeHintSeen(true);
            setSwipeOffset(Math.max(0, Math.min(diff, deleteThreshold + 20)));
        };
        const handleSwipeEnd = () => {
            setSwipeOffset((s) => (s >= deleteThreshold ? deleteThreshold : 0));
        };

        // ── Header stats — all from the aggregated summary (no points) ──
        // Land voyages (car drives / walks) read green and are excluded
        // from the career tiles — flag them so the card matches.
        const isLand = isLandVoyage(summary);
        // Passage vs day cruise, retroactively, from the summary alone —
        // every voyage already in the book gets its honest badge with zero
        // schema change. Memoized because the night-hours integration samples
        // the sun every 30 simulated minutes: cheap once, not per render.
        const isPassage = React.useMemo(
            () => !isLand && classifyCompletedVoyage(summary).kind === 'passage',
            [summary, isLand],
        );
        const dist = summary.totalDistanceNM;
        const durationMs = voyageElapsedMs(summary);
        const durationLabel = formatVoyageDuration(durationMs);
        const dateLabel = summary.startedAt
            ? new Date(summary.startedAt).toLocaleDateString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  year: '2-digit',
              })
            : '';
        const hasManual = summary.hasManual;
        const avgSpeed = summary.avgSpeedKts;
        const isImported = summary.isImported;
        const isPlannedRoute = summary.isPlannedRoute;

        // Planned cards keep GPX and timeline points warm even while
        // collapsed. This used to happen incidentally inside the Follow
        // button; keep it explicit so refactoring that action cannot leave
        // the adjacent GPX export with an empty route.
        useEffect(() => {
            if (!isPlannedRoute || entries.length > 0 || plannedEntriesRequestedRef.current || !onNeedEntries) {
                return;
            }
            plannedEntriesRequestedRef.current = true;
            onNeedEntries(voyageId);
        }, [entries.length, isPlannedRoute, onNeedEntries, voyageId]);
        // Bound once per voyage so memo(LiveMiniMap) keeps its onTap identity.
        const handleShowMap = React.useCallback(() => onShowMap(voyageId), [onShowMap, voyageId]);

        // Synthetic first/last coordinate carriers for geocoding + the
        // FollowRoute plan (full points arrive lazily via `entries`).
        const first =
            summary.firstLat != null ? { latitude: summary.firstLat, longitude: summary.firstLon } : undefined;
        const last = summary.lastLat != null ? { latitude: summary.lastLat, longitude: summary.lastLon } : undefined;

        // Card title place names. Shared with the cast-off "Following a route?"
        // sheet via useEndpointNames, so the same voyage is named identically in
        // both places — and the lookups are cached, so showing a card and the
        // sheet together no longer geocodes the same berth twice.
        const { startLabel, endLabel } = useEndpointNames(first, last);

        // Set lookup, NOT nested .some() — the O(n²) form was ~33M comparisons
        // per render for an expanded one-day passage (audit 2026-07-03), and
        // grows quadratically with the full-retention capture cadence.
        const filteredIds = new Set(filteredEntries.map((f) => f.id));
        const voyageFilteredEntries = entries.filter((e) => filteredIds.has(e.id));

        return (
            <>
                <div className="mb-3 relative overflow-hidden rounded-2xl snap-start">
                    {/* Action buttons revealed on swipe-left */}
                    <div
                        className={`absolute right-0 top-0 bottom-0 flex transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                    >
                        {/* Archive — hidden for planned routes */}
                        {!isPlannedRoute && (
                            <button
                                aria-label="Archive"
                                onClick={() => {
                                    setSwipeOffset(0);
                                    onArchive(voyageId);
                                }}
                                className="w-20 bg-amber-600 flex items-center justify-center"
                            >
                                <div className="flex flex-col items-center gap-1">
                                    <svg
                                        className="w-5 h-5 text-white"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8"
                                        />
                                    </svg>
                                    <span className="text-[11px] font-bold text-white uppercase">Archive</span>
                                </div>
                            </button>
                        )}
                        {/* Delete */}
                        <button
                            aria-label="Delete"
                            onClick={() => {
                                setSwipeOffset(0);
                                onDelete(voyageId);
                            }}
                            className={`w-20 bg-red-600 flex items-center justify-center ${isPlannedRoute ? 'rounded-r-2xl rounded-l-2xl' : 'rounded-r-2xl'}`}
                        >
                            <div className="flex flex-col items-center gap-1">
                                <svg
                                    className="w-5 h-5 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    />
                                </svg>
                                <span className="text-[11px] font-bold text-white uppercase">Delete</span>
                            </div>
                        </button>
                    </div>
                    <div
                        className={`w-full rounded-2xl overflow-hidden transition-all flex relative ${
                            isSelected
                                ? 'bg-white/5 border-2 border-sky-400/40 shadow-[0_0_12px_rgba(56,189,248,0.1)]'
                                : isPlannedRoute
                                  ? isExpanded
                                      ? 'bg-purple-900/20 border border-purple-500/25'
                                      : 'bg-white/2 border border-purple-500/10 hover:border-purple-500/20'
                                  : isImported
                                    ? isExpanded
                                        ? 'bg-amber-900/20 border border-amber-500/25'
                                        : 'bg-white/2 border border-amber-500/10 hover:border-amber-500/20'
                                    : isExpanded
                                      ? 'bg-white/4 border border-white/10'
                                      : 'bg-white/2 border border-white/6 hover:border-white/10'
                        }`}
                        style={{
                            transform: `translateX(-${swipeOffset}px)`,
                            transition:
                                swipeOffset === 0 || swipeOffset === deleteThreshold
                                    ? 'transform 0.2s ease-out'
                                    : 'none',
                        }}
                        onTouchStart={handleSwipeStart}
                        onTouchMove={handleSwipeMove}
                        onTouchEnd={handleSwipeEnd}
                    >
                        {/* LEFT — route info, date anchor with spine */}
                        <button
                            onClick={(e) => {
                                if (swipeOffset !== 0) {
                                    setSwipeOffset(0);
                                    return;
                                }
                                const rect = e.currentTarget.getBoundingClientRect();
                                const clickX = e.clientX - rect.left;
                                onSelect(voyageId);
                                if (clickX < rect.width / 3) {
                                    onToggle(voyageId);
                                }
                            }}
                            className="flex-1 p-3.5 text-left min-w-0"
                        >
                            {/* ── Top row: route title with stylised arrow ──
                            2026-05-17 polish: replaced the bare "→"
                            ascii arrow with a proper sky-tinted SVG
                            glyph so the from-to relationship reads as
                            a navigation move rather than a typographic
                            afterthought. Title bumped to 16 px. */}
                            <div className="flex items-start justify-between mb-2">
                                <div className="min-w-0 flex-1">
                                    {startLabel || endLabel ? (
                                        <div className="flex items-center gap-1.5 text-[16px] font-bold text-white leading-tight">
                                            <span className="truncate">{startLabel || '—'}</span>
                                            <svg
                                                className="shrink-0 w-3.5 h-3.5 text-sky-400"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth={2.5}
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                aria-hidden="true"
                                            >
                                                <path d="M5 12h14M13 6l6 6-6 6" />
                                            </svg>
                                            <span className="truncate">{endLabel || '…'}</span>
                                        </div>
                                    ) : (
                                        <div className="text-[16px] font-bold text-white/60 truncate leading-tight">
                                            Voyage
                                        </div>
                                    )}
                                </div>
                                {isSelected && <span className="ml-2 shrink-0 w-2 h-2 rounded-full bg-sky-400 mt-2" />}
                            </div>

                            {/* ── Stats row — small chips, not dot-separated text ──
                            2026-05-17 polish: was a single muted line with
                            "·" separators that all the metrics had to
                            share. Each metric is now its own subtle pill
                            so the eye can pick out distance vs duration
                            vs date vs speed independently. Distance gets
                            the sky tint because it's the headline number
                            for a voyage log. */}
                            <div className="flex items-center gap-1.5 flex-wrap">
                                {isPassage && (
                                    <span className="px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-400/30 text-[10px] font-bold text-indigo-300 inline-flex items-center gap-1 uppercase tracking-wider">
                                        <span aria-hidden>🌙</span>
                                        Passage
                                    </span>
                                )}
                                {recordBadge && (
                                    <span className="px-2 py-0.5 rounded-full bg-linear-to-r from-amber-400/25 to-yellow-500/20 border border-amber-400/40 text-[11px] font-black text-amber-300 inline-flex items-center gap-1 shadow-xs shadow-amber-500/10">
                                        <span aria-hidden>🏆</span>
                                        {recordBadge === 'longest'
                                            ? 'Farthest'
                                            : recordBadge === 'fastest'
                                              ? 'Fastest'
                                              : 'Longest'}
                                    </span>
                                )}
                                <span
                                    className={`px-2 py-0.5 rounded-full border text-[11px] font-bold tabular-nums ${
                                        isLand
                                            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                                            : 'bg-sky-500/10 border-sky-500/20 text-sky-300'
                                    }`}
                                >
                                    {(dist ?? 0).toFixed(1)} nm
                                </span>
                                {isLand && (
                                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-bold text-emerald-300 inline-flex items-center gap-1 uppercase tracking-wider">
                                        <span aria-hidden>🌿</span>
                                        On land · not counted
                                    </span>
                                )}
                                <span className="px-2 py-0.5 rounded-full bg-white/4 border border-white/6 text-[11px] font-semibold text-slate-300 tabular-nums">
                                    {durationLabel}
                                </span>
                                {avgSpeed > 0 && (
                                    <span className="px-2 py-0.5 rounded-full bg-white/4 border border-white/6 text-[11px] font-semibold text-slate-300 tabular-nums">
                                        {(avgSpeed ?? 0).toFixed(1)} kts
                                    </span>
                                )}
                                <span className="px-2 py-0.5 rounded-full bg-white/2 border border-white/4 text-[11px] font-medium text-slate-400">
                                    {dateLabel}
                                </span>
                            </div>

                            {/* Badge row — entries count + source-type chips */}
                            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                                <span className="text-[10px] text-slate-500 tabular-nums">
                                    {summary.entryCount} entries
                                </span>
                                {hasManual && (
                                    <span className="px-1.5 py-0.5 rounded-full bg-purple-500/10 text-[9px] font-bold text-purple-400/80 uppercase tracking-wider">
                                        Manual
                                    </span>
                                )}
                                {isPlannedRoute && (
                                    <span className="px-1.5 py-0.5 rounded-full bg-purple-500/10 text-[9px] font-bold text-purple-400/80 uppercase tracking-wider">
                                        Suggested
                                    </span>
                                )}
                                {isImported && !isPlannedRoute && (
                                    <span className="px-1.5 py-0.5 rounded-full bg-amber-500/10 text-[9px] font-bold text-amber-400/80 uppercase tracking-wider">
                                        Imported
                                    </span>
                                )}
                            </div>
                            {isPlannedRoute && (
                                <div className="text-[10px] text-purple-400/50 mt-1.5">
                                    📐 Suggested route — not from onboard GPS
                                </div>
                            )}
                            {isImported && !isPlannedRoute && (
                                <div className="text-[10px] text-amber-400/50 mt-1.5">
                                    ⚠ Unverified track — not from onboard GPS
                                </div>
                            )}
                        </button>

                        {/* RIGHT — action buttons */}
                        <div className="shrink-0 flex flex-col border-l border-white/5">
                            <button
                                aria-label="View on map"
                                onClick={() => {
                                    if (swipeOffset === 0) onShowMap(voyageId);
                                    else setSwipeOffset(0);
                                }}
                                className="flex-1 w-14 flex flex-col items-center justify-center hover:bg-white/5 transition-colors text-slate-400 hover:text-sky-400"
                                title="View on map"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={1.5}
                                        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                                    />
                                </svg>
                                <span className="text-[10px] uppercase font-bold tracking-wider mt-0.5">Map</span>
                            </button>
                            {isPlannedRoute && (
                                <button
                                    aria-label="Share"
                                    onClick={async () => {
                                        if (swipeOffset !== 0) {
                                            setSwipeOffset(0);
                                            return;
                                        }
                                        try {
                                            const { exportVoyageAsGPX, shareGPXFile } =
                                                await import('../../services/gpxService');
                                            const gpxXml = exportVoyageAsGPX(
                                                entries,
                                                `Planned_${startLabel || 'Route'}_to_${endLabel || 'Destination'}`,
                                            );
                                            await shareGPXFile(gpxXml, `planned_route_${voyageId}.gpx`);
                                        } catch (err) {
                                            log.error('GPX Export failed:', err);
                                        }
                                    }}
                                    className="w-14 flex flex-col items-center justify-center py-2 border-t border-white/5 hover:bg-white/5 transition-colors text-purple-400 hover:text-purple-300"
                                    title="Export as GPX"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={1.5}
                                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                        />
                                    </svg>
                                    <span className="text-[10px] uppercase font-bold tracking-wider mt-0.5">GPX</span>
                                </button>
                            )}
                            {isPlannedRoute && (
                                <FollowRouteButton
                                    voyageId={voyageId}
                                    onFollow={() => onFollowPlannedRoute(summary)}
                                    onAcceptFinding={
                                        onAcceptPlannedRouteFinding
                                            ? () => onAcceptPlannedRouteFinding(voyageId)
                                            : undefined
                                    }
                                />
                            )}
                        </div>
                    </div>

                    {/* Expanded: show full timeline */}
                    {isExpanded && (
                        <>
                            {/* Inline map for planned routes — tap to open fullscreen.
                            Unmounted while a fullscreen map is up (see suppressMiniMap). */}
                            {isPlannedRoute && entries.length >= 2 && !suppressMiniMap && (
                                <div className="px-4 pt-3">
                                    <LiveMiniMap entries={entries} height={140} onTap={handleShowMap} />
                                </div>
                            )}
                            {entries.length === 0 ? (
                                // Points are lazy-loaded on expand — brief spinner
                                // while this voyage's track streams in.
                                <div className="flex items-center justify-center gap-2 py-6 text-slate-400">
                                    <span className="w-4 h-4 rounded-full border-2 border-sky-400/30 border-t-sky-400 animate-spin" />
                                    <span className="text-[12px]">Loading track…</span>
                                </div>
                            ) : (
                                <>
                                    {/* Sail vs motor — only shows once the engine state
                                    was logged for some of the voyage (real data). */}
                                    {!isPlannedRoute &&
                                        (() => {
                                            const split = computePropulsionSplit(voyageFilteredEntries);
                                            const known = split.motorMs + split.sailMs;
                                            if (known === 0) return null;
                                            const fmt = (ms: number) => {
                                                const h = Math.floor(ms / 3600000);
                                                const m = Math.floor((ms % 3600000) / 60000);
                                                return h > 0 ? `${h}h ${m}m` : `${m}m`;
                                            };
                                            const motorPct = Math.round((split.motorMs / known) * 100);
                                            // Honest: flag when any of the split is the heuristic
                                            // estimate rather than the skipper's engine toggle.
                                            const estPct = Math.round((split.estimatedMs / known) * 100);
                                            const estimated = estPct >= 5;
                                            return (
                                                <div className="px-4 pt-3">
                                                    <div className="flex items-center justify-between mb-1.5">
                                                        <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400/70">
                                                            Sail vs Motor
                                                        </span>
                                                        {estimated && (
                                                            <span className="text-[9px] font-bold uppercase tracking-wider text-white/50">
                                                                {estPct >= 95 ? 'estimated' : 'partly estimated'}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-900/60 mb-1.5">
                                                        <div
                                                            className="bg-amber-500"
                                                            style={{ width: `${motorPct}%` }}
                                                        />
                                                        <div className="bg-emerald-500 flex-1" />
                                                    </div>
                                                    <div className="flex justify-between text-[11px]">
                                                        <span className="text-amber-400 font-bold">
                                                            ⚙ Motor {fmt(split.motorMs)}
                                                        </span>
                                                        <span className="text-emerald-400 font-bold">
                                                            ⛵ Sail {fmt(split.sailMs)}
                                                        </span>
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                    {/* Day's runs (noon-to-noon) — only for passages that
                                    span a whole day, the classic bluewater logbook view.
                                    Distances are the gated totals the card uses. */}
                                    {!isPlannedRoute &&
                                        (() => {
                                            const runs = groupEntriesByNoonWindow(voyageFilteredEntries);
                                            if (!shouldShowDayRuns(runs, voyageFilteredEntries)) return null;
                                            return (
                                                <div className="px-4 pt-3">
                                                    <div className="text-[10px] font-bold uppercase tracking-wider text-sky-400/70 mb-1.5">
                                                        Day's Runs
                                                    </div>
                                                    <div className="space-y-1">
                                                        {runs.map((r) => (
                                                            <div
                                                                key={r.windowStartMs}
                                                                className="flex items-center justify-between text-[12px] py-1 px-2 rounded-lg bg-slate-900/40 border border-white/5"
                                                            >
                                                                <span className="text-white/70 font-medium">
                                                                    Day {r.dayNumber}
                                                                    <span className="text-white/50 ml-2">
                                                                        {dayRunLabel(r)}
                                                                    </span>
                                                                </span>
                                                                <span className="font-bold text-emerald-400 tabular-nums">
                                                                    {r.distanceNM.toFixed(1)} NM
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    <div
                                        className={`ml-2 border-l-2 ${isPlannedRoute ? 'border-purple-500/20' : 'border-sky-500/20'} pl-3 mt-1 mb-1`}
                                    >
                                        <DateGroupedTimeline
                                            groupedEntries={groupEntriesByDate(voyageFilteredEntries)}
                                            isTracking={isLiveVoyage}
                                            onDeleteEntry={onDeleteEntry}
                                            onEditEntry={onEditEntry}
                                            voyageFirstEntryId={entries[entries.length - 1]?.id}
                                            voyageLastEntryId={entries[0]?.id}
                                        />
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </div>
                {showSwipeHint && !swipeHintSeen && (
                    <p className="-mt-2 mb-3 px-3.5 text-xs text-slate-400">Swipe a voyage left to archive or delete</p>
                )}
            </>
        );
    },
);
