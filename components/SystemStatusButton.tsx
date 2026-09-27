/**
 * SystemStatusButton — Single ℹ circle that replaces all individual header badges.
 *
 * Always available in the header, with a count of active systems. Tapping it
 * opens the consolidated system panel. An active Shore Watch adds a gentle
 * connection halo: blue for fresh data, amber while waiting, red for lost
 * contact/GPS or a vessel drag alarm. Ordinary multi-system use does not pulse.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ShipLogService } from '../services/ShipLogService';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { AnchorIcon, InfoIcon, RouteIcon } from './Icons';
import { NmeaListenerService } from '../services/NmeaListenerService';
import { NmeaStore } from '../services/NmeaStore';
import { CloudTelemetryService } from '../services/CloudTelemetryService';
import { deriveNmeaBackboneStatus } from '../utils/nmeaBackboneStatus';
import { GpsPrecision } from '../services/shiplog/GpsPrecisionTracker';
import { GpsReceiverStatusService, type GpsReceiverStatus } from '../services/GpsReceiverStatusService';
import { NmeaRateSparkline } from './NmeaRateSparkline';
import { useFollowRoute } from '../context/FollowRouteContext';
import { GpsService, type GpsPosition } from '../services/GpsService';
import { piCache, type PiCacheStatus } from '../services/PiCacheService';
import { n2kStatus, type N2kStatus } from '../services/n2kStatus';
import { PI_INTEGRATION_ENABLED } from '../services/piPublicBetaBoundary';
import { GpsSourceRow } from './GpsSourceGlyph';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { appBuildLabel } from '../services/externalLinks';
import { PassageHudInfoCard } from './passage/PassageHudInfoCard';
import { GpsDiagnosticsCards } from './GpsDiagnosticsCards';
import { ShoreWatchAlarmService } from '../services/ShoreWatchAlarmService';
import { AnchorWatchSyncService } from '../services/AnchorWatchSyncService';
import { presentShoreWatchStatus, type ShoreWatchStatusPresentation } from './anchor-watch/shoreWatchStatus';
import {
    boatGpsDiagnosticSource,
    presentWeatherPositionBox,
    type WeatherPositionBox,
} from './gpsDiagnosticsPresentation';
import { PHONE_LIVE_FIX_MAX_AGE_MS } from './gpsFixState';
import { useWeatherOptional } from '../context/WeatherContext';
import { CORNER_STATUS_DOT_CLASS } from './map/cornerStatusDot';
import { Button } from './ui/Button';

// ── Types ──

interface SystemState {
    shoreWatch: ShoreWatchStatusPresentation;
    gpsTracking: {
        active: boolean;
        isMoving: boolean;
        intervalMs: number;
        isRapidMode: boolean;
        gpsStatus: string;
    };
    anchorWatch: {
        active: boolean;
        state: 'idle' | 'holding' | 'drifting' | 'alarm';
        distance: number;
        swingRadius: number;
    };
    nmea: {
        active: boolean;
        detail: string;
        /** There is a diagnosed fault, as opposed to simply being switched off. */
        faulted: boolean;
        showRates: boolean;
    };
    extGps: GpsReceiverStatus;
    followRoute: {
        active: boolean;
        origin: string;
        destination: string;
        routeChanged: boolean;
        isRefreshing: boolean;
    };
    piCache: {
        active: boolean;
        reachable: boolean;
        host: string;
        latencyMs: number;
        cacheStats?: {
            kvEntries: number;
            tileEntries: number;
            dbSizeMB: number;
        };
    };
    n2k: {
        active: boolean; // reachable AND health is green/amber (not red)
        reachable: boolean;
        health: 'red' | 'amber' | 'green' | null;
        summary: string | null;
        pathsSeen: number;
        pathsTotal: number;
    };
}

// ── Helpers ──

function formatIntervalLabel(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
}

