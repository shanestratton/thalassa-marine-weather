/**
 * WeatherWindowCard — Departure window analyser for cruisers.
 *
 * "When should I leave?"
 * Analyses 7 days of weather, scores 6h departure windows.
 * Shows Go / Marginal / Wait ratings.
 * Red → Green when skipper accepts a departure window.
 */

import React, { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import {
    WeatherWindowService,
    type WeatherWindowResult,
    type DepartureWindow,
} from '../../services/WeatherWindowService';
import { type Voyage } from '../../services/VoyageService';
import { triggerHaptic } from '../../utils/system';
import {
    useReadinessIdentityScope,
    useScopedReadinessStorageState,
    useSingleCheckSync,
    writeReadinessStorage,
} from '../../hooks/useReadinessSync';
import { isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';

interface WeatherWindowCardProps {
    voyageId?: string;
    departure?: { lat: number; lon: number };
    destination?: { lat: number; lon: number };
    activeVoyage?: Voyage | null;
    /** ISO timestamp the skipper picked for departure. When provided,
     *  the card auto-scopes the visible windows to ±3 days around this
     *  date and re-renders whenever it changes — so picking a new
     *  departure date in the form (or accepting a window in this very
     *  card) instantly updates which days are highlighted.
     *
     *  Falls back to activeVoyage.departure_time if undefined. */
    departureTime?: string | null;
    onReviewedChange?: (ready: boolean) => void;
}

const STORAGE_KEY = 'thalassa_accepted_window';

const RATING_STYLES = {
    go: {
        bg: 'bg-emerald-500/15',
        border: 'border-emerald-500/25',
        text: 'text-emerald-400',
        label: '✅ GO',
        dot: 'bg-emerald-400',
    },
    marginal: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        text: 'text-amber-400',
        label: '⚠️ MARGINAL',
        dot: 'bg-amber-400',
    },
    wait: {
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
        text: 'text-red-400',
        label: '❌ WAIT',
        dot: 'bg-red-400',
    },
};

export const WeatherWindowCard: React.FC<WeatherWindowCardProps> = ({
    voyageId,
    departure,
    destination,
    activeVoyage: _activeVoyage,
    departureTime,
    onReviewedChange,
}) => {
    const identityScope = useReadinessIdentityScope();
    // Resolve the chosen departure date — priority order:
    //   1. The latest ISO captured from a `thalassa:departure-time-updated`
    //      event (live, fires the moment the form's date input changes
    //      or another card accepts a window). Snapshot in local state
    //      so the filter below re-runs without waiting for a parent
    //      prop to round-trip through React Context.
    //   2. The explicit `departureTime` prop (when the parent already
    //      pipes the chosen date through).
    //   3. The active voyage's departure_time (last-resort fallback).
    const [eventDepartureIso, setEventDepartureIso] = useState<string | null>(null);
    useEffect(() => {
        const operationScope = identityScope;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { voyageId?: string; iso?: string } | undefined;
            const iso = detail?.iso;
            if (
                isAuthIdentityScopeCurrent(operationScope) &&
                detail?.voyageId === voyageId &&
                typeof iso === 'string'
            ) {
                setEventDepartureIso(iso);
            }
        };
        window.addEventListener('thalassa:departure-time-updated', handler);
        return () => window.removeEventListener('thalassa:departure-time-updated', handler);
    }, [identityScope, voyageId]);

    const chosenDepartureIso = eventDepartureIso ?? departureTime ?? _activeVoyage?.departure_time ?? null;
    const chosenDepartureMs = chosenDepartureIso ? Date.parse(chosenDepartureIso) : NaN;
    const hasChosenDate = Number.isFinite(chosenDepartureMs);
    const [result, setResult] = useState<WeatherWindowResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lifecycleGenerationRef = useRef(0);
    const analysisRequestRef = useRef(0);
    const acceptanceMutationRef = useRef(0);
    const [acceptedIndex, setAcceptedIndex] = useScopedReadinessStorageState<number | null>(
        STORAGE_KEY,
        voyageId,
        null,
    );
    const [showAll, setShowAll] = useState(false);

    // Determine departure coordinates
    const lat = departure?.lat ?? null;
    const lon = departure?.lon ?? null;

    // Calculate course bearing
    const destLat = destination?.lat ?? null;
    const destLon = destination?.lon ?? null;

    let courseBearing: number | undefined;
    if (lat != null && lon != null && destLat != null && destLon != null) {
        const dLon = ((destLon - lon) * Math.PI) / 180;
        const lat1 = (lat * Math.PI) / 180;
        const lat2 = (destLat * Math.PI) / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        courseBearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    useLayoutEffect(() => {
        lifecycleGenerationRef.current += 1;
        analysisRequestRef.current += 1;
        acceptanceMutationRef.current += 1;
        setEventDepartureIso(null);
        setResult(null);
        setLoading(false);
        setError(null);
        setShowAll(false);
    }, [identityScope, voyageId]);

    useEffect(
        () => () => {
            lifecycleGenerationRef.current += 1;
            analysisRequestRef.current += 1;
            acceptanceMutationRef.current += 1;
        },
        [],
    );

    // Supabase sync — acceptance is per-voyage so this is a single-check
    // sync (one row per voyage). On voyageId change, load from server and
    // mark accepted if the server says so. Without this, accepting on
    // iPhone wouldn't show on iPad and vice versa.
    const { syncSingleCheck, loadSingleCheck } = useSingleCheckSync(voyageId, 'weather_window', 'accepted');
    useEffect(() => {
        if (!voyageId) return;
        const operationScope = identityScope;
        const mutationAtLoadStart = acceptanceMutationRef.current;
        let cancelled = false;
        void loadSingleCheck().then(async () => {
            if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
            // The single-check service returns a bool; the actual window
            // index is in the metadata column. Fetch it directly to
            // recover which window was accepted.
            try {
                const { ReadinessCheckService } = await import('../../services/ReadinessCheckService');
                const checks = await ReadinessCheckService.loadCardChecks(voyageId, 'weather_window');
                const acceptedCheck = checks['accepted'];
                if (
                    cancelled ||
                    !isAuthIdentityScopeCurrent(operationScope) ||
                    acceptanceMutationRef.current !== mutationAtLoadStart ||
                    !acceptedCheck?.checked
                )
                    return;
                const idx = (acceptedCheck.metadata as { index?: number } | undefined)?.index;
                if (typeof idx !== 'number') return;
                setAcceptedIndex(idx);
            } catch {
                /* offline / no Supabase — the scoped local mirror is
                   already visible. */
            }
        });
        return () => {
            cancelled = true;
        };
    }, [identityScope, voyageId, loadSingleCheck, setAcceptedIndex]);

    // Notify parent
    useEffect(() => {
        onReviewedChange?.(acceptedIndex !== null);
    }, [acceptedIndex, onReviewedChange]);

    const analyse = useCallback(async () => {
        const operationScope = identityScope;
        const operationGeneration = ++analysisRequestRef.current;
        const isOperationCurrent = () =>
            isAuthIdentityScopeCurrent(operationScope) && analysisRequestRef.current === operationGeneration;
        if (lat == null || lon == null) {
            setError('No departure coordinates — plan a route first');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const data = await WeatherWindowService.analyse(lat, lon, voyageId, courseBearing);
            if (!isOperationCurrent()) return;
            setResult(data);
        } catch {
            if (isOperationCurrent()) setError('Failed to analyse weather windows');
        } finally {
            if (isOperationCurrent()) setLoading(false);
        }
    }, [identityScope, lat, lon, voyageId, courseBearing]);

    // Auto-analyse on mount
    useEffect(() => {
        if (lat != null && lon != null) void analyse();
    }, [lat, lon, analyse]);

    const acceptWindow = useCallback(
        (index: number) => {
            const operationScope = identityScope;
            const operationGeneration = lifecycleGenerationRef.current;
            const isOperationCurrent = () =>
                isAuthIdentityScopeCurrent(operationScope) && lifecycleGenerationRef.current === operationGeneration;
            if (!isOperationCurrent()) return;
            acceptanceMutationRef.current += 1;
            setAcceptedIndex(index);
            triggerHaptic('medium');
            if (voyageId) {
                // Mirror to Supabase so the acceptance follows the
                // skipper to other devices. Index is carried in
                // metadata; the boolean state is "accepted: true".
                syncSingleCheck(true, { index, accepted_at: Date.now() });
            }

            // ── Sync the accepted window's departure time into the
            // canonical departure_time slot. These two pieces of state were
            // once stored in unrelated global keys, so accepting a window
            // visibly green-checked the readiness card but the Passage
            // Summary still showed whatever time the user had typed in.
            //
            // Also write to the summary's account/voyage-scoped mirror
            // (HH:MM, matching the time input) and update the live voyage row
            // (full ISO) so the cross-screen ETA / departure cards
            // refresh on next render. Dispatch a window event so any
            // already-mounted PassageSummaryCard re-reads instantly
            // without waiting for a remount.
            const win = result?.windows?.[index];
            if (win?.time) {
                const winDate = new Date(win.time);
                if (!isNaN(winDate.getTime())) {
                    // HH:MM in the device's local timezone — matches the
                    // shape the <input type="time"> in PassageSummaryCard
                    // produces, so the form's controlled value still
                    // works after this write.
                    const hh = String(winDate.getHours()).padStart(2, '0');
                    const mm = String(winDate.getMinutes()).padStart(2, '0');
                    const hhmm = `${hh}:${mm}`;
                    writeReadinessStorage('thalassa_passage_departure_time', voyageId, hhmm, operationScope);

                    // Update the active voyage's departure_time +
                    // recompute ETA. Non-blocking — if the update fails
                    // (offline, RLS issue), the localStorage write above
                    // still gives the user something visible.
                    if (voyageId) {
                        import('../../services/VoyageService')
                            .then(({ updateVoyage }) => {
                                if (!isOperationCurrent()) return null;
                                const newDepartureIso = winDate.toISOString();
                                // Recompute ETA preserving the original
                                // duration if we can derive it from the
                                // active voyage's existing ETA window.
                                const patch: { departure_time: string; eta?: string } = {
                                    departure_time: newDepartureIso,
                                };
                                if (_activeVoyage?.departure_time && _activeVoyage?.eta) {
                                    const oldDep = new Date(_activeVoyage.departure_time).getTime();
                                    const oldEta = new Date(_activeVoyage.eta).getTime();
                                    if (!isNaN(oldDep) && !isNaN(oldEta) && oldEta > oldDep) {
                                        const durationMs = oldEta - oldDep;
                                        patch.eta = new Date(winDate.getTime() + durationMs).toISOString();
                                    }
                                }
                                return updateVoyage(voyageId, patch);
                            })
                            .catch((e) => {
                                // Non-critical — UI still shows the
                                // accepted window even if persistence
                                // fails. Crew Management will reconcile
                                // on next reload.
                                console.warn('[WeatherWindowCard] voyage update failed:', e);
                            });
                    }

                    // Notify any open PassageSummaryCard / banner / etc.
                    // to re-read the new departure time.
                    try {
                        if (isOperationCurrent()) {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:departure-time-updated', {
                                    detail: { voyageId, hhmm, iso: winDate.toISOString() },
                                }),
                            );
                        }
                    } catch {
                        /* SSR safety */
                    }
                }
            }
        },
        [identityScope, voyageId, result, _activeVoyage, setAcceptedIndex, syncSingleCheck],
    );

    // Determine windows to show.
    //
    // When the skipper has picked a departure date we scope the visible
    // windows to ±3 days around it — the typical "do I leave a day
    // earlier or a day later" decision space. Without this scoping the
    // user sees 16 days of windows and has to scroll to find their
    // chosen date. With it, the card centres on the date the user
    // cares about and updates immediately when they change it.
    //
    // When no date is picked yet, fall back to the previous behaviour
    // (top-rated windows from the full forecast).
    //
    // Indices below stay in `allWindows` coordinates because
    // `acceptedIndex` / `acceptWindow` persist through localStorage and
    // pull from `result.windows[idx]`. Filtering only changes what's
    // visible — never the canonical index space.
    const allWindows = result?.windows ?? [];
    const FOCUS_HALF_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
    const displayWindows = hasChosenDate
        ? allWindows.filter((w) => {
              const wMs = Date.parse(w.time);
              if (!Number.isFinite(wMs)) return false;
              return Math.abs(wMs - chosenDepartureMs) <= FOCUS_HALF_WINDOW_MS;
          })
        : allWindows;

    // Best window within the visible scope (not result.bestWindowIndex,
    // which is the global best — could fall outside the focus window).
    let scopedBestIdx = -1;
    for (const w of displayWindows) {
        const i = allWindows.indexOf(w);
        if (i < 0) continue;
        if (scopedBestIdx < 0 || w.score > allWindows[scopedBestIdx].score) scopedBestIdx = i;
    }

    const topWindows = showAll
        ? displayWindows
        : hasChosenDate
          ? displayWindows
          : displayWindows.filter((w) => w.rating === 'go' || w.rating === 'marginal').slice(0, 6);
    const goCount = displayWindows.filter((w) => w.rating === 'go').length;

    // Pre-format the chosen date for the summary line so the user sees
    // exactly which day the picker is focused on.
    const chosenDateLabel = hasChosenDate
        ? new Date(chosenDepartureMs).toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
          })
        : null;

    return (
        <div className="space-y-4">
            {/* No coordinates */}
            {lat == null && (
                <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-xl p-4 text-center">
                    <p className="text-2xl mb-2">🧭</p>
                    <p className="text-xs text-gray-400">
                        Plan a route first to enable weather window analysis.
                        <br />
                        Departure coordinates are needed.
                    </p>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 text-center">
                    <div className="w-8 h-8 border-2 border-cyan-400/20 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-xs text-gray-400">Analysing 16-day forecast...</p>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
                    <span className="text-lg">⚠️</span>
                    <p className="text-xs text-red-400">{error}</p>
                </div>
            )}

            {/* Results */}
            {result && !loading && (
                <>
                    {/* Summary bar */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 flex items-center gap-3">
                        <span className="text-lg">{goCount > 0 ? '🌤️' : '⛈️'}</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-white">
                                {chosenDateLabel ? (
                                    <>
                                        {goCount > 0
                                            ? `${goCount} departure window${goCount !== 1 ? 's' : ''}`
                                            : 'No ideal windows'}{' '}
                                        <span className="text-amber-300">around {chosenDateLabel}</span>
                                    </>
                                ) : goCount > 0 ? (
                                    `${goCount} departure window${goCount !== 1 ? 's' : ''} open`
                                ) : (
                                    'No ideal windows — proceed with caution'
                                )}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                                {result.source === 'live' ? 'Live forecast' : 'Cached data'} ·{' '}
                                {new Date(result.analysisTime).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                                {chosenDateLabel ? ' · scope ±3 days' : ''}
                            </p>
                        </div>
                        <button
                            onClick={analyse}
                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    {/* No windows in the chosen-date scope (e.g. user
                        picked a date beyond the 16-day forecast horizon) */}
                    {displayWindows.length === 0 && hasChosenDate && (
                        <div className="bg-amber-500/[0.05] border border-amber-500/15 rounded-xl p-3 text-center">
                            <p className="text-xs text-amber-300">
                                No forecast data within ±3 days of {chosenDateLabel}.
                            </p>
                            <p className="text-[11px] text-gray-400 mt-1">
                                The 16-day forecast horizon doesn&apos;t reach this date — pick something closer.
                            </p>
                        </div>
                    )}

                    {/* Best window highlight (best within the visible
                        scope — not the global best, which could be
                        outside the chosen-date filter). */}
                    {scopedBestIdx >= 0 && allWindows[scopedBestIdx] && (
                        <WindowCard
                            window={allWindows[scopedBestIdx]}
                            index={scopedBestIdx}
                            isBest
                            isAccepted={acceptedIndex === scopedBestIdx}
                            onAccept={acceptWindow}
                        />
                    )}

                    {/* Other windows. Indices map back to allWindows
                        (canonical) so acceptedIndex / persistence
                        survive any filtering changes. */}
                    {topWindows
                        .filter((w) => allWindows.indexOf(w) !== scopedBestIdx)
                        .map((w) => {
                            const origIdx = allWindows.indexOf(w);
                            return (
                                <WindowCard
                                    key={w.time}
                                    window={w}
                                    index={origIdx}
                                    isAccepted={acceptedIndex === origIdx}
                                    onAccept={acceptWindow}
                                />
                            );
                        })}

                    {/* Show all toggle */}
                    {!showAll && displayWindows.length > topWindows.length + 1 && (
                        <button
                            onClick={() => setShowAll(true)}
                            className="w-full py-2 text-[11px] font-bold text-gray-400 hover:text-white transition-colors"
                        >
                            Show all {displayWindows.length} windows ▾
                        </button>
                    )}
                </>
            )}

            {/* Accepted summary */}
            {acceptedIndex !== null && result?.windows[acceptedIndex] && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border bg-emerald-500/10 border-emerald-500/20">
                    <span className="text-lg">✅</span>
                    <div>
                        <p className="text-xs font-bold text-emerald-400">
                            Window accepted: {result.windows[acceptedIndex].label}
                        </p>
                        <p className="text-[11px] text-emerald-400/60 mt-0.5">
                            {result.windows[acceptedIndex].description}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

/** Individual window card */
const WindowCard: React.FC<{
    window: DepartureWindow;
    index: number;
    isBest?: boolean;
    isAccepted?: boolean;
    onAccept: (index: number) => void;
}> = ({ window: w, index, isBest, isAccepted, onAccept }) => {
    const style = RATING_STYLES[w.rating];
    return (
        <div
            className={`${style.bg} border ${style.border} rounded-xl p-3 transition-all ${
                isAccepted ? 'ring-2 ring-emerald-400/40' : ''
            }`}
        >
            <div className="flex items-center gap-3 mb-2">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <span className={`text-sm font-black ${style.text}`}>{w.label}</span>
                        {isBest && (
                            <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-300 text-[11px] font-bold rounded-full border border-amber-500/20">
                                ⭐ BEST
                            </span>
                        )}
                    </div>
                    <p className="text-[11px] font-bold text-white/80 mt-0.5 uppercase tracking-wider">
                        {w.rating === 'go' ? '✅' : w.rating === 'marginal' ? '⚠️' : '❌'} {w.rating.toUpperCase()}
                    </p>
                </div>
                {/* Score bar */}
                <div className="w-14 text-right">
                    <div className={`text-lg font-black ${style.text}`}>{w.score}</div>
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                            className={`h-full ${style.dot} rounded-full transition-all`}
                            style={{ width: `${w.score}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* Details */}
            <div className="grid grid-cols-3 gap-2 text-center mb-2">
                <div>
                    <p className="text-[11px] text-gray-500 uppercase font-bold">Wind</p>
                    <p className="text-xs font-bold text-white">
                        {w.summary.dominantWindDir} {w.summary.avgWindKts}–{w.summary.maxWindKts}kt
                    </p>
                </div>
                <div>
                    <p className="text-[11px] text-gray-500 uppercase font-bold">Wave</p>
                    <p className="text-xs font-bold text-white">
                        {w.summary.avgWaveM}–{w.summary.maxWaveM}m
                    </p>
                </div>
                <div>
                    <p className="text-[11px] text-gray-500 uppercase font-bold">Rain</p>
                    <p className="text-xs font-bold text-white">{w.summary.rainProbability}%</p>
                </div>
            </div>

            {/* Accept button */}
            {!isAccepted ? (
                <button
                    onClick={() => onAccept(index)}
                    className={`w-full py-2 rounded-lg text-[11px] font-bold transition-all active:scale-[0.98] ${
                        w.rating === 'go'
                            ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/20'
                            : w.rating === 'marginal'
                              ? 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 border border-amber-500/15'
                              : 'bg-red-500/10 text-red-300 hover:bg-red-500/20 border border-red-500/15'
                    }`}
                >
                    Accept This Window
                </button>
            ) : (
                <div className="text-center text-[11px] font-bold text-emerald-400 py-1">✅ Accepted</div>
            )}
        </div>
    );
};