const GpsQualityPanel: React.FC<{
    phoneFixRef: React.MutableRefObject<GpsPosition | null>;
    receiver: GpsReceiverStatus;
}> = ({ phoneFixRef, receiver }) => {
    // The weather's copy of the followed receiver's fix joins that receiver's
    // card, so the header row and the card read one timestamp (UX referee
    // run 8, gps-one-truth: 'fix just now' over 'Last position 46 s ago').
    const weatherFix = useWeatherOptional()?.positionSource ?? null;
    const read = useCallback((): WeatherPositionBox => {
        const now = Date.now();
        const boat =
            boatGpsDiagnosticSource(NmeaStore.getState()) ??
            (receiver.kind === 'vessel-nmea'
                ? {
                      label: 'Boat GPS',
                      maxAgeMs: 13_000,
                      positionAt: null,
                  }
                : null);
        const phone = phoneFixRef.current;
        return presentWeatherPositionBox({
            now,
            boat,
            phone: {
                label: 'Phone location',
                phone: true,
                maxAgeMs: PHONE_LIVE_FIX_MAX_AGE_MS,
                positionAt: phone?.timestamp ?? null,
                accuracyM: phone ? { value: phone.accuracy, timestamp: phone.timestamp } : null,
            },
            weather: weatherFix,
        });
    }, [phoneFixRef, receiver, weatherFix]);
    const [box, setBox] = useState(read);
    useEffect(() => {
        const refresh = () => {
            if (!document.hidden) setBox(read());
        };
        const unsubscribe = NmeaStore.subscribe(refresh);
        const timer = setInterval(refresh, 1000);
        document.addEventListener('visibilitychange', refresh);
        refresh();
        return () => {
            unsubscribe();
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [read]);
    return (
        <GpsDiagnosticsCards
            sources={box.sources}
            receiver={receiver}
            positionSource={<GpsSourceRow compact fixes={box.fixes} />}
        />
    );
};

// ── SystemStatusModal ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The version line in plain words: "Version 1.2.0 (106)" in the iPhone app,
 * "Version 1.2.0 · built 26 Sep, 18:55" on the web build, whose build is a
 * bundle stamp — 'built', as Settings says it, so the time is not read as a
 * last-checked or last-synced time (UX scorecard run 9). appBuildLabel says "1.2.0 (2026-09-26 08:55Z) · web", which read as a
 * developer string (UX scorecard run 7: 'Z' and '· browser'). The build stays
 * on screen because it is what tells two builds of one version apart (Shane
 * 2026-08-28); the raw label still goes, untouched, to the feedback link.
 */
export function plainBuildLabel(label: string): string {
    const parts = /^(.+?) \((.*)\) · \w+$/.exec(label.trim());
    if (!parts) return `Version ${label.replace(/ · \w+$/, '')}`;
    const [, version, build] = parts;
    const stamp = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})Z$/.exec(build);
    if (stamp) {
        const when = new Date(`${stamp[1]}T${stamp[2]}:00Z`);
        if (!Number.isNaN(when.getTime())) {
            const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
            return `Version ${version} · built ${when.getDate()} ${MONTHS[when.getMonth()]}, ${time}`;
        }
    }
    return !build || build === 'unknown' ? `Version ${version}` : `Version ${version} (${build})`;
}

const SystemStatusModal: React.FC<{
    state: SystemState;
    onClose: () => void;
    onNavigateAnchor: () => void;
    onStopFollowing: () => void;
    onAcceptChange: () => void;
    phoneFixRef: React.MutableRefObject<GpsPosition | null>;
}> = ({ state, onClose, onNavigateAnchor, onStopFollowing, onAcceptChange, phoneFixRef }) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });
    /* Resolved once when the panel opens — App.getInfo() is a native round
       trip and the answer cannot change while the app is running. */
    const [buildLabel, setBuildLabel] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        void appBuildLabel()
            .then((raw) => {
                const label = plainBuildLabel(raw);
                if (alive) setBuildLabel(label);
            })
            .catch(() => {
                /* a missing version is not worth an error in a status panel */
            });
        return () => {
            alive = false;
        };
    }, []);
    const activeCount = [
        state.shoreWatch.active,
        state.gpsTracking.active,
        state.anchorWatch.active,
        state.nmea.active,
        state.extGps.active,
        state.followRoute.active,
        state.piCache.active,
        // Same rule as the header button's badge (N2K counts only when green),
        // so the panel never says one more than the badge that opened it.
        state.n2k.active && state.n2k.health === 'green',
    ].filter(Boolean).length;
    const nmeaDot = state.nmea.active ? 'bg-emerald-400' : state.nmea.faulted ? 'bg-rose-400' : 'bg-slate-600';

    return createPortal(
        <div
            className="fixed inset-0 z-9999 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
            role="presentation"
        >
            {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen").
                Header and footer stay put and the systems scroll between them, so
                the bottom Close is always in thumb reach (UX scorecard run 7). */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="system-status-title"
                className="flex w-full max-w-md max-h-[80dvh] flex-col overflow-hidden bg-slate-900/95 border border-white/15 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex shrink-0 items-center justify-between px-5 pt-5 pb-3 bg-slate-900/95 border-b border-white/6">
                    <div className="flex items-center gap-2">
                        <div
                            aria-hidden="true"
                            className="w-7 h-7 rounded-full bg-sky-500/20 flex items-center justify-center"
                        >
                            <InfoIcon className="w-4 h-4 text-sky-400" />
                        </div>
                        <h2 id="system-status-title" className="text-base font-bold text-white tracking-tight">
                            System status
                        </h2>
                        {/* No "0 active" pill: with nothing running the rows below
                            already say "Not tracking", "Not deployed" and so on,
                            and the header button hides its badge at zero too. */}
                        {activeCount > 0 && (
                            <span className="text-xs font-bold text-sky-400 bg-sky-500/15 px-1.5 py-0.5 rounded-lg">
                                {activeCount} active
                            </span>
                        )}
                    </div>
                    <button
                        ref={closeButtonRef}
                        onClick={onClose}
                        aria-label="Close system status"
                        className="hit-target-44 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                {/* Systems */}
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-3">
                    {state.shoreWatch.active && (
                        <section aria-label="Shore Watch status" className="space-y-2">
                            <ul role="list" className={SYSTEM_LIST_CLASS}>
                                <SystemRow
                                    icon={<AnchorIcon className="w-4 h-4" />}
                                    label="Shore watch"
                                    active
                                    detail={state.shoreWatch.label}
                                    dotColor={
                                        state.shoreWatch.tone === 'red'
                                            ? 'bg-red-400'
                                            : state.shoreWatch.tone === 'yellow'
                                              ? 'bg-amber-400'
                                              : 'bg-sky-400'
                                    }
                                    pulse
                                    action={{ label: 'View', onClick: onNavigateAnchor }}
                                />
                            </ul>
                            <p className="px-3 text-xs leading-relaxed text-slate-200" role="status">
                                {state.shoreWatch.detail}
                            </p>
                            <p
                                className={`px-3 text-xs leading-relaxed ${state.shoreWatch.notificationsReady ? 'text-slate-400' : 'text-amber-300'}`}
                            >
                                {state.shoreWatch.notificationDetail}
                            </p>
                            {!state.shoreWatch.notificationsReady && (
                                <button
                                    type="button"
                                    disabled={state.shoreWatch.notificationsChecking}
                                    onClick={() => void AnchorWatchSyncService.refreshPushReadiness()}
                                    className="min-h-11 rounded-lg px-3 text-xs font-bold text-sky-300 hover:bg-white/5 disabled:opacity-50"
                                >
                                    {state.shoreWatch.notificationsChecking ? 'Checking…' : 'Retry notifications'}
                                </button>
                            )}
                            {(state.shoreWatch.reminderError || state.shoreWatch.reminderPending) && (
                                <div className="rounded-xl border border-amber-400/40 bg-amber-950/30 p-3">
                                    <p
                                        role={state.shoreWatch.reminderError ? 'alert' : 'status'}
                                        className="text-sm text-amber-200"
                                    >
                                        {state.shoreWatch.reminderError ||
                                            'Confirming that repeating notifications are stopped for this phone…'}
                                    </p>
                                    <button
                                        className="mt-2 min-h-11 rounded-lg bg-amber-500/15 px-3 text-sm font-bold text-amber-200 disabled:opacity-50"
                                        disabled={state.shoreWatch.reminderPending}
                                        onClick={() => {
                                            void ShoreWatchAlarmService.retryReminderAcknowledgement().catch(() => {
                                                // The service retains the actionable error for this session.
                                            });
                                        }}
                                    >
                                        {state.shoreWatch.reminderPending
                                            ? 'Confirming…'
                                            : 'Retry stopping phone reminders'}
                                    </button>
                                </div>
                            )}
                            <details className="rounded-xl border border-white/10 bg-white/3 px-3 text-xs leading-relaxed text-slate-300">
                                <summary
                                    tabIndex={0}
                                    className="min-h-11 cursor-pointer rounded-lg py-3 font-semibold text-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
                                >
                                    Notifications &amp; safety
                                </summary>
                                <div className="space-y-2 pb-3">
                                    <p>Notification registration does not confirm delivery.</p>
                                    <p>
                                        Ordinary notifications do not bypass Silent mode. Focus, volume and notification
                                        settings also affect sound.
                                    </p>
                                    <p>
                                        With the updated iPhone app, urgent notifications repeat roughly every 1–2
                                        minutes until acknowledged or cleared. This is not an uninterrupted alarm. The
                                        bundled 24-second siren may not play in full.
                                    </p>
                                    <p>
                                        Both the boat and phone need power and internet. Each watch expires after 24
                                        hours; start a new watch to continue.
                                    </p>
                                </div>
                            </details>
                        </section>
                    )}
                    {/* Which GPS the app is reading — a boat or a phone with a
                        fix dot, and the sentence beside it. Shane 2026-09-08:
                        "lets move the phone or vessel gps icon into the i
                        section, rather than sticking yet another fab on the
                        already jam packed screen." */}
                    <GpsQualityPanel phoneFixRef={phoneFixRef} receiver={state.extGps} />
                    <PassageHudInfoCard />
                    {/* Plain list rows, not cards: only a row with a button does
                        anything, and the cards made the inert ones look as
                        tappable as the NMEA row (UX scorecard run 7). */}
                    <ul role="list" aria-label="Systems" className={SYSTEM_LIST_CLASS}>
                        {/* ── GPS Tracking (Passage) ── */}
                        <SystemRow
                            icon={
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <circle cx="12" cy="12" r="3" />
                                    <path strokeLinecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2" />
                                </svg>
                            }
                            label="GPS tracking"
                            active={state.gpsTracking.active}
                            detail={
                                state.gpsTracking.active
                                    ? `${state.gpsTracking.isMoving ? 'Moving' : 'Stationary'} · ${formatIntervalLabel(state.gpsTracking.isRapidMode ? 5000 : state.gpsTracking.intervalMs || 900_000)} interval${state.gpsTracking.isRapidMode ? ' · rapid' : ''}`
                                    : 'Not tracking'
                            }
                            dotColor={
                                state.gpsTracking.active
                                    ? state.gpsTracking.isMoving
                                        ? 'bg-emerald-400'
                                        : 'bg-red-400'
                                    : 'bg-slate-600'
                            }
                            pulse={state.gpsTracking.active}
                        />

                        {/* ── Anchor Watch ── */}
                        {/* Row titles in sentence case, like 'GPS tracking' and
                            'Following route' beside them (UX scorecard run 8). */}
                        <SystemRow
                            icon={<AnchorIcon className="w-4 h-4" />}
                            label="Anchor watch"
                            active={state.anchorWatch.active}
                            detail={
                                state.anchorWatch.active
                                    ? `${state.anchorWatch.state === 'alarm' ? 'ALARM' : state.anchorWatch.state === 'drifting' ? 'Drifting' : 'Holding'} · ${Math.round(state.anchorWatch.distance)}m / ${Math.round(state.anchorWatch.swingRadius)}m radius`
                                    : 'Not deployed'
                            }
                            dotColor={
                                state.anchorWatch.active
                                    ? state.anchorWatch.state === 'holding'
                                        ? 'bg-emerald-400'
                                        : 'bg-red-400'
                                    : 'bg-slate-600'
                            }
                            pulse={state.anchorWatch.active && state.anchorWatch.state !== 'holding'}
                            action={state.anchorWatch.active ? { label: 'View', onClick: onNavigateAnchor } : undefined}
                        />

                        {/* ── NMEA Connection ── */}
                        <SystemRow
                            icon={
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0"
                                    />
                                </svg>
                            }
                            // The page it opens is the NMEA Gateway; 'Backbone' was a
                            // second name for the same thing (UX scorecard run 7).
                            label="NMEA gateway"
                            active={state.nmea.active}
                            detail={state.nmea.detail}
                            dotColor={nmeaDot}
                            /* An inactive or quiet feed is not a diagnosed fault.
                           Healthy Pi feeds do not need a second gateway socket. */
                            action={
                                state.nmea.active
                                    ? undefined
                                    : {
                                          label: state.nmea.faulted ? 'Fix' : 'View',
                                          onClick: () =>
                                              window.dispatchEvent(
                                                  new CustomEvent('thalassa:navigate', { detail: { tab: 'nmea' } }),
                                              ),
                                      }
                            }
                            /* Feed-rate sparklines, for the direct socket only: Pi
                               snapshots do not populate its sentence counters. The
                               two bars tell "GPS is slow" (top bar gappy/red) from
                               "the whole feed is dropping" (both gappy/red): Wi-Fi
                               packet loss, YachtSense client-management cycles and
                               slow GPS broadcast rates. */
                            extra={
                                state.nmea.showRates ? (
                                    <div className="space-y-1.5 pt-2">
                                        <NmeaRateSparkline
                                            category="gps"
                                            label="GPS sentences / sec"
                                            expectedRate={1.0}
                                        />
                                        <NmeaRateSparkline category="all" label="All NMEA / sec" expectedRate={5.0} />
                                    </div>
                                ) : undefined
                            }
                        />

                        {/* ── Follow Route (Passage Planning) ── */}
                        <SystemRow
                            icon={<RouteIcon className="w-4 h-4" />}
                            label="Following route"
                            active={state.followRoute.active}
                            detail={
                                state.followRoute.active
                                    ? `${state.followRoute.origin} → ${state.followRoute.destination}${state.followRoute.routeChanged ? ' · Updated' : state.followRoute.isRefreshing ? ' · Refreshing...' : ''}`
                                    : 'No active route'
                            }
                            dotColor={
                                state.followRoute.active
                                    ? state.followRoute.routeChanged
                                        ? 'bg-amber-400'
                                        : 'bg-sky-400'
                                    : 'bg-slate-600'
                            }
                            pulse={state.followRoute.active && state.followRoute.routeChanged}
                            action={
                                state.followRoute.active
                                    ? state.followRoute.routeChanged
                                        ? { label: 'Accept', onClick: onAcceptChange }
                                        : { label: 'Stop', onClick: onStopFollowing, destructive: true }
                                    : undefined
                            }
                        />

                        {/* ── Pi Cache (Offline Data) ── */}
                        {PI_INTEGRATION_ENABLED && (
                            <SystemRow
                                icon={
                                    <svg
                                        className="w-4 h-4"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={1.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0h.375a2.625 2.625 0 010 5.25H3.375a2.625 2.625 0 010-5.25H3.75"
                                        />
                                    </svg>
                                }
                                label="Pi cache"
                                active={state.piCache.active}
                                detail={
                                    state.piCache.active
                                        ? `${state.piCache.host} · ${state.piCache.latencyMs}ms${state.piCache.cacheStats ? ` · ${state.piCache.cacheStats.kvEntries} weather + ${state.piCache.cacheStats.tileEntries} tiles cached` : ''}`
                                        : 'Not connected'
                                }
                                dotColor={state.piCache.active ? 'bg-emerald-400' : 'bg-slate-600'}
                                pulse={state.piCache.active}
                            />
                        )}

                        {/* ── NMEA 2000 Bus (PiCAN-M Hat → SignalK) ── */}
                        {/* Only render when we have anything useful to say. */}
                        {/* Reachable means we got a valid response from the */}
                        {/* Pi's /api/n2k/status endpoint at least once. */}
                        {PI_INTEGRATION_ENABLED && state.n2k.reachable && (
                            <SystemRow
                                icon={
                                    <svg
                                        className="w-4 h-4"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        {/* CAN-bus motif: H/L pair + termination */}
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M3 9h18M3 15h18M6 5v14M18 5v14"
                                        />
                                    </svg>
                                }
                                label="NMEA 2000"
                                active={state.n2k.active}
                                detail={
                                    state.n2k.summary ||
                                    (state.n2k.health === 'green'
                                        ? `Live · ${state.n2k.pathsSeen}/${state.n2k.pathsTotal} paths`
                                        : 'Bus quiet')
                                }
                                dotColor={
                                    state.n2k.health === 'green'
                                        ? 'bg-emerald-400'
                                        : state.n2k.health === 'amber'
                                          ? 'bg-amber-400'
                                          : state.n2k.health === 'red'
                                            ? 'bg-red-400'
                                            : 'bg-slate-600'
                                }
                                pulse={state.n2k.health === 'green'}
                            />
                        )}
                    </ul>
                    {/* What build this actually is. The last line, quiet, and
                        always present: a version you have to go and find is a
                        version nobody knows. */}
                    <p className="pt-1 text-center text-xs font-medium tracking-wide text-slate-400">
                        {buildLabel ?? 'Version …'}
                    </p>
                </div>

                {/* The same full-width bottom Close as the pin and model dialogs:
                    the corner × is out of one-handed reach on a 640 pt panel. */}
                <div className="shrink-0 border-t border-white/6 px-4 py-3">
                    <Button onClick={onClose} className="w-full text-slate-300">
                        Close
                    </Button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

// ── Individual System Row ──

/** Read the instrument route, not just the intentionally-idle phone socket. */
function readNmeaBackboneStatus(): SystemState['nmea'] {
    return deriveNmeaBackboneStatus({
        store: NmeaStore.getState(),
        directStatus: NmeaListenerService.getStatus(),
        deviceLabel: NmeaListenerService.getConnectionInfo().deviceLabel,
        lastError: NmeaListenerService.getLastError(),
        viaRemoteAccess: piCache.viaRemoteAccess,
    });
}

/** The systems list: one grouped surface, rows divided by hairlines. */
const SYSTEM_LIST_CLASS = 'divide-y divide-white/6 overflow-hidden rounded-xl border border-white/8 bg-white/2';

const SystemRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    active: boolean;
    detail: string;
    dotColor: string;
    pulse?: boolean;
    action?: { label: string; onClick: () => void; destructive?: boolean };
    /** Shown under the row, inside the same list item (the NMEA rate bars). */
    extra?: React.ReactNode;
}> = ({ icon, label, active, detail, dotColor, pulse, action, extra }) => (
    <li className="px-3 py-3">
        <div className="flex items-center gap-3">
            {/* Status dot: decoration, the detail line says the state in words. */}
            <div aria-hidden="true" className="relative shrink-0">
                <span className={`block w-2.5 h-2.5 rounded-full ${dotColor} transition-colors`} />
                {pulse && (
                    <span className={`absolute inset-0 rounded-full ${dotColor} motion-safe:animate-ping opacity-50`} />
                )}
            </div>

            {/* Icon: decoration, the label names the system. */}
            <div aria-hidden="true" className={`shrink-0 ${active ? 'text-white' : 'text-slate-400'}`}>
                {icon}
            </div>

            {/* Text */}
            <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${active ? 'text-white' : 'text-slate-300'}`}>{label}</p>
                {/* Two lines, not one truncated: the NMEA fault sentence and the
                    anchor distance are the whole point of the row. */}
                <p className="text-xs leading-snug mt-0.5 line-clamp-2 text-slate-300">{detail}</p>
            </div>

            {/* Action button */}
            {action && (
                <button
                    type="button"
                    /* Was hard-coded to "View signal propagation forecast" on
                       EVERY row, so a screen reader announced the anchor's View
                       button and the route's Stop button as a propagation
                       forecast, which is neither. Two buttons also cannot share
                       one accessible name and stay addressable; adding a third
                       is what surfaced it. Named from the row it belongs to. */
                    aria-label={`${action.label} ${label}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        action.onClick();
                    }}
                    className={`shrink-0 min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-lg text-sm font-bold transition-all active:scale-95 ${
                        action.destructive
                            ? 'bg-red-500/15 border border-red-500/30 text-red-300'
                            : 'bg-sky-500/15 border border-sky-500/30 text-sky-300'
                    }`}
                >
                    {action.label}
                </button>
            )}
        </div>
        {extra}
    </li>
);

// ── Main Button Component ──

interface SystemStatusButtonProps {
    currentView: string;
    onNavigateAnchor: () => void;
    /**
     * Keep the FAB mounted even with nothing active (Shane 2026-08-24: "can we
     * ensure that the 'i' fab is always showing in this page").
     *
     * Everywhere else it hides at zero, which is right for a header that has
     * other content — an info button reporting nothing is clutter. On the
     * CHART it is not clutter: it is a fixed landmark in a column of FABs, and
     * the radial helm menu below it positions itself relative to where this
     * sits. A control that vanishes when the boat happens to be alongside
     * moves everything under it, and the punter loses the route into system
     * status exactly when they are setting the boat up.
     */
    alwaysShow?: boolean;
}

export const SystemStatusButton: React.FC<SystemStatusButtonProps> = ({
    currentView,
    onNavigateAnchor,
    alwaysShow = false,
}) => {
    const [showModal, setShowModal] = useState(false);
    const shoreWatch = useSyncExternalStore(ShoreWatchAlarmService.subscribe, ShoreWatchAlarmService.getSnapshot);
    const [shorePush, setShorePush] = useState(() => AnchorWatchSyncService.getPushReadiness());
    useEffect(() => AnchorWatchSyncService.onPushReadinessChange(setShorePush), []);
    const phoneFixRef = useRef<GpsPosition | null>(null);
    // Stop-follow confirmation modal removed 2026-05-19 — the action
    // is reversible (just re-tap Follow on the voyage card) so a
    // confirmation step was pure friction.

    // ── Aggressive Pi status refresh while the modal is open ─────────
    // The background health check runs every 30s. That's fine for steady-
    // state but means a just-disconnected Pi still reads as "connected" to
    // any user who opens the modal within 30s of pulling the plug. Force an
    // immediate ping on open and poll every 5s while the modal is visible
    // so the indicator tracks reality within ~5s of a state change.
    useEffect(() => {
        if (!showModal) return;
        // Keep the existing shared cloud reader alive while this panel needs
        // it, even if the instrument screen itself is closed. RLS and the
        // Pi-first store ordering still govern what this account can receive.
        CloudTelemetryService.retain();
        // Immediate fresh ping on open — both Pi services in parallel.
        piCache.ping().catch(() => {
            /* ping errors already drive the listener → reachable=false */
        });
        n2kStatus.refresh().catch(() => {
            /* same — n2kStatus listener handles unreachable */
        });
        const id = setInterval(() => {
            if (document.hidden) return;
            piCache.ping().catch(() => {});
            // N2K bus state changes on minutes timescales; 5s polling
            // would burn battery for no signal. Stay on the 30s
            // background cadence even while the modal is open.
        }, 5_000);
        return () => {
            clearInterval(id);
            CloudTelemetryService.release();
        };
    }, [showModal]);

    // ── GPS Tracking state ──
    const [gpsTracking, setGpsTracking] = useState(() => ShipLogService.getTrackingStatus());
    const [isMoving, setIsMoving] = useState(false);

    // ── Anchor Watch state ──
    const [anchorSnapshot, setAnchorSnapshot] = useState<AnchorWatchSnapshot | null>(null);

    // ── NMEA state ──
    const [nmeaStatus, setNmeaStatus] = useState(readNmeaBackboneStatus);

    // ── GPS receiver identity + feed state ──
    // This is intentionally not inferred from accuracy alone. The service
    // distinguishes a live on-board NMEA feed, an iOS accessory supplying the
    // current Core Location fix, a connected-but-not-used MFi GPS, and a
    // merely high-precision (unnamed) source.
    const [gpsReceiver, setGpsReceiver] = useState(() => GpsReceiverStatusService.getStatus());

    // ── Follow Route state ──
    const {
        isFollowing,
        voyagePlan,
        routeChanged,
        isRefreshing: routeRefreshing,
        stopFollowing,
        acceptRouteChange,
    } = useFollowRoute();

    // ── Pi Cache state (silent — no toasts, it's a background service) ──
    const [piStatus, setPiStatus] = useState<PiCacheStatus | null>(null);

    useEffect(() => {
        const unsub = piCache.onStatusChange((status) => {
            setPiStatus(status);
        });

        // Seed initial state — previously this was gated on
        // `if (initial.reachable)` which was wrong: if the Pi was unreachable
        // at mount, piStatus stayed null and the modal couldn't tell the
        // difference between "never checked" and "checked, not reachable".
        // Always seeding gives the derived state a concrete value to render.
        setPiStatus(piCache.getStatus());

        return unsub;
    }, []);

    // ── NMEA 2000 bus health (Bosun /api/n2k/status) ──
    // Polls the Pi every 30s for the SocketCAN + SignalK rollup. The
    // service returns a cached snapshot synchronously via getStatus()
    // so the modal renders something on first paint.
    const [n2kSnap, setN2kSnap] = useState<N2kStatus>(() => n2kStatus.getStatus());
    useEffect(() => {
        const unsub = n2kStatus.onStatusChange(setN2kSnap);
        n2kStatus.start();
        // We never call n2kStatus.stop() — it's a long-running background
        // service for the lifetime of the app. SystemStatusButton mounts
        // once at the header level so there's no remount churn.
        return unsub;
    }, []);

    // ── Passive GPS accuracy feed ──
    useEffect(() => {
        const unsub = GpsService.watchPosition((pos) => {
            phoneFixRef.current = pos;
            if (pos.accuracy > 0) {
                GpsPrecision.feed(pos.accuracy);
            }
        });
        return unsub;
    }, []);

    // ── Poll all system states ──
    //
    // Cadence: 5 s (was 1 s). This effect is always mounted because
    // SystemStatusButton lives in the App header on every page. At
    // the old 1 Hz cadence it was firing a bundle of setState calls per
    // second for tracking, NMEA, and GPS-quality fields. All of the
    // values being read are synchronous in-memory state, so the
    // poll itself is cheap — but the React work isn't free, and
    // the data being polled (GPS lock state, NMEA bus status,
    // satellite count) changes at minute-timescales for marine
    // use, not millisecond. 5 s is plenty.
    //
    // Subscriptions update immediately; the poll also ages cached Pi/cloud
    // snapshots if no more samples arrive. Do not repaint the header for
    // every instrument sample when the displayed diagnosis is unchanged.
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe(setAnchorSnapshot);
        const refreshNmea = () => {
            const next = readNmeaBackboneStatus();
            setNmeaStatus((prev) =>
                prev.active === next.active &&
                prev.detail === next.detail &&
                prev.faulted === next.faulted &&
                prev.showRates === next.showRates
                    ? prev
                    : next,
            );
        };
        const nmeaUnsub = NmeaListenerService.onStatusChange(refreshNmea);
        const instrumentsUnsub = NmeaStore.subscribe(refreshNmea);

        let disposed = false;
        const refresh = () => {
            if (document.hidden) return;

            // GPS Tracking
            // getTrackingStatus()/refresh() hand back a fresh object every
            // call, so without this compare React re-rendered the always-mounted
            // header FAB every 5 s on identical data.
            const ts = ShipLogService.getTrackingStatus();
            setGpsTracking((prev) =>
                prev.isTracking === ts.isTracking &&
                prev.currentIntervalMs === ts.currentIntervalMs &&
                prev.isRapidMode === ts.isRapidMode
                    ? prev
                    : ts,
            );
            const nav = ShipLogService.getGpsNavData();
            setIsMoving(nav.sogKts !== null && nav.sogKts > 0.5);

            // NMEA
            refreshNmea();

            // GPS receiver / accessory identity. This reads the native
            // Transistorsoft location cache; it does not wake GPS or scan
            // Bluetooth. Check staleness before resolving the precision
            // fallback so an old fix cannot keep a receiver row lit.
            GpsPrecision.checkStaleness();
            void GpsReceiverStatusService.refresh().then((status) => {
                if (!disposed)
                    setGpsReceiver((prev) =>
                        prev.active === status.active &&
                        prev.kind === status.kind &&
                        prev.label === status.label &&
                        prev.detail === status.detail
                            ? prev
                            : status,
                    );
            });
        };

        // Seed immediately instead of leaving the first five seconds to a
        // timing lottery — particularly noticeable just after a Bad Elf or
        // boat Wi-Fi connection comes up.
        refresh();
        const id = setInterval(refresh, 5_000);

        // Refresh the instant the app comes back to the foreground. The poll
        // is gated on document.hidden, so after a backgrounded stretch every
        // receiver row could sit up to 5 s stale — long enough to read as
        // "the app doesn't see my Bad Elf" when the skipper flips back to
        // check. WKWebView fires visibilitychange on Capacitor app
        // foreground/background, so this needs no native listener.
        const onVisibility = () => {
            if (!document.hidden) refresh();
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            disposed = true;
            unsub();
            nmeaUnsub();
            instrumentsUnsub();
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, []);

    // ── Build system state ──
    const systemState: SystemState = useMemo(
        () => ({
            shoreWatch: presentShoreWatchStatus(shoreWatch, shorePush),
            gpsTracking: {
                active: gpsTracking.isTracking,
                isMoving,
                intervalMs: gpsTracking.currentIntervalMs || 900_000,
                isRapidMode: gpsTracking.isRapidMode || false,
                gpsStatus: ShipLogService.getGpsStatus(),
            },
            anchorWatch: {
                active: !!anchorSnapshot && anchorSnapshot.state !== 'idle' && currentView !== 'compass',
                state: anchorSnapshot
                    ? anchorSnapshot.state === 'alarm' || !!anchorSnapshot.alarmTriggeredAt
                        ? 'alarm'
                        : (anchorSnapshot.distanceFromAnchor ?? 0) > (anchorSnapshot.swingRadius ?? 50)
                          ? 'drifting'
                          : anchorSnapshot.state === 'idle'
                            ? 'idle'
                            : 'holding'
                    : 'idle',
                distance: anchorSnapshot?.distanceFromAnchor ?? 0,
                swingRadius: anchorSnapshot?.swingRadius ?? 0,
            },
            nmea: nmeaStatus,
            extGps: gpsReceiver,
            followRoute: {
                active: isFollowing && !!voyagePlan,
                origin: voyagePlan?.origin?.split(',')[0] || 'Origin',
                destination: voyagePlan?.destination?.split(',')[0] || 'Destination',
                routeChanged: routeChanged || false,
                isRefreshing: routeRefreshing || false,
            },
            piCache: {
                active: !!piStatus?.reachable,
                reachable: !!piStatus?.reachable,
                host: piStatus?.discoveredVia || '',
                latencyMs: piStatus?.latencyMs || 0,
                cacheStats: piStatus?.cacheStats
                    ? {
                          kvEntries: piStatus.cacheStats.kvEntries,
                          tileEntries: piStatus.cacheStats.tileEntries,
                          dbSizeMB: piStatus.cacheStats.dbSizeMB,
                      }
                    : undefined,
            },
            n2k: {
                // "Active" means the row gets full opacity. Green +
                // amber are both worth highlighting (amber = wired but
                // bench / no traffic, still informative). Red and
                // unreachable get the dim treatment.
                active: n2kSnap.reachable && n2kSnap.health !== null && n2kSnap.health !== 'red',
                reachable: n2kSnap.reachable,
                health: n2kSnap.health,
                summary: n2kSnap.summary,
                pathsSeen: n2kSnap.pathsSeen,
                pathsTotal: n2kSnap.pathsTotal,
            },
        }),
        [
            shoreWatch,
            shorePush,
            gpsTracking,
            isMoving,
            anchorSnapshot,
            currentView,
            nmeaStatus,
            gpsReceiver,
            isFollowing,
            voyagePlan,
            routeChanged,
            routeRefreshing,
            piStatus,
            n2kSnap,
        ],
    );

    // ── Active count ──
    const activeCount = [
        systemState.shoreWatch.active,
        systemState.gpsTracking.active,
        systemState.anchorWatch.active,
        systemState.nmea.active,
        systemState.extGps.active,
        systemState.followRoute.active,
        systemState.piCache.active,
        // N2K only counts toward "active systems" when actually green
        // (live traffic) — amber/bench mode shouldn't promote the FAB
        // visibility.
        systemState.n2k.active && systemState.n2k.health === 'green',
    ].filter(Boolean).length;

    // Always present. It used to hide at zero active systems (an info button
    // reporting nothing was clutter), but since 2026-09-08 it is where the
    // punter finds which GPS the app is reading, and that is never nothing
    // (Shane: "once punters know where to look, they will find it"). The count
    // badge appears from ONE: it used to wait for two, so one active system
    // looked identical to none while the name announced "1 active".
    void alwaysShow;

    // Has urgent status (anchor alarm, route changed)?
    const hasUrgent =
        (systemState.anchorWatch.active && systemState.anchorWatch.state !== 'holding') ||
        (systemState.followRoute.active && systemState.followRoute.routeChanged);
    // Fresh boat data gets a gentle blue heartbeat, waiting is amber, and a
    // lost link/GPS or drag alarm is red. Existing urgent systems still take
    // precedence over an otherwise healthy blue Shore Watch connection.
    const fabTone =
        systemState.shoreWatch.active && systemState.shoreWatch.tone === 'red'
            ? 'red'
            : hasUrgent || (systemState.shoreWatch.active && systemState.shoreWatch.tone === 'yellow')
              ? 'yellow'
              : 'blue';
    // Healthy is quiet: slate glass with a sky glyph, like the chart's other
    // buttons. The saturated sky fill was the loudest control on the Glass and
    // the chart after MOB, read as a 'broadcasting' toggle, and its white glyph
    // measured 2.9:1 (UX scorecard run 7). Full fills are kept for the states
    // that need attention, with a glyph that clears 4.5:1 on them.
    const toneClass = {
        blue: 'bg-slate-900/90 border-white/10 shadow-black/40 text-sky-300 backdrop-blur-md',
        yellow: 'bg-linear-to-br from-amber-400 to-amber-500 border-amber-300/50 shadow-amber-500/40 text-slate-950',
        red: 'bg-linear-to-br from-red-600 to-red-700 border-red-300/50 shadow-red-500/40 text-white',
    }[fabTone];

    return (
        <>
            <button
                onClick={() => setShowModal(true)}
                // Named for the dialog it opens, one name for both (UX scorecard
                // run 9: 'Systems and GPS source' opened 'System status').
                aria-label={`System status${activeCount > 0 ? `: ${activeCount} active` : ''}${systemState.shoreWatch.active ? ` · Shore Watch: ${systemState.shoreWatch.label}` : ''}`}
                aria-haspopup="dialog"
                aria-expanded={showModal}
                data-shore-status={systemState.shoreWatch.active ? systemState.shoreWatch.tone : undefined}
                data-tone={fabTone}
                className={`system-status-fab relative w-12 h-12 rounded-2xl flex items-center justify-center border shadow-2xl transition-all pointer-events-auto active:scale-[0.95] ${toneClass}`}
            >
                {/* Slow connection halo only for an active Shore Watch; no
                    constant animation for ordinary multi-system activity. */}
                {(hasUrgent || systemState.shoreWatch.active) && (
                    <span
                        aria-hidden="true"
                        data-testid="system-status-halo"
                        className={`absolute inset-[-4px] rounded-2xl opacity-40 pointer-events-none motion-safe:animate-pulse ${fabTone === 'red' ? 'bg-red-400' : fabTone === 'yellow' ? 'bg-amber-400' : 'bg-sky-400'}`}
                    />
                )}

                {/* Subtle inner highlight for depth, matching the glass aesthetic */}
                <span
                    aria-hidden="true"
                    className={`absolute inset-0 rounded-2xl bg-linear-to-b ${fabTone === 'blue' ? 'from-white/8' : 'from-white/25'} via-transparent to-transparent pointer-events-none`}
                />

                {/* A pulse/signal glyph, not a circle-i: Mapbox's own (i) sits a
                    few centimetres away on the chart and the two were being read
                    as the same control. This one says "systems and fix". */}
                <svg
                    className="relative w-6 h-6 drop-shadow-xs"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" />
                    <path d="M7.6 7.6a6.2 6.2 0 0 0 0 8.8M16.4 7.6a6.2 6.2 0 0 1 0 8.8" />
                    <path d="M4.4 4.4a10.7 10.7 0 0 0 0 15.2M19.6 4.4a10.7 10.7 0 0 1 0 15.2" opacity="0.55" />
                </svg>

                {/* Something is active: the shared corner dot (UX scorecard run 6). A numeral here read as unread alerts; the count stays in the aria-label. */}
                {activeCount > 0 && (
                    <span aria-hidden="true" data-testid="system-status-count" className={CORNER_STATUS_DOT_CLASS} />
                )}
            </button>

            {/* Modal */}
            {showModal && (
                <SystemStatusModal
                    phoneFixRef={phoneFixRef}
                    state={systemState}
                    onClose={() => setShowModal(false)}
                    onNavigateAnchor={() => {
                        setShowModal(false);
                        onNavigateAnchor();
                    }}
                    onStopFollowing={() => {
                        // Stop directly — no confirmation. Following a
                        // route is fully reversible (tap Follow on the
                        // voyage card again to resume), so a modal here
                        // is friction not safety. Removed 2026-05-19.
                        stopFollowing();
                        setShowModal(false);
                    }}
                    onAcceptChange={() => {
                        acceptRouteChange();
                        setShowModal(false);
                    }}
                />
            )}
        </>
    );
};
