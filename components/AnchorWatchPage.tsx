/**
 * @filesize-justified 3 view modes (setup/watching/shore) sharing 15+ state variables. Splitting would require a context or prop-drilling.
 */
/**
 * AnchorWatchPage — Premium anchor watch UI
 *
 * States:
 * - IDLE: Setup screen with anchor drop configuration
 * - WATCHING: Live monitoring with swing circle visualization
 * - ALARM: Full-screen drag alarm with distance info
 * - SHORE: Remote monitoring via Supabase Realtime sync
 *
 * Replaces the old CompassPage in the navigation.
 */

import { useRadioPosition } from '../hooks/useRadioPosition';
import React, { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react';
import { useWeather } from '../context/WeatherContext';
import { t } from '../theme';
import { useKeyboardScroll } from '../hooks/useKeyboardScroll';
import {
    AnchorWatchService,
    type AnchorPosition,
    type AnchorWatchSnapshot,
    type AnchorWatchConfig,
} from '../services/AnchorWatchService';
import type { AnchorAreaWarning, ChartAnswer } from '../services/anchorAreaCheck';
import {
    AnchorWatchSyncService,
    type SyncState,
    type SyncBroadcast,
    type PositionBroadcast,
} from '../services/AnchorWatchSyncService';
import { ShoreWatchAlarmService } from '../services/ShoreWatchAlarmService';
import { triggerHaptic } from '../utils/system';
import { SwingCircleCanvas } from './anchor-watch/SwingCircleCanvas';
import { ScopeRadar } from './anchor-watch/ScopeRadar';
import { SoundCheckModal } from './anchor-watch/SoundCheckModal';
import { ShoreWeighAnchorBar } from './anchor-watch/ShoreWeighAnchorBar';
import { ShoreWatchModal } from './anchor-watch/ShoreWatchModal';
import { ShoreWatchReadings } from './anchor-watch/ShoreWatchReadings';
import { loadAnchorAreaCheck, MoveAnchorSheet, type PiMoveSource } from './anchor-watch/MoveAnchorSheet';
import { MoveAnchorChip } from './anchor-watch/MoveAnchorChip';
import { useAnchorRadarTargets } from './anchor-watch/anchorRadarTargets';
import { PageHeader } from './ui/PageHeader';
import { toast } from './Toast';
import { createLogger } from '../utils/createLogger';
import {
    AnchorIcon,
    AlertTriangleIcon,
    CheckIcon,
    DeviceIcon,
    LockIcon,
    PhoneIcon,
    PowerBoatIcon,
    XIcon,
} from './Icons';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { gpsToBowMetres } from '../utils/gpsAntenna';
import { ShoreSwingTrail } from '../services/shoreSwingTrail';
import { SignInScreen } from './SignInScreen';

import { getWeatherRecommendation, formatDistance, bearingToCardinal, formatElapsed } from './anchor-watch/anchorUtils';
import { AnchorPiWatchKeeper, probePiWatchCapability } from '../services/anchorPiWatchKeeper';
import { piFixIsFresh } from '../services/anchorPiMove';
import { AnchorPiWatchOfferModal } from './anchor/AnchorPiWatchOfferModal';

const log = createLogger('AnchorWatch');

/**
 * The chart-area note is read for this long (126-07d), then a warning folds
 * to a chip on the radar and a quiet line goes, giving the readout back.
 */
const AREA_NOTE_READ_MS = 10_000;

/**
 * The setup sliders' track: an 8 px line in the middle of the 44 px touch box
 * (index.css gives every range a 44 px floor), filled in the slider's accent
 * up to the thumb and slate-500 beyond it (UX scorecard run 10: the whole box
 * was painted as the track, white on the pale daylight page at 1.16:1, with no
 * fill, so where 5 m sat in 1–30 m could not be read at a glance). Slate-500
 * holds 3:1 on both page colours. The same content-box paint as the comfort
 * sliders in Settings (VesselTab), so the two read as one control. The box is
 * a block (no inline descender gap under it) and rides up under its label row
 * (-10 px against the label's 4 px), so the drawn line sits 12 px below the
 * label rather than 22 px. The radius is 4 px across and 22 px down, so the
 * 8 px line inside the 18 px padding gets round 4 px caps; rounded-full left
 * the clipped line with pointed, lens-shaped ends.
 */
const RANGE_TRACK_CLASS =
    'block w-full -mt-[10px] [border-radius:4px/22px] appearance-none cursor-pointer bg-clip-content py-[18px] [--range-rest:#64748b]';
const RANGE_THUMB_PX = 28; // index.css: .anchor-setup-page input[type='range']::-webkit-slider-thumb
function rangeTrackStyle(fraction: number): React.CSSProperties {
    const f = Math.min(1, Math.max(0, fraction));
    // The fill ends under the thumb's centre, which travels from half a thumb
    // in from each end, so it never shows past the thumb or short of it.
    const stop = `calc(${RANGE_THUMB_PX / 2}px + (100% - ${RANGE_THUMB_PX}px) * ${f.toFixed(4)})`;
    return {
        touchAction: 'none',
        backgroundImage: `linear-gradient(to right, var(--range-fill) ${stop}, var(--range-rest) ${stop})`,
    };
}

/**
 * How long since the last position before the shore view stops calling it current.
 *
 * Sized to the SLOWEST vessel-side cadence, not the fastest. A vessel phone
 * broadcasts every five seconds, but the Pi broadcasts every ten
 * (anchorBroadcaster.BROADCAST_INTERVAL_MS), so the old 15s window was 1.5 Pi
 * intervals — a single late packet crossed it and the banner cried offline
 * between healthy updates. Three missed Pi intervals plus a margin.
 */
export const SHORE_DATA_STALE_MS = 35_000;

/** Reopening a page must not make an old boat fix look newly received. */
function shoreObservationTime(data: PositionBroadcast | null): number | null {
    if (!data) return null;
    const times = [data.timestamp, data.vessel?.timestamp];
    const now = Date.now();
    return times.every((time) => Number.isFinite(time) && time > 0 && time <= now + 30_000)
        ? Math.min(now, ...times)
        : null;
}

// ------- TYPES -------

type ViewMode = 'setup' | 'watching' | 'shore';

interface AnchorWatchPageProps {
    onBack?: () => void;
}

// ------- MAIN COMPONENT -------

export const AnchorWatchPage: React.FC<AnchorWatchPageProps> = React.memo(({ onBack }) => {
    const { weatherData } = useWeather();
    const authedUser = useAuthStore((state) => state.user);
    // Same fix word MOB and Radio show, from the hook they read (Shane: consistency with MOB).
    const radio = useRadioPosition();
    const fixWord =
        radio.position && radio.isFresh && !radio.error ? 'Ready' : radio.acquiring ? 'Finding GPS…' : 'No fix';
    // Said on the arming bar before the slide, not only after it: arming waits
    // for a fix (UX scorecard run 7).
    const armWaitHint = fixWord === 'Ready' ? null : fixWord === 'Finding GPS…' ? 'Finding GPS…' : 'Waits for GPS';
    const armWaitHintId = useId();
    const armTapHintId = useId();
    const shoreHintId = useId();
    const rodeTypeLabelId = useId();
    // The red pill by day: opaque red-50 with red-800 text, not red-700 on a
    // tint that measured 4.55:1 (UX scorecard run 7).
    const fixTone =
        radio.position && radio.isFresh && !radio.error
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
            : radio.acquiring
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
              : 'border-red-500/30 bg-red-500/10 text-red-400 [.display-light_&]:bg-red-50! [.display-light_&]:text-red-800!';
    const keyboardScrollRef = useKeyboardScroll<HTMLDivElement>();

    const [viewMode, setViewMode] = useState<ViewMode>(() => {
        const state = AnchorWatchSyncService.getState();
        return state.role === 'shore' && state.sessionCode ? 'shore' : 'setup';
    });
    /** Offer to let the boat's Pi keep the watch, asked once per anchor set. */
    const [showPiWatchOffer, setShowPiWatchOffer] = useState(false);
    const [piHandoffBusy, setPiHandoffBusy] = useState(false);
    /** The session the skipper already said "no, keep it here" about. */
    /** Whether the Pi says it can take the watch, so the row below can offer it. */
    const [piWatchCapable, setPiWatchCapable] = useState(false);
    const [piHasFix, setPiHasFix] = useState(false);
    /** Why the Pi cannot keep the watch, in the Pi's own words. Shown so a
     *  missing offer is a sentence on screen instead of silence. */
    const [piWatchReason, setPiWatchReason] = useState<string | null>(null);
    /** Whether the Pi HAS it. Mirrored into state because the keeper is not reactive. */
    const [piKeepingWatch, setPiKeepingWatch] = useState(false);
    /** The Move anchor sheet (build 123, must-do #3). */
    const [showMoveAnchor, setShowMoveAnchor] = useState(false);
    /** The same sheet for the watch this phone handed to the Pi (126-07a). */
    const [showPiMove, setShowPiMove] = useState(false);
    /**
     * 126-07d: the charted areas where anchoring is a problem that the anchor
     * just set is inside, found after the watch was armed, or that the chart
     * could not be looked at there. For that anchor only (its set time and
     * point), in memory; Dismiss clears it, and a warning folds to a chip.
     */
    const [areaNote, setAreaNote] = useState<{
        anchor: AnchorPosition;
        warnings: AnchorAreaWarning[];
        charts: ChartAnswer;
        all: boolean;
        folded: boolean;
    } | null>(null);
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot | null>(null);
    const [syncState, setSyncState] = useState<SyncState>(() => AnchorWatchSyncService.getState());
    const [shoreData, setShoreData] = useState<PositionBroadcast | null>(() =>
        AnchorWatchSyncService.getLatestPosition(),
    );
    const [shoreDataReceivedAt, setShoreDataReceivedAt] = useState<number | null>(() =>
        shoreObservationTime(AnchorWatchSyncService.getLatestPosition()),
    );
    const [shoreAlarm, setShoreAlarm] = useState(ShoreWatchAlarmService.getSnapshot);
    const [pushReadiness, setPushReadiness] = useState(() => AnchorWatchSyncService.getPushReadiness());
    /** Shore Watch reads in the viewer's own units, never the boat's (126-03a). */
    const units = useSettingsStore((state) => state.settings.units);
    /** Moving the Pi's mark is a trial until Shane's smoke aboard (126-07a, D6). */
    const piMoveTrial = useSettingsStore((state) => state.settings.anchorPiMoveTrial === true);
    /** The boat's GPS antenna aft of the bow, metres (Settings → Vessel → Dimensions, 126-07c). */
    const gpsToBowM = useSettingsStore((state) => gpsToBowMetres(state.settings.vessel));

    // Setup form state
    const [rodeLength, setRodeLength] = useState(30);
    const [waterDepth, setWaterDepth] = useState(5);
    const [rodeType, setRodeType] = useState<'chain' | 'rope' | 'mixed'>('chain');
    const [safetyMargin, _setSafetyMargin] = useState(10);
    const [sessionCode, setSessionCode] = useState('');
    const [showShoreModal, setShowShoreModal] = useState(false);
    const [showShoreSignIn, setShowShoreSignIn] = useState(false);

    // Sound check modal — shown once per session before first anchor set
    const [showSoundCheck, setShowSoundCheck] = useState(false);

    // AIS targets on anchor watch radar
    const [showAisOnRadar, setShowAisOnRadar] = useState(() => {
        try {
            return localStorage.getItem('thalassa_anchor_ais') !== 'off';
        } catch (e) {
            console.warn('Suppressed:', e);
            return true;
        }
    });

    // Canvas ref no longer needed — SwingCircleCanvas manages its own ref

    const [isSettingAnchor, setIsSettingAnchor] = useState(false);
    const [isRetryingMonitoring, setIsRetryingMonitoring] = useState(false);
    const [gpsStatus, setGpsStatus] = useState<string>('Waiting for GPS…');
    // First-time hint gate — read once per mount rather than on every
    // render (each slider tick and slide pointermove re-renders setup).
    const [armedOnce, setArmedOnce] = useState<boolean>(() => {
        try {
            return !!localStorage.getItem('thalassa_anchor_watch_armed_once');
        } catch {
            return false;
        }
    });

    // Weather-smart rode recommendation
    const wxRecommendation = useMemo(() => {
        const wind = weatherData?.current?.windSpeed ?? 0;
        const gust = weatherData?.current?.windGust ?? 0;
        const waveFt = weatherData?.current?.waveHeight ?? 0; // already in feet from transformer
        const waveM = waveFt / 3.28084; // convert back to meters for scope thresholds
        const rec = getWeatherRecommendation(wind, gust, waveM);
        const recRode = Math.min(100, Math.round(rec.scope * waterDepth));
        // The recommendation still falls back to the light-air scope, but the
        // strip must not print that fallback as a measured 0 kts.
        const windKnown = typeof weatherData?.current?.windSpeed === 'number';
        return { ...rec, rode: recRode, wind, gust, wave: waveFt, windKnown };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherData?.current?.windSpeed, weatherData?.current?.windGust, weatherData?.current?.waveHeight, waterDepth]);

    // Elapsed time ticker
    const [, setTick] = useState(0);
    const tickRef = useRef<ReturnType<typeof setInterval>>();

    // Subscribe to anchor watch state updates
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snap) => {
            setSnapshot(snap);
            // Functional update: one subscription for the page's lifetime
            // instead of tearing it down on every viewMode change.
            setViewMode((prev) => (snap.state === 'idle' && prev === 'watching' ? 'setup' : prev));
        });
        return unsub;
    }, []);

    // Subscribe to sync state and restore persisted sessions on mount
    useEffect(() => {
        let mounted = true;
        let observedSession = AnchorWatchSyncService.getState().sessionCode;
        const unsubState = AnchorWatchSyncService.onStateChange((state) => {
            setSyncState(state);
            if (state.sessionCode !== observedSession || state.role !== 'shore') {
                observedSession = state.sessionCode;
                const latest = state.role === 'shore' ? AnchorWatchSyncService.getLatestPosition() : null;
                setShoreData(latest);
                setShoreDataReceivedAt(shoreObservationTime(latest));
            }
            if (state.role === 'shore' && state.sessionCode) setViewMode('shore');
            else setViewMode((current) => (current === 'shore' ? 'setup' : current));
        });
        const unsubBroadcast = AnchorWatchSyncService.onBroadcast((data: SyncBroadcast) => {
            if (data.type === 'position') {
                setShoreData(data);
                setShoreDataReceivedAt(shoreObservationTime(data));
            }
        });

        // Auto-restore persisted state after app crash/close
        // 1. Restore anchor watch state (anchor position, config, GPS monitoring)
        // 2. Restore sync session (Supabase channel reconnection)
        const restore = async () => {
            // First restore anchor watch — this re-establishes geofence + GPS
            const watchRestored = await AnchorWatchService.restoreWatchState();
            if (!mounted) return;
            const existing = AnchorWatchSyncService.getState();
            if (watchRestored && !(existing.role === 'shore' && existing.sessionCode)) {
                setViewMode('watching');
            }

            // Then restore sync session — reconnect to Supabase channel
            const syncRestored = await AnchorWatchSyncService.restoreSession();
            if (!mounted) return;
            if (syncRestored) {
                const state = AnchorWatchSyncService.getState();
                if (state.role === 'shore') {
                    setViewMode('shore');
                } else if (state.role === 'vessel' && !watchRestored) {
                    // Sync says vessel but anchor watch didn't restore
                    // (e.g., stale anchor state was cleared but sync session still active)
                    setViewMode('watching');
                }
            } else {
                // Auto-reconnect didn't land (no comms right now, session aged
                // out, or it just didn't come back). If the last session was a
                // SHORE (follower) join, pre-fill the code field so the punter
                // reconnects in one tap — never re-typing the session code.
                const last = AnchorWatchSyncService.getState();
                const lastCode = AnchorWatchSyncService.getLastSessionCode();
                if (last.role === 'shore' && lastCode) {
                    setSessionCode(lastCode);
                }
            }
        };
        void restore().catch((error) => log.warn('Anchor watch restore deferred', error));

        return () => {
            mounted = false;
            unsubState();
            unsubBroadcast();
        };
    }, []);

    // A TIMEOUT IS A REASON TO WARN, NOT TO DEMOLISH.
    //
    // This used to call leaveSession() after 60 silent seconds, which erases
    // the saved session code AND deletes this device's row from
    // anchor_alarm_tokens — its registration for drag pushes. For a transient
    // gap. And it lost a race it was never going to win: the reconnect
    // ladder's fifth attempt only BEGINS at about t+62s (2+4+8+16+32), so a
    // cold start onto flaky marina LTE was torn down while still climbing.
    //
    // The session now survives; the sync service's own escalation handles the
    // silence (rejoin, then re-probe the Pi, then say so), and the shore view
    // already shows the vessel as lost after 35s. Getting out is the
    // skipper's decision, and Stop Monitoring is right there.
    useEffect(() => {
        if (viewMode !== 'shore' || shoreData) return;
        const timeout = setTimeout(() => {
            log.warn('shore watch: 60s with no vessel data — keeping the session, recovery continues');
        }, 60_000);
        return () => clearTimeout(timeout);
    }, [viewMode, shoreData]);

    // Shore alarm ownership belongs to the app, never this page's lifetime.
    useEffect(() => {
        ShoreWatchAlarmService.start();
        const unsubscribe = ShoreWatchAlarmService.subscribe(setShoreAlarm);
        const unsubscribeReadiness = AnchorWatchSyncService.onPushReadinessChange(setPushReadiness);
        return () => {
            unsubscribe();
            unsubscribeReadiness();
        };
    }, []);

    // The boat phone's last check-in with the server (126-03b), read each
    // minute ashore. Only a fresh one (< 3 min), on a phone whose notifications
    // are verified, earns the promise that a quiet phone will be reported; a
    // Pi-kept watch, an ended one, or a read error (before the DB push) shows
    // nothing.
    const [phoneBeat, setPhoneBeat] = useState<{ ageMs: number; readAt: number } | null>(null);
    const shoreSessionCode = viewMode === 'shore' ? (syncState?.sessionCode ?? null) : null;
    useEffect(() => {
        setPhoneBeat(null);
        if (!shoreSessionCode) return undefined;
        let live = true;
        const read = () =>
            void Promise.resolve()
                .then(() => AnchorWatchSyncService.readVesselHeartbeatAge())
                .then((ageMs) => live && setPhoneBeat(ageMs === null ? null : { ageMs, readAt: Date.now() }))
                .catch(() => live && setPhoneBeat(null));
        read();
        const timer = setInterval(read, 60_000);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [shoreSessionCode]);

    // Shore-data freshness is safety-visible, so age it each second. The local
    // vessel view only needs its elapsed clock refreshed once per minute.
    useEffect(() => {
        if (viewMode === 'watching' || viewMode === 'shore') {
            tickRef.current = setInterval(() => setTick((t) => t + 1), viewMode === 'shore' ? 1000 : 60000);
        }
        return () => {
            if (tickRef.current) clearInterval(tickRef.current);
        };
    }, [viewMode]);

    /**
     * Offer the Pi the watch whenever it can genuinely take it.
     *
     * This used to fire once, in the instant after arming — so a Pi that came
     * up later, or was redeployed while the hook was already down, could never
     * be offered, and the skipper had no way to reach the feature short of
     * weighing anchor (Shane 2026-09-03: "it set the anchor. but it does not
     * allow me to be the shore share punter?"). It is tied to the STATE that
     * makes the offer meaningful — watching, sharing, no Pi keeping it yet —
     * rather than to a moment in time.
     *
     * Only offered when the Pi can ACTUALLY keep it: paired, configured, and
     * seeing the vessel on the bus right now. A Pi that took the watch and
     * then reported no-fix forever would send the skipper ashore believing the
     * boat was watched. Asked once per session, so "keep it here" is not
     * asked again all night.
     */
    /**
     * The offer is keyed on the ANCHOR, not on a shore-share session.
     *
     * It used to be keyed on syncState.sessionCode — which is circular, and is
     * why no button ever appeared (Shane 2026-09-03, anchor armed and Shore
     * Share un-started: "there is no pi button?"). The session does not exist
     * until the offer is ACCEPTED, so gating the offer on it meant no session,
     * no probe, no button, no session.
     *
     * The anchor's own timestamp is the right key: one offer per hook that
     * goes down, and a decline that lasts until the next one.
     */
    const piOfferAnchorKey =
        viewMode === 'watching' && snapshot?.anchorPosition ? String(snapshot.anchorPosition.timestamp) : null;
    // Asked REPEATEDLY, not once.
    //
    // Five times the handoff underneath worked and the offer never appeared,
    // and this is why: the probe ran a single time at the moment the anchor
    // was armed. If the Pi status poll had not yet marked the Pi reachable —
    // the app had just come to the foreground, the phone was still joining the
    // boat's network, the pinned-key identity gate had not finished — the
    // answer was "no Pi", `piWatchCapable` stayed false, and nothing ever
    // asked again for the life of that anchor. A race, and one the skipper
    // could never see or retry.
    //
    // So it keeps looking while the anchor is down: every 10s until a Pi
    // answers, every 30s after, which costs one small request on the boat's
    // own LAN. The modal is raised at most once per anchor by the latch below,
    // so a Pi that wakes up an hour later gets offered, and a skipper who said
    // no is not asked twice.
    const autoOfferedForRef = useRef<string | null>(null);
    useEffect(() => {
        if (viewMode !== 'watching' || !piOfferAnchorKey) {
            setPiWatchCapable(false);
            setPiWatchReason(null);
            return;
        }
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const look = async () => {
            const cap = await probePiWatchCapability();
            if (stopped) return;
            setPiWatchCapable(cap.capable);
            setPiHasFix(cap.hasFix);
            setPiWatchReason(cap.capable ? null : cap.reason);
            if (cap.capable && !AnchorPiWatchKeeper.isKeeping() && autoOfferedForRef.current !== piOfferAnchorKey) {
                autoOfferedForRef.current = piOfferAnchorKey;
                setShowPiWatchOffer(true);
            }
            timer = setTimeout(() => void look(), cap.capable ? 30_000 : 10_000);
        };
        void look();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [viewMode, piOfferAnchorKey]);

    // ── The Pi keeps the watch only when the skipper says so ──
    //
    // Handing over is an explicit choice (see the offer below), not something
    // that happens because a Pi answered a ping — because saying yes moves
    // this phone to the SHORE side, and that is a decision about where the
    // skipper is going, which no ping can know.
    //
    // WEIGHING THE ANCHOR ENDS IT. NOTHING ELSE DOES.
    //
    // Note what is NOT here, and why each absence is deliberate:
    //
    // viewMode 'shore' must never end it — 'shore' is exactly the state where
    // the Pi is the only thing still watching the boat.
    //
    // Nor may UNMOUNTING end it. There used to be a cleanup here that called
    // end() when the page went away, on the reasoning that the watch should be
    // "given back when this page goes away entirely". That defeats the whole
    // feature: the point of handing the watch to the Pi is that the skipper can
    // pocket the phone and leave the boat, so the anchor page going away is the
    // EXPECTED case, not the exceptional one. Switching tabs was enough to do
    // it, and so was any remount React chose to perform.
    //
    // Observed 2026-09-03 on Shane's first successful handoff: the Pi reported
    // {running: false, sessionCode: null, lastOutcome: 'sent'} — it broadcast
    // once, then the page unmounted and told it to stop, and the shore view sat
    // there reporting "vessel offline, last-known data from Ns ago".
    //
    // What still stops a runaway Pi is the six-hour authorisation lapsing,
    // which is a guarantee that does not depend on any phone being awake,
    // reachable, or even still owned by the skipper.
    // NOTHING HERE INFERS "THE ANCHOR CAME UP" FROM STATE.
    //
    // Ending the Pi's watch now happens in handleStopWatch, where the skipper
    // actually weighs the anchor. Three separate bugs came from deriving it
    // instead, each one shipped as the fix for the last:
    //
    //   1. an unmount cleanup — so leaving the page stopped the Pi, when
    //      leaving the boat is the entire point of the feature;
    //   2. `if (viewMode === 'setup')` — viewMode initialises to 'setup', so
    //      COMING BACK to the page stopped it;
    //   3. the transition 'watching' -> 'setup' — which is exactly what the
    //      handoff itself does, because handleAcceptPiWatch calls stopWatch()
    //      to stand this phone down once the Pi has taken over. The Pi's log
    //      showed STARTED and STOPPED for session JE2SP7MS2D2R in the SAME
    //      SECOND.
    //
    // Handing the watch over is an explicit choice. Giving it back is too.

    // Swing circle visualization extracted to SwingCircleCanvas component

    // ── Move the anchor after it is down (build 123, must-do #3) ──
    //
    // The watch is armed wherever the GPS is, which is usually the boat, a
    // rode-length from the hook. The chip on the radar card moves the centre
    // of the watch THIS phone keeps, and only that one: while the Pi keeps the
    // watch this phone is not the keeper, and moving the Pi's watch is a
    // different path that re-posts its assignment. A blocked watch can still
    // be moved while it has a fix to measure from, so Retry then watches the
    // right spot; a corrupt one cannot (it has no valid circle). The service
    // refuses anything else on its own (AnchorWatchService.relocateAnchor).
    const canMoveAnchor =
        viewMode === 'watching' &&
        !!snapshot &&
        !!snapshot.anchorPosition &&
        snapshot.swingRadius > 0 &&
        (snapshot.state === 'watching' ||
            (snapshot.state === 'paused' &&
                !!snapshot.vesselPosition &&
                !snapshot.setupError?.startsWith('Saved Anchor Watch is blocked'))) &&
        !piKeepingWatch &&
        !AnchorPiWatchKeeper.isKeeping();
    // An alarm, a hand-off or a weighed anchor closes the sheet, and it does
    // not spring back open when the chip next appears.
    useEffect(() => {
        if (!canMoveAnchor) setShowMoveAnchor(false);
    }, [canMoveAnchor]);
    const handleAnchorMoved = useCallback(() => {
        setShowMoveAnchor(false);
        void triggerHaptic('medium');
        toast.success('Anchor moved. The swing circle is centred on it now.');
    }, []);

    // ── AIS targets for the anchor watch radar — boat receiver first,
    //    internet fill (shared with the Glass hero card; see
    //    anchorRadarTargets for the merge politics). ──
    const aisTargets = useAnchorRadarTargets(
        snapshot?.anchorPosition ?? null,
        viewMode === 'watching' && showAisOnRadar,
    );

    // ---- HANDLERS ----

    /**
     * 126-07d: is the anchor just set inside a charted no-anchoring, cable,
     * pipeline or restricted area? Asked only once the watch is armed, never
     * awaited, and a note at most: it stops, delays and undoes nothing. The
     * check (services/anchorAreaCheck.ts) is its own lazily loaded chunk and
     * never throws. Nothing waits on it here, so the first ask in a new place
     * gets the time to build the chart's index (ANCHOR_AREA_AFTER_ARM_MS); a
     * chunk that will not load is a log line. Where no chart cell covers the
     * anchor, or the chart could not be checked, it says so in a quiet line:
     * a silence would read as clear.
     */
    const areaAnchorRef = useRef<AnchorPosition | null>(null);
    const noteAnchorAreas = useCallback((anchor: AnchorPosition) => {
        areaAnchorRef.current = anchor;
        setAreaNote(null);
        loadAnchorAreaCheck()
            .then(({ checkAnchorAreas, ANCHOR_AREA_AFTER_ARM_MS }) =>
                checkAnchorAreas(anchor.latitude, anchor.longitude, ANCHOR_AREA_AFTER_ARM_MS),
            )
            .then(({ warnings, charts }) => {
                // Only the latest anchor's answer: a slow one for an earlier anchor is not said.
                if (areaAnchorRef.current === anchor && (warnings.length > 0 || charts !== 'checked'))
                    setAreaNote({ anchor, warnings, charts, all: false, folded: false });
            })
            .catch((error: unknown) =>
                log.warn(`Anchor area check did not run: ${error instanceof Error ? error.message : 'unknown error'}`),
            );
    }, []);

    const handleSetAnchor = useCallback(async () => {
        setIsSettingAnchor(true);
        // Arming is five steps, only one of which is the fix. This used to
        // print 'Acquiring GPS fix...' once and never change, so a stall in
        // permissions, the geofence or the background lease all read as a GPS
        // failure — and the skipper went looking at satellites (Shane
        // 2026-08-08). Poll the service for the step actually in flight.
        setGpsStatus('Starting…');
        const stagePoll = setInterval(() => {
            const stage = AnchorWatchService.getSetupStage();
            if (stage) setGpsStatus(`${stage}…`);
        }, 250);

        const config: Partial<AnchorWatchConfig> = {
            rodeLength,
            waterDepth,
            rodeType,
            safetyMargin,
            scopeRatio: rodeLength / waterDepth,
        };

        // The watch uses it only when the boat's own GPS marks the anchor (126-07c).
        const success = await AnchorWatchService.setAnchor(gpsToBowM > 0 ? { ...config, gpsToBowM } : config);
        clearInterval(stagePoll);
        setIsSettingAnchor(false);

        if (success) {
            setViewMode('watching');
            // Armed: only now look at the chart for an area here (126-07d).
            const anchor = AnchorWatchService.getSnapshot()?.anchorPosition;
            if (anchor) noteAnchorAreas(anchor);
            // The offer is driven by the effect below, which also covers the
            // case a probe here would miss: a Pi that becomes capable AFTER
            // the anchor is already down.
            // First-time hint dismissal — the intro card at the top
            // of the setup view only shows for users who haven't
            // armed yet. After one successful arm, they know.
            try {
                localStorage.setItem('thalassa_anchor_watch_armed_once', '1');
                setArmedOnce(true);
            } catch {
                // localStorage unavailable (private browsing etc) —
                // harmless; hint will keep showing.
            }
        } else {
            setGpsStatus(
                AnchorWatchService.getLastSetupError() ??
                    'Anchor Watch could not start. Check location and notification permissions.',
            );
        }
    }, [rodeLength, waterDepth, rodeType, safetyMargin, gpsToBowM, noteAnchorAreas]);

    // 126-07d: read, then folded (a warning) or gone (a quiet line). Any tap on
    // the note ("+1 more", the chip) makes a new note and a new read.
    useEffect(() => {
        if (!areaNote || areaNote.folded) return;
        const timer = window.setTimeout(
            () =>
                setAreaNote((note) =>
                    !note || note !== areaNote
                        ? note
                        : note.warnings.length > 0
                          ? { ...note, all: false, folded: true }
                          : null,
                ),
            AREA_NOTE_READ_MS,
        );
        return () => window.clearTimeout(timer);
    }, [areaNote]);

    const handleStopWatch = useCallback(async () => {
        // Shore follower: there's no local anchor watch to stop — leaving just
        // tears down the shared session, which CLEARS the saved code so it
        // doesn't pre-fill (and confuse) on the next anchor. Do this
        // independently of stopWatch() — a follower has no watch to stop, and
        // previously a throw there skipped leaveSession() and stranded the code.
        if (viewMode === 'shore') {
            try {
                await AnchorWatchSyncService.leaveSession();
            } catch (e) {
                log.warn('leaveSession (shore) failed', e);
            }
            setViewMode('setup');
            setShoreData(null);
            setShoreDataReceivedAt(null);
            return;
        }
        // Vessel host: stopping is a SAFETY action — must never fail silently.
        // If the service throws, the watch may still be armed; tell the user so
        // they can retry rather than walking away thinking it's off.
        // The anchor is coming up, so the Pi must stop watching it — this is
        // the one and only place that ends the Pi's watch. Kept off the safety
        // path: a Pi that cannot be reached must not stop the skipper stopping
        // their own alarm, and the six-hour authorisation still bounds it.
        try {
            await AnchorPiWatchKeeper.end();
        } catch (e) {
            log.warn('Could not tell the Pi to stop watching', e);
        }
        try {
            await AnchorWatchService.stopWatch();
            await AnchorWatchSyncService.leaveSession();
            setViewMode('setup');
            setShoreData(null);
            setShoreDataReceivedAt(null);
        } catch (e) {
            log.error('Failed to stop anchor watch', e);
            toast.error('Could not stop the anchor watch — it may still be armed. Try again.');
        }
    }, [viewMode]);

    /**
     * Weigh anchor from Shore Watch, when the watch is this phone's own Pi's.
     *
     * After a hand-off the phone sits in shore view, whose only control was
     * Leave, and Leave does not end the Pi's watch: the keeper went on renewing
     * it every hour, so the Pi was still watching after the anchor came up and
     * could raise a drag alarm as the boat motored off. Shane 2026-09-29 chose
     * two buttons: this one gives the watch back (the explicit act the
     * hand-off notes above ask for), Leave keeps today's meaning.
     *
     * end() stops the renewals before it asks the Pi to stop, so a Pi that
     * cannot be reached right now still lets go when its six-hour
     * authorisation lapses. Leaving the session follows either way.
     */
    const handleWeighAnchorFromShore = useCallback(async () => {
        try {
            await AnchorPiWatchKeeper.end();
        } catch (e) {
            log.warn('Could not tell the Pi to stop watching', e);
        }
        try {
            await AnchorWatchSyncService.leaveSession();
        } catch (e) {
            log.warn('leaveSession (shore, weigh anchor) failed', e);
        }
        setPiKeepingWatch(false);
        setViewMode('setup');
        setShoreData(null);
        setShoreDataReceivedAt(null);
        void triggerHaptic('medium');
    }, []);

    const handleMuteShoreAlarm = useCallback(async () => {
        try {
            await ShoreWatchAlarmService.mute();
            triggerHaptic('medium');
        } catch {
            toast.error('The Shore Watch alarm could not be silenced on this device. Try again.');
        }
    }, []);

    const handleRetryMonitoring = useCallback(async () => {
        if (isRetryingMonitoring) return;
        setIsRetryingMonitoring(true);
        try {
            await AnchorWatchService.restoreWatchState();
            const current = AnchorWatchService.getSnapshot();
            if (current.state === 'paused') {
                throw new Error(current.setupError || 'Anchor Watch safety monitoring is still blocked.');
            }
            if (current.state !== 'watching' && current.state !== 'alarm') {
                throw new Error('Anchor Watch could not confirm that monitoring restarted.');
            }
            toast.success('Anchor Watch monitoring restarted.');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Anchor Watch monitoring could not restart.';
            toast.error(message);
        } finally {
            setIsRetryingMonitoring(false);
        }
    }, [isRetryingMonitoring]);

    const handleCreateSession = useCallback(async () => {
        if (!authedUser) {
            setShowShoreSignIn(true);
            return;
        }
        try {
            const code = await AnchorWatchSyncService.createSession();
            if (code) {
                setSessionCode(code);
            } else {
                toast.error('Could not start a shore-watch session — check your connection.');
            }
        } catch (e) {
            log.error('createSession failed', e);
            toast.error('Could not start a shore-watch session — check your connection.');
        }
    }, [authedUser]);

    /**
     * Let the Pi keep the watch, and turn THIS phone into the shore half.
     *
     * Shane 2026-09-03: "if you drop anchor from your phone, and a pi is on
     * board… that particular phone should have the option of pressing shore
     * share and it becomes the shore half of the anchoring."
     *
     * THE ORDER IS THE SAFETY. The Pi must be watching before this phone stops
     * — otherwise there is a window with nobody watching the boat — and this
     * phone's own watch must stop before it goes ashore, or it alarms on its
     * own movement the moment the skipper steps into the dinghy. So:
     *
     *   1. create the session (the channel the Pi will broadcast to)
     *   2. hand it to the Pi and confirm it took it
     *   3. only then stand this phone's local watch down
     *   4. rejoin the same session as the SHORE device
     *
     * Any failure before step 3 leaves the phone exactly as it was: still the
     * watchkeeper, still armed, nothing lost.
     */
    const handleAcceptPiWatch = useCallback(async () => {
        const snap = AnchorWatchService.getSnapshot();
        const anchor = snap.anchorPosition;
        if (!anchor || snap.swingRadius <= 0) {
            toast.error('The anchor position is not settled yet — try again in a moment.');
            return;
        }
        setPiHandoffBusy(true);
        try {
            const code = syncState?.sessionCode ?? (await AnchorWatchSyncService.createSession());
            if (!code) {
                toast.error('Could not start a shore-watch session — check your connection.');
                return;
            }
            const took = await AnchorPiWatchKeeper.begin({
                sessionCode: code,
                anchorLat: anchor.latitude,
                anchorLon: anchor.longitude,
                swingRadius: snap.swingRadius,
                // Carried so the shore view can show the rode and depth the
                // skipper actually set. The Pi cannot know either.
                rodeLength: snap.config?.rodeLength,
                waterDepth: snap.config?.waterDepth,
            });
            if (!took) {
                toast.error('The Pi would not take the watch — this phone is still keeping it.');
                return;
            }
            // The Pi is watching now, so this phone can stand down. If this
            // throws, the Pi is still watching and we stay on the vessel side
            // rather than going ashore with a live local alarm.
            await AnchorWatchService.stopWatch();
            const joined = await AnchorWatchSyncService.joinSession(code);
            if (!joined) {
                toast.error('The Pi has the watch, but this phone could not switch to shore view.');
                return;
            }
            setViewMode('shore');
            setShowPiWatchOffer(false);
            setPiKeepingWatch(true);
            // The shore screen and live-data indicator confirm the handover;
            // a long success toast was obscuring the header and info control.
            void triggerHaptic('light');
        } catch (e) {
            log.error('Pi watch handoff failed', e);
            toast.error('Could not hand the watch to the Pi — this phone is still keeping it.');
        } finally {
            setPiHandoffBusy(false);
        }
    }, [syncState?.sessionCode]);

    const handleJoinShore = useCallback(async () => {
        if (!authedUser) {
            setShowShoreModal(false);
            setShowShoreSignIn(true);
            return;
        }
        if (sessionCode.length !== 12) return;
        try {
            const joined = await AnchorWatchSyncService.joinSession(sessionCode);
            if (joined) {
                setViewMode('shore');
            } else {
                toast.error('Could not join — check the 12-character code and try again.');
            }
        } catch (e) {
            log.error('joinSession failed', e);
            toast.error('Could not join the shore watch — check your connection.');
        }
    }, [authedUser, sessionCode]);
    // Slide-to-confirm state (must be before any early returns — React Rules of Hooks)
    const slideTrackRef = useRef<HTMLDivElement>(null);
    /** The Enter or Space that went down on the slide track, until its release opens the Sound Check. */
    const armKeyRef = useRef<string | null>(null);
    const [slideX, setSlideX] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [slideCommitted, setSlideCommitted] = useState(false);
    const slideThreshold = 0.85; // 85% to trigger
    const lastSlideRatioRef = useRef(0);
    const lastHapticRatioRef = useRef(0); // throttle progressive haptics

    // Live offset alongside state: the release check must read the LAST
    // move, not the last render — a fast flick could end on a stale value.
    const slideXRef = useRef(0);
    // Track geometry measured once per gesture (pointerdown) — the track is
    // full-width with a fixed height, so re-measuring on every pointermove
    // and in render only forced synchronous layout for the same numbers.
    const slideTrackRectRef = useRef({ left: 0, maxTravel: 244 });

    const handleSlideStart = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (isSettingAnchor) return;
            // Capture the pointer so move/up/cancel keep routing here no
            // matter where the finger wanders. Without capture, an iOS
            // touch cancel (system gesture, notification banner) never
            // delivered an end event and the thumb froze mid-track in the
            // committed style (field bug 2026-06-13).
            try {
                e.currentTarget.setPointerCapture?.(e.pointerId);
            } catch {
                /* best-effort — jsdom and odd inputs lack capture */
            }
            const rect = e.currentTarget.getBoundingClientRect();
            slideTrackRectRef.current = { left: rect.left, maxTravel: rect.width - 56 };
            setIsDragging(true);
            setSlideCommitted(false);
            lastSlideRatioRef.current = 0;
            lastHapticRatioRef.current = 0;
        },
        [isSettingAnchor],
    );

    const handleSlideMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!isDragging || !slideTrackRef.current) return;
            const thumbWidth = 56;
            const { left, maxTravel } = slideTrackRectRef.current;
            const offset = e.clientX - left - thumbWidth / 2;
            const clamped = Math.max(0, Math.min(offset, maxTravel));
            slideXRef.current = clamped;
            setSlideX(clamped);

            const ratio = clamped / maxTravel;

            // Progressive haptic feedback — tap every 15% of travel
            if (ratio - lastHapticRatioRef.current >= 0.15) {
                lastHapticRatioRef.current = ratio;
                triggerHaptic('light');
            }

            // Commit snap — heavy haptic when crossing threshold
            if (ratio >= slideThreshold && lastSlideRatioRef.current < slideThreshold) {
                triggerHaptic('heavy');
                setSlideCommitted(true);
            } else if (ratio < slideThreshold && lastSlideRatioRef.current >= slideThreshold) {
                // Pulled back below threshold
                setSlideCommitted(false);
            }

            lastSlideRatioRef.current = ratio;
        },
        [isDragging],
    );

    const handleSlideEnd = useCallback(() => {
        if (!isDragging || !slideTrackRef.current) return;
        setIsDragging(false);
        const ratio = slideXRef.current / slideTrackRectRef.current.maxTravel;
        if (ratio >= slideThreshold) {
            // Every arming attempt requires a fresh audible test because route,
            // volume, Focus, and connected audio hardware can change at any time.
            setShowSoundCheck(true);
        }
        slideXRef.current = 0;
        setSlideX(0);
        setSlideCommitted(false);
    }, [isDragging]);

    const handleSlideCancel = useCallback(() => {
        // iOS cancels (not ends) the touch for system gestures and
        // banners — never drop the anchor from a cancel, just spring back.
        if (!isDragging) return;
        setIsDragging(false);
        slideXRef.current = 0;
        setSlideX(0);
        setSlideCommitted(false);
    }, [isDragging]);

    // Confirm and proceed from sound check modal
    const handleSoundCheckConfirm = useCallback(() => {
        setShowSoundCheck(false);
        handleSetAnchor();
    }, [handleSetAnchor]);

    // Reset slide position when not dragging
    useEffect(() => {
        if (!isDragging) {
            slideXRef.current = 0;
            setSlideX(0);
        }
    }, [isDragging]);

    // ---- ALARM OVERLAY ----
    // Rendered app-level by GlobalAnchorAlarmGate (App.tsx) so the alarm
    // covers every page, not just this one. The page-local early return
    // here would stack a second copy of the same critical portal.
    // ---- RENDER: SETUP (IDLE) — Instrument-Grade Dashboard ----

    if (viewMode === 'setup') {
        // The wind advice, as the same one-tap target the strip under the
        // sliders used to be, now set under the dial's verdict (UX scorecard
        // run 8): that strip sat beneath the sticky arming bar on every phone,
        // so ADEQUATE was on screen and the app's own advice was not. The
        // dial already prints the ratio and its word, so the strip's second
        // copy of them went with it.
        const adviceSet = rodeLength === wxRecommendation.rode;
        // '5 kts now · 5:1 needs 25 m': the wind, then the recommendation in
        // one reading order (UX scorecard run 10: 'Wind now 5 kts: 25 m for
        // 5:1' took a second read). 'now' stays: the advice reads this
        // minute's wind, not the night ahead (UX scorecard run 9).
        const windWords = wxRecommendation.windKnown ? `${wxRecommendation.wind.toFixed(0)} kts now` : '-- kts now';
        const adviceAction = adviceSet
            ? `${wxRecommendation.scope}:1 set`
            : `${wxRecommendation.scope}:1 needs ${wxRecommendation.rode} m`;
        const adviceText = `${windWords} · ${adviceAction}`;
        const rodeAdvice = (
            <button
                type="button"
                aria-label={
                    adviceSet
                        ? `${adviceText}, rode ${wxRecommendation.rode} metres`
                        : `${adviceText}, set rode to ${wxRecommendation.rode} metres`
                }
                onClick={() => setRodeLength(wxRecommendation.rode)}
                title={adviceSet ? undefined : `Set rode to ${wxRecommendation.rode} m (${wxRecommendation.scope}:1)`}
                // Drawn 44 px tall, the same as the rode-type buttons below it,
                // not 28 px with an invisible reach: it is an action (it sets
                // the rode) on a page used one-handed in a blow (UX scorecard
                // run 10). px, not rem, so the fluid root cannot shrink it.
                // Tinted by the wind, as the strip's icon was: red for storm
                // scope, amber for strong wind; green once the rode is set.
                className={`inline-flex min-h-[44px] max-w-full items-center justify-center gap-1 rounded-full border px-3 py-1 text-center text-[12px] font-bold leading-tight transition-colors [@media(orientation:landscape)_and_(max-height:500px)]:px-2 ${
                    adviceSet
                        ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                        : wxRecommendation.severity === 'red'
                          ? 'border-red-400/40 bg-red-500/10 text-red-200'
                          : wxRecommendation.severity === 'amber'
                            ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
                            : 'border-sky-400/30 bg-sky-500/10 text-sky-200'
                }`}
            >
                {adviceSet && <CheckIcon className="h-3 w-3 shrink-0" />}
                {/* Two unbreakable halves: were a line ever too narrow it
                    folds after the wind, never mid-phrase, and the › stays
                    with the action. */}
                <span className="min-w-0">
                    <span className="whitespace-nowrap">{windWords} ·</span>{' '}
                    <span className="whitespace-nowrap">
                        {adviceAction}
                        {!adviceSet && <span aria-hidden="true"> ›</span>}
                    </span>
                </span>
            </button>
        );

        return (
            <div
                ref={keyboardScrollRef}
                className={`anchor-setup-page h-full ${t.colors.bg.base} flex flex-col overflow-hidden slide-up-enter`}
                style={{ overscrollBehaviorY: 'none' }}
            >
                <PageHeader
                    title="Anchor Watch"
                    onBack={onBack}
                    breadcrumbs={['Vessel', 'Anchor Watch']}
                    // Under the title, not beside it: three things in the title row
                    // squeezed ANCHOR WATCH to a clipped column at 393 pt. The
                    // status slot, as MOB, Radio and NMEA use: as a subtitle the
                    // pill stretched the width of the title column. In short
                    // landscape too: drawn at the far end of the title line it
                    // sat ~700 pt from the title it qualifies (UX scorecard
                    // run 10). One copy, so the page has one status for
                    // VoiceOver.
                    status={
                        <span
                            role="status"
                            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-extrabold uppercase tracking-widest ${fixTone}`}
                        >
                            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                            {fixWord}
                        </span>
                    }
                    action={
                        // One 44 px control, one line, the feature's one name
                        // (UX scorecard run 10: it stacked 'Watch from / ashore
                        // / Sign in', and the page called the feature three
                        // things). What it does is its description; signed out,
                        // a lock says the tap asks for an account, and the name
                        // says so in words after the visible ones (label in
                        // name, so Voice Control's 'tap Shore Watch' still
                        // lands): 'Sign in to use Shore Watch', the account gate
                        // the beta check pins (scripts/check-beta-readiness.mjs).
                        // The lock is a corner badge, not a glyph in the line:
                        // inline it made the button 122 pt wide and folded
                        // ANCHOR WATCH onto two lines at 393 pt.
                        <button
                            type="button"
                            aria-label={authedUser ? 'Shore Watch' : 'Shore Watch. Sign in to use Shore Watch'}
                            aria-describedby={shoreHintId}
                            onClick={() => (authedUser ? setShowShoreModal(true) : setShowShoreSignIn(true))}
                            className="relative flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-white/6 bg-slate-800/60 px-2.5 py-1 text-xs font-bold leading-tight text-slate-300 transition-colors hover:text-white"
                        >
                            {!authedUser && (
                                <span
                                    aria-hidden="true"
                                    className="absolute -right-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white/10 bg-slate-800 text-slate-300"
                                >
                                    <LockIcon className="h-2.5 w-2.5" />
                                </span>
                            )}
                            Shore Watch
                            <span id={shoreHintId} className="sr-only">
                                Watch this anchor from ashore: enter the code from the boat&apos;s phone to get its
                                anchor alarm on this one.
                            </span>
                        </button>
                    }
                />

                {/* Setup remains compact in portrait, but it must be a real
                    scrollport on short landscape/keyboard viewports so the
                    arming control can never be clipped below the screen. */}
                {/* Bottom clearance DERIVED from the nav, not guessed at.
                    The old value was a literal 98px: 64px of tab bar plus a
                    hardcoded stab at the safe-area inset — right on a notched
                    iPhone, wrong on everything else. The nav is h-16 plus
                    env(safe-area-inset-bottom) (App.tsx), so this is that plus
                    the 8px Shane asked for, and it holds on any device. */}
                <div
                    className="anchor-setup-scroll flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-y-contain"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    {/* First-time-user guidance card — added 2026-05-17.
                        Shows for users who haven't yet armed an anchor
                        watch (gated by the
                        `thalassa_anchor_watch_armed_once` localStorage
                        flag set in `handleDropAnchor`'s success branch).
                        Anchor Watch is a safety feature — vague setup
                        UX = real risk. The card explains the three
                        configuration knobs in plain English and the
                        slide-to-arm gesture. Hides permanently after
                        the user successfully arms once. */}
                    {!armedOnce && (
                        <div className="anchor-setup-guidance shrink-0 mx-4 mt-2 mb-1 rounded-xl bg-sky-500/6 border border-sky-500/15 px-3 py-2.5 [@media(orientation:landscape)_and_(max-height:500px)]:my-0.5!">
                            {/* Two lines, so both sliders sit above the arming bar
                                on an 852 pt phone (UX scorecard run 6: six lines
                                pushed RODE under it). The permission caveat stays;
                                the Sound Check that arming opens says the rest.
                                On short phones and in landscape it is the caveat
                                alone, one line, so RODE DEPLOYED clears the arming
                                bar; the labelled controls and SLIDE TO DROP ANCHOR
                                carry the instruction there (UX scorecard run 9).
                                The instruction names the controls as they are
                                labelled (rode length and type, not 'tackle'), in
                                one line at 393 pt. */}
                            <p className="text-[12px] text-sky-200 leading-snug">
                                <span className="block font-bold text-sky-300 [@media(orientation:portrait)_and_(max-height:700px)]:hidden [@media(orientation:landscape)_and_(max-height:500px)]:hidden">
                                    Set depth, rode length and type, then slide to arm.
                                </span>
                                <span className="block">Background alerts need GPS and notification access.</span>
                            </p>
                        </div>
                    )}

                    {/* ── Hero: Scope Radar, its verdict and the wind advice ──
                        px-2 in the 200 px landscape column, and there the box
                        is its content's height, unpadded (not index.css's
                        180 px floor, which centred the dial lower), so the
                        advice ends 12 px or more clear of the floating nav
                        toggle. On a
                        667 pt phone the dial's box is 124 px, not 140, so
                        RODE DEPLOYED ends above the arming bar (UX scorecard
                        run 9); its letters still scale to 12 px (ScopeRadar).
                        Those sizes are floors in portrait, not fixed heights:
                        the box grows into whatever the page leaves over, so
                        the arming bar ends at the tab bar rather than
                        floating above a dead band (the slim slider tracks
                        gave back 32 px, UX scorecard run 10).
                        The sr-only h2s let heading navigation jump to the
                        dial and to the rode controls (UX scorecard run 9). */}
                    <h2 className="sr-only">Scope</h2>
                    <div className="anchor-setup-radar flex-1 min-h-0 flex items-center justify-center px-4 py-2 relative [@media(orientation:landscape)_and_(max-height:500px)]:px-2 [@media(orientation:landscape)_and_(max-height:500px)]:py-0 [@media(orientation:landscape)_and_(max-height:500px)]:min-h-0! [@media(orientation:portrait)_and_(max-height:700px)]:basis-[124px]! [@media(orientation:portrait)_and_(max-height:700px)]:min-h-[124px]! [@media(orientation:portrait)]:grow!">
                        <ScopeRadar
                            rodeLength={rodeLength}
                            waterDepth={waterDepth}
                            rodeType={rodeType}
                            safetyMargin={safetyMargin}
                            advice={rodeAdvice}
                        />
                    </div>

                    {/* ── Controls Section ── */}
                    <h2 className="sr-only">Depth and rode</h2>
                    <div className="anchor-setup-controls shrink-0 px-4 space-y-3">
                        {/* Rode type — compact segmented row, named in the
                            sliders' label style (UX scorecard run 9: the one
                            setup control with no visible name). The name sits
                            beside the row, not over it: a row of its own pushed
                            RODE DEPLOYED under the arming bar on every phone.
                            Words in their capitals in the DOM, so VoiceOver says
                            'Chain', not 'chain'. */}
                        <div className="flex items-center gap-3">
                            {/* Hidden from VoiceOver as text: it is the group's
                                name, so it is said once, with the group. */}
                            <span
                                id={rodeTypeLabelId}
                                aria-hidden="true"
                                className="shrink-0 whitespace-nowrap text-xs text-slate-400 uppercase tracking-wider font-bold"
                            >
                                Rode type
                            </span>
                            <div role="group" aria-labelledby={rodeTypeLabelId} className="flex min-w-0 flex-1 gap-1.5">
                                {(
                                    [
                                        ['chain', 'Chain'],
                                        ['rope', 'Rope'],
                                        ['mixed', 'Mixed'],
                                    ] as const
                                ).map(([type, word]) => (
                                    <button
                                        type="button"
                                        aria-pressed={rodeType === type}
                                        key={type}
                                        onClick={() => setRodeType(type)}
                                        className={`flex-1 min-h-11 min-w-0 rounded-xl text-sm font-bold transition-all ${
                                            rodeType === type
                                                ? 'bg-amber-500/20 border border-amber-500/40 text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.1)]'
                                                : 'bg-slate-800/40 border border-white/6 text-slate-400 hover:text-slate-400'
                                        }`}
                                    >
                                        {word}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Sliders. Each range rides in its label ('1–30 m') at
                            every size (it must match min/max below): the row of
                            end values under each track put RODE DEPLOYED half
                            under the arming bar at 375x667 (run 8), and at 852 pt
                            the bar's fade cut '5 m / 100 m' mid-glyph (UX
                            scorecard run 9). */}
                        <div className="space-y-2.5">
                            {/* Water Depth */}
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                                        Water depth
                                        <span className="font-mono font-semibold normal-case tracking-normal">
                                            {' '}
                                            1–30 m
                                        </span>
                                    </label>
                                    {/* One value colour for both sliders, and '5 m'
                                        spaced like the track ends (UX run 6). */}
                                    <span className="text-sm font-black text-white font-mono tabular-nums">
                                        {waterDepth} m
                                    </span>
                                </div>
                                <input
                                    aria-label="Water depth in metres"
                                    type="range"
                                    min={1}
                                    max={30}
                                    step={0.5}
                                    value={waterDepth}
                                    onChange={(e) => setWaterDepth(Number(e.target.value))}
                                    className={`${RANGE_TRACK_CLASS} accent-sky-500 [--range-fill:#0ea5e9] [.display-light_&]:[--range-fill:#0369a1]`}
                                    style={rangeTrackStyle((waterDepth - 1) / (30 - 1))}
                                />
                            </div>

                            {/* Rode Deployed */}
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                                        Rode deployed
                                        <span className="font-mono font-semibold normal-case tracking-normal">
                                            {' '}
                                            5–100 m
                                        </span>
                                    </label>
                                    <span className="text-sm font-black text-white font-mono tabular-nums">
                                        {rodeLength} m
                                    </span>
                                </div>
                                <input
                                    aria-label="Rode deployed in metres"
                                    type="range"
                                    min={5}
                                    max={100}
                                    step={1}
                                    value={rodeLength}
                                    onChange={(e) => setRodeLength(Number(e.target.value))}
                                    className={`${RANGE_TRACK_CLASS} accent-amber-500 [--range-fill:#f59e0b] [.display-light_&]:[--range-fill:#b45309]`}
                                    style={rangeTrackStyle((rodeLength - 5) / (100 - 5))}
                                />
                            </div>
                        </div>

                        {/* ── Slide to Confirm — safety orange ──
                            No bottom padding of its own: the scroller owns the
                            8px gap to the menu, so a second source of spacing
                            here would make the real distance the sum of two
                            numbers nobody could reason about. */}
                        {/* Sticky at the scroller's bottom edge, so the arming
                            control is on screen on a 667 pt phone without a
                            scroll — the other slide-to-act pages already pin
                            theirs. The scroller itself ends above the tab bar
                            (measured 2026-09-25: a clearance here as well left
                            a 72 px dead band under the bar), so the offset is 0
                            and .anchor-setup-arm paints an opaque surface. */}
                        {/* In short landscape the bar rests at its own place,
                            flush under the sliders: the 12 px fade above it lands
                            on the empty lower half of their 44 px touch boxes,
                            clear of the drawn track and the thumb. */}
                        <div className="anchor-setup-arm sticky bottom-0 z-10 -mx-4 px-4 pt-1">
                            {/* The VPN hairpin notice used to sit here. Removed
                                2026-09-04 at Shane's call: "VPN's are for
                                advanced users only, so they will not [need]
                                this. also it is buggering up my screen." It
                                fired whenever the phone reached the gateway by
                                an address outside its own subnet — which is the
                                NORMAL case for anyone reaching the boat over a
                                tailnet, so it warned hardest at the moment the
                                setup was working as designed. The underlying
                                hairpin problem is real but belongs in the boat's
                                runbook, not above the arming control. */}
                            {!isSettingAnchor && gpsStatus !== 'Waiting for GPS…' && (
                                <p
                                    role="alert"
                                    className="mb-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-bold leading-relaxed text-red-200"
                                >
                                    {gpsStatus}
                                </p>
                            )}
                            {isSettingAnchor ? (
                                /* Loading state */
                                <div
                                    className="w-full h-14 rounded-full flex items-center justify-center gap-3"
                                    style={{
                                        background:
                                            'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(217,119,6,0.1) 100%)',
                                        border: '1px solid rgba(245,158,11,0.2)',
                                    }}
                                >
                                    <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-amber-300 font-bold">{gpsStatus}</span>
                                </div>
                            ) : (
                                /* Slide track */
                                <div
                                    ref={slideTrackRef}
                                    className="relative w-full h-14 rounded-full overflow-hidden select-none"
                                    style={{
                                        background:
                                            'linear-gradient(135deg, rgba(234,88,12,0.25) 0%, rgba(194,65,12,0.2) 100%)',
                                        border: '1px solid rgba(251,146,60,0.25)',
                                        touchAction: 'none',
                                    }}
                                    onPointerDown={handleSlideStart}
                                    onPointerMove={handleSlideMove}
                                    onPointerUp={handleSlideEnd}
                                    onPointerCancel={handleSlideCancel}
                                    role="button"
                                    tabIndex={0}
                                    aria-label="Drop anchor and arm Anchor Watch"
                                    aria-describedby={armWaitHint ? `${armWaitHintId} ${armTapHintId}` : armTapHintId}
                                    // Opened on the key's release, from a press that began
                                    // here: the Sound Check puts focus on its Cancel, and a
                                    // held Enter's repeat landed there and closed it at once.
                                    onKeyDown={(event) => {
                                        if (event.key !== 'Enter' && event.key !== ' ') return;
                                        event.preventDefault();
                                        armKeyRef.current = event.key;
                                    }}
                                    onKeyUp={(event) => {
                                        if (event.key !== 'Enter' && event.key !== ' ') return;
                                        event.preventDefault();
                                        if (armKeyRef.current !== event.key) return;
                                        armKeyRef.current = null;
                                        setShowSoundCheck(true);
                                    }}
                                    onBlur={() => {
                                        armKeyRef.current = null;
                                    }}
                                    // VoiceOver's double-tap and Switch Control send a
                                    // click with no pointer travel (detail 0), which the
                                    // drag handlers spring back from, so a VoiceOver
                                    // user could not arm at all (UX scorecard run 8).
                                    // It takes the Enter path: the Sound Check still
                                    // stands between the gesture and a set anchor. A
                                    // finger's tap (detail 1) still has to slide.
                                    onClick={(event) => {
                                        if (event.detail !== 0) return;
                                        setShowSoundCheck(true);
                                    }}
                                >
                                    {/* Shimmer animation */}
                                    <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
                                        <div
                                            className="absolute inset-0"
                                            style={{
                                                background:
                                                    'linear-gradient(90deg, transparent 0%, rgba(251,146,60,0.08) 30%, rgba(251,146,60,0.15) 50%, rgba(251,146,60,0.08) 70%, transparent 100%)',
                                                animation: 'shimmer 2.5s ease-in-out infinite',
                                            }}
                                        />
                                    </div>

                                    {/* Fill trail — glows behind thumb as it slides */}
                                    <div
                                        className="absolute top-0 left-0 bottom-0 rounded-full pointer-events-none transition-opacity"
                                        style={{
                                            width: `${slideX + 56}px`,
                                            background: slideCommitted
                                                ? 'linear-gradient(90deg, rgba(34,197,94,0.15) 0%, rgba(34,197,94,0.3) 100%)'
                                                : 'linear-gradient(90deg, rgba(251,146,60,0.08) 0%, rgba(251,146,60,0.2) 100%)',
                                            opacity: slideX > 2 ? 1 : 0,
                                            transition: isDragging
                                                ? 'background 0.3s'
                                                : 'width 0.3s ease, opacity 0.2s',
                                        }}
                                    />

                                    {/* Label text */}
                                    <div
                                        className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                        style={{
                                            opacity: 1 - slideX / slideTrackRectRef.current.maxTravel,
                                        }}
                                    >
                                        <span className="flex flex-col items-center leading-tight">
                                            {/* Sentence case at 16 px bold, the same label
                                                as the Log's slide bar: one family, not
                                                tracked capitals (UX scorecard run 9). */}
                                            <span className="text-base font-bold text-amber-300/70">
                                                Slide to drop anchor
                                            </span>
                                            {armWaitHint && (
                                                <span
                                                    id={armWaitHintId}
                                                    className="mt-0.5 text-xs font-semibold text-amber-200/80"
                                                >
                                                    {armWaitHint}
                                                </span>
                                            )}
                                            <span id={armTapHintId} className="sr-only">
                                                Double-tap to arm. A sound check comes first.
                                            </span>
                                        </span>
                                    </div>

                                    {/* Draggable thumb */}
                                    <div
                                        className="absolute top-1 left-1 w-12 h-12 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing transition-shadow"
                                        style={{
                                            transform: `translateX(${slideX}px)`,
                                            background: slideCommitted
                                                ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
                                                : 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                                            boxShadow: slideCommitted
                                                ? '0 4px 16px rgba(34,197,94,0.5), 0 0 24px rgba(34,197,94,0.2)'
                                                : '0 4px 16px rgba(249,115,22,0.4), 0 0 20px rgba(249,115,22,0.15)',
                                            transition: isDragging
                                                ? 'background 0.3s, box-shadow 0.3s'
                                                : 'transform 0.3s ease, background 0.3s, box-shadow 0.3s',
                                        }}
                                    >
                                        {slideCommitted ? (
                                            <CheckIcon className="w-5 h-5 text-white" />
                                        ) : (
                                            <AnchorIcon className="w-5 h-5 text-white" />
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* ══ Sound Check Confirmation Modal ══ */}
                {showSoundCheck && (
                    <SoundCheckModal onConfirm={handleSoundCheckConfirm} onCancel={() => setShowSoundCheck(false)} />
                )}

                {/* Shore Watch Modal — rendered via portal to bypass PullToRefresh transform */}
                {showShoreModal && (
                    <ShoreWatchModal
                        sessionCode={sessionCode}
                        onSessionCodeChange={setSessionCode}
                        onJoin={handleJoinShore}
                        onClose={() => setShowShoreModal(false)}
                    />
                )}

                <SignInScreen
                    isOpen={showShoreSignIn}
                    onClose={() => setShowShoreSignIn(false)}
                    prompt="Sign in to share Anchor Watch between your vessel and shore devices. Local Anchor Watch remains available without an account."
                />

                {/* Shimmer keyframe */}
                <style>{`
                    @keyframes shimmer {
                        0%, 100% { transform: translateX(-100%); }
                        50% { transform: translateX(100%); }
                    }
                `}</style>
            </div>
        );
    }

    // ---- RENDER: SHORE MODE ----
    if (viewMode === 'shore') {
        // This phone handed THIS session to its own Pi, so it can also give
        // the watch back. A session joined from someone else's boat cannot.
        const ownPiWatch =
            !!syncState?.sessionCode && AnchorPiWatchKeeper.keepingSessionCode() === syncState.sessionCode;
        const shoreDataAgeMs = shoreDataReceivedAt === null ? null : Math.max(0, Date.now() - shoreDataReceivedAt);
        // LIVENESS COMES FROM DATA ARRIVING, NOT FROM PRESENCE.
        //
        // This used to require syncState.peerConnected — Supabase presence,
        // which a vessel PHONE joins the channel to establish. The Pi never
        // joins the channel at all: it POSTs each position to the anchor-relay
        // function, which broadcasts it. So with the Pi keeping the watch,
        // peerConnected was false forever and the banner read "Vessel offline
        // · showing last-known data from 8s ago" while positions arrived
        // perfectly every ten seconds.
        //
        // A vessel that sent us a position seconds ago is online. That is the
        // direct evidence; presence was only ever a proxy for it.
        const vesselHeardRecently = shoreDataAgeMs !== null && shoreDataAgeMs <= SHORE_DATA_STALE_MS;
        // Presence counts ONLY where presence exists. A vessel phone joins the
        // channel, so it going away is real news and must still override fresh
        // data. The Pi never joins at all, so it has no presence to lose —
        // peerDisconnectedAt is the difference between "a peer left" and
        // "there was never a peer", and reading the first as the second is
        // what made every Pi-kept watch read as offline.
        const peerDropped = syncState?.peerConnected !== true && !!syncState?.peerDisconnectedAt;
        const shoreGpsLost = shoreAlarm.cause === 'gps-lost';
        const shoreDataFresh = shoreData !== null && vesselHeardRecently && !peerDropped && !shoreGpsLost;
        const shoreDataAgeLabel =
            shoreDataAgeMs === null ? 'no update received' : `${Math.floor(shoreDataAgeMs / 1000)}s ago`;
        const shoreStatusIsAlarm = shoreAlarm.cause === 'drag' || shoreData?.isAlarm === true;
        const shoreStatusLabel = shoreGpsLost
            ? 'Vessel GPS lost'
            : shoreDataFresh
              ? shoreStatusIsAlarm
                  ? 'Drag Alarm'
                  : 'Holding'
              : shoreStatusIsAlarm
                ? 'Last-known drag alarm'
                : 'Last-known data';
        const shoreDisconnectedWithKnownData = shoreData !== null && peerDropped;
        const shoreDataAgedOut = shoreData !== null && !vesselHeardRecently;
        // One expression for "the link is lost", rather than the same two-part
        // test repeated at four call sites where they could drift apart.
        const shoreLinkLost =
            shoreDisconnectedWithKnownData ||
            shoreDataAgedOut ||
            (shoreData === null && !!syncState?.peerDisconnectedAt);

        // ── Move the mark of the Pi's watch (126-07a) ──
        //
        // Only on the phone that handed its watch to the Pi (a crew phone
        // cannot), behind the trial switch until Shane's smoke aboard, and only
        // on a fresh report whose fix is no more than 30 s old (the keeper's
        // own limit), with no alarm and the GPS seen. The move re-posts
        // the Pi's assignment through the keeper; it never begins or ends a
        // watch. The same rule as the boat's own chip: losing any of these
        // closes the sheet, and it does not spring back open. (Set while
        // rendering, React's pattern for state that follows what is rendered:
        // this branch is past the page's hooks.)
        const canMovePiAnchor =
            ownPiWatch &&
            piMoveTrial &&
            shoreDataFresh &&
            piFixIsFresh(shoreData?.vessel, Date.now()) &&
            !shoreStatusIsAlarm &&
            !shoreGpsLost;
        if (showPiMove && !canMovePiAnchor) setShowPiMove(false);
        const handlePiMove = (lat: number, lon: number) =>
            AnchorPiWatchKeeper.relocate(lat, lon, {
                boatFix: shoreData?.vessel ?? null,
                alarm: shoreStatusIsAlarm,
                gpsLost: shoreGpsLost,
            });
        const handlePiMoved = () => {
            setShowPiMove(false);
            void triggerHaptic('medium');
            toast.success('Moved. The Pi is watching the new point.');
        };
        // Filled from what the Pi reports: her fix, the circle, the rode.
        const piMoveSource: PiMoveSource | null =
            showPiMove && canMovePiAnchor && shoreData
                ? {
                      anchor: { latitude: shoreData.anchor.latitude, longitude: shoreData.anchor.longitude },
                      boatFix: shoreData.vessel,
                      swingRadius: shoreData.swingRadius,
                      rodeLength: shoreData.config?.rodeLength,
                      waterDepth: shoreData.config?.waterDepth,
                      centreAtSet: AnchorPiWatchKeeper.centreAtSet(),
                      ashore: AnchorPiWatchKeeper.answersFromAshore(),
                      alarm: shoreStatusIsAlarm,
                      gpsLost: shoreGpsLost,
                  }
                : null;

        return (
            <div
                className={`h-full min-h-0 ${t.colors.bg.base} flex flex-col overflow-hidden`}
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                data-testid="shore-watch-page"
            >
                <PageHeader
                    title="Shore Watch"
                    subtitle={
                        <p className="text-xs flex items-center gap-1.5 mt-0.5 font-bold uppercase tracking-widest">
                            {shoreDataFresh ? (
                                <>
                                    <span className="w-2 h-2 bg-emerald-500 rounded-full inline-block animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" />{' '}
                                    <span className="text-emerald-400">Vessel Data Live</span>
                                </>
                            ) : syncState?.peerConnected ? (
                                <>
                                    <span className="w-2 h-2 bg-amber-500 rounded-full inline-block" />{' '}
                                    <span className="text-amber-400">
                                        {shoreData ? 'Vessel Data Stale' : 'Waiting for Vessel Data'}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className="w-2 h-2 bg-red-500 rounded-full inline-block animate-pulse" />{' '}
                                    <span className="text-red-400">Vessel Offline</span>
                                </>
                            )}
                        </p>
                    }
                    onBack={onBack}
                    action={
                        <button
                            onClick={handleStopWatch}
                            className="min-h-11 px-3 py-1.5 bg-red-500/8 border border-red-500/20 rounded-lg text-red-400 text-sm font-bold transition-all active:scale-95"
                            aria-label="Leave Shore Watch"
                        >
                            Leave
                        </button>
                    }
                />

                {pushReadiness.status !== 'ready' && (
                    <section
                        aria-label="Background notification readiness"
                        className="shrink-0 mx-4 mb-2 rounded-xl border border-amber-400/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
                    >
                        {/* Wraps: at large text sizes the Retry button ran past the
                            card's right edge instead of taking its own line. */}
                        <div className="flex flex-wrap items-center justify-between gap-x-3">
                            <p role="status" aria-live="polite" className="font-bold">
                                {pushReadiness.status === 'checking'
                                    ? 'Checking background notifications…'
                                    : 'Background notifications not verified'}
                            </p>
                            <button
                                type="button"
                                disabled={pushReadiness.status === 'checking'}
                                onClick={() => void AnchorWatchSyncService.refreshPushReadiness()}
                                className="min-h-11 shrink-0 px-2 font-bold text-sky-300 disabled:opacity-50"
                            >
                                Retry notifications
                            </button>
                        </div>
                        <p className="mt-1">
                            {pushReadiness.reason || 'Keep this app open until notification setup is verified.'}
                        </p>
                    </section>
                )}

                {/* Connection/freshness banner. Retained vessel values are useful,
                    but must be unmistakably last-known whenever the peer is gone
                    or the five-second position feed has stopped. */}
                {!shoreDataFresh && (
                    <div
                        className={`shrink-0 mx-3 mt-1 px-3 py-2.5 flex items-center gap-2 rounded-xl border ${
                            shoreLinkLost ? 'bg-red-500/8 border-red-500/25' : 'bg-amber-500/8 border-amber-500/25'
                        }`}
                    >
                        <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 animate-pulse ${
                                shoreLinkLost
                                    ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                                    : 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]'
                            }`}
                        />
                        <span
                            className={`text-sm font-bold flex-1 inline-flex items-center gap-1.5 ${
                                shoreLinkLost ? 'text-red-400' : 'text-amber-400'
                            }`}
                        >
                            {shoreLinkLost && <AlertTriangleIcon className="w-4 h-4" />}
                            <span>
                                {shoreDisconnectedWithKnownData
                                    ? `Vessel offline · showing last-known data from ${shoreDataAgeLabel}`
                                    : shoreDataAgedOut
                                      ? `Vessel data is stale · showing last-known update from ${shoreDataAgeLabel}`
                                      : syncState?.peerDisconnectedAt
                                        ? 'Vessel connection lost · no current vessel data received'
                                        : 'Connecting to vessel · waiting for current data…'}
                            </span>
                        </span>
                        <span
                            className={`text-sm animate-pulse ${
                                shoreDisconnectedWithKnownData ||
                                (!syncState?.peerConnected && syncState?.peerDisconnectedAt)
                                    ? 'text-red-300'
                                    : 'text-amber-300'
                            }`}
                        >
                            {!syncState?.peerConnected
                                ? 'Reconnecting…'
                                : shoreData
                                  ? 'Awaiting update…'
                                  : 'Connecting…'}
                        </span>
                    </div>
                )}

                {/* This region, not the whole page, can scroll on small or
                    enlarged-text screens. The tab bar has its own clearance. */}
                <div
                    data-testid="shore-readings-scroll"
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
                >
                    <div className="flex min-h-full flex-col justify-center py-2">
                        {shoreData ? (
                            <ShoreWatchReadings
                                data={shoreData}
                                fresh={shoreDataFresh}
                                isAlarm={shoreStatusIsAlarm}
                                statusLabel={shoreStatusLabel}
                                showMute={!!shoreAlarm.cause}
                                muted={shoreAlarm.muted}
                                onMute={() => void handleMuteShoreAlarm()}
                                lengthUnit={units?.length === 'ft' ? 'ft' : 'm'}
                                speedUnit={units?.speed ?? 'kts'}
                                distanceUnit={units?.distance}
                                trail={ShoreSwingTrail.points(syncState?.sessionCode ?? null)}
                                radarAction={
                                    canMovePiAnchor ? <MoveAnchorChip onClick={() => setShowPiMove(true)} /> : undefined
                                }
                                phoneWatched={
                                    // Only a phone that can take the page locked is promised it.
                                    pushReadiness.status === 'ready' &&
                                    !!phoneBeat &&
                                    phoneBeat.ageMs + Date.now() - phoneBeat.readAt < 180_000
                                }
                            />
                        ) : (
                            <div className="text-center">
                                <div className="mx-auto mb-4 h-12 w-12 rounded-full border-2 border-sky-500 border-t-transparent motion-safe:animate-spin" />
                                <div className="text-slate-400">Waiting for vessel data…</div>
                                <div className="mt-2 text-sm text-slate-400">Session: {syncState?.sessionCode}</div>
                            </div>
                        )}
                        {ownPiWatch && <ShoreWeighAnchorBar onWeighAnchor={() => void handleWeighAnchorFromShore()} />}
                    </div>
                </div>

                {/* Move anchor: the watch this phone handed to the Pi (canMovePiAnchor). */}
                {piMoveSource && (
                    <MoveAnchorSheet
                        mode="pi"
                        pi={piMoveSource}
                        onPiMove={handlePiMove}
                        onClose={() => setShowPiMove(false)}
                        onMoved={handlePiMoved}
                    />
                )}
            </div>
        );
    }

    // ---- RENDER: WATCHING ----
    const monitoringBlocked = snapshot?.state === 'paused';
    const foreignAccountRecovery = Boolean(
        monitoringBlocked && !snapshot?.anchorPosition && snapshot?.setupError?.includes('Account changed'),
    );
    const corruptConfigRecovery = Boolean(
        monitoringBlocked && snapshot?.setupError?.startsWith('Saved Anchor Watch is blocked'),
    );
    const isHolding = Boolean(snapshot && !monitoringBlocked && snapshot.distanceFromAnchor <= snapshot.swingRadius);
    const liveStatusLabel = monitoringBlocked ? 'Not Monitoring' : isHolding ? 'Holding' : 'Drifting';
    // 126-07d: the area note, only while the anchor is still the one it was about.
    const anchorNow = snapshot?.anchorPosition;
    const areaNoteShown =
        areaNote &&
        anchorNow &&
        anchorNow.timestamp === areaNote.anchor.timestamp &&
        anchorNow.latitude === areaNote.anchor.latitude &&
        anchorNow.longitude === areaNote.anchor.longitude
            ? areaNote
            : null;
    const areaLines = areaNoteShown
        ? areaNoteShown.all
            ? areaNoteShown.warnings
            : areaNoteShown.warnings.slice(0, 2)
        : [];
    const holdPercent =
        snapshot && snapshot.swingRadius > 0
            ? Math.min(100, (snapshot.distanceFromAnchor / snapshot.swingRadius) * 100)
            : 0;

    return (
        <div
            className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden`}
            style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
        >
            <PageHeader
                title={monitoringBlocked ? 'Anchor Watch Blocked' : 'Anchor Deployed'}
                subtitle={
                    monitoringBlocked
                        ? 'Safety monitoring is not running'
                        : snapshot?.watchStartedAt
                          ? `${formatElapsed(snapshot.watchStartedAt)} elapsed`
                          : 'Monitoring…'
                }
                onBack={onBack}
                action={
                    <div className="flex items-center gap-2">
                        {/* Guardian status badge */}
                        {!monitoringBlocked && snapshot?.guardianStatus && snapshot.guardianStatus !== 'idle' && (
                            <div
                                className={`px-2 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 border ${
                                    snapshot.guardianStatus === 'armed' || snapshot.guardianStatus === 'already_armed'
                                        ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-400'
                                        : snapshot.guardianStatus === 'arming'
                                          ? 'bg-sky-500/8 border-sky-500/20 text-sky-400'
                                          : 'bg-red-500/8 border-red-500/20 text-red-400'
                                }`}
                            >
                                <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                        snapshot.guardianStatus === 'armed' ||
                                        snapshot.guardianStatus === 'already_armed'
                                            ? 'bg-emerald-400'
                                            : snapshot.guardianStatus === 'arming'
                                              ? 'bg-sky-400 animate-pulse'
                                              : 'bg-red-400'
                                    }`}
                                />
                                {snapshot.guardianStatus === 'armed'
                                    ? 'Armed'
                                    : snapshot.guardianStatus === 'already_armed'
                                      ? 'Armed'
                                      : snapshot.guardianStatus === 'arming'
                                        ? 'Arming'
                                        : 'Failed'}
                            </div>
                        )}
                        {/* Hold status dot */}
                        <div
                            className={`w-3 h-3 rounded-full ${monitoringBlocked ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]' : isHolding ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'}`}
                        />
                    </div>
                }
            />

            {monitoringBlocked && (
                <div
                    role="alert"
                    className="mx-3 mt-1 shrink-0 rounded-2xl border-2 border-amber-300/60 bg-amber-950/90 px-4 py-3 shadow-[0_0_24px_rgba(245,158,11,0.18)]"
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                        <div className="min-w-0">
                            <p className="text-sm font-black uppercase tracking-wider text-amber-200">
                                Not monitoring — act now
                            </p>
                            <p className="mt-1 text-sm font-semibold leading-snug text-amber-50">
                                {snapshot?.setupError ||
                                    'Anchor Watch could not confirm its GPS, geofence, audio, or recovery safety path.'}
                            </p>
                            <p className="mt-1 text-xs text-amber-200/80">
                                {snapshot?.anchorPosition && !corruptConfigRecovery
                                    ? 'The anchor position below is retained reference data only. Keep a physical watch until monitoring is restarted.'
                                    : foreignAccountRecovery
                                      ? 'Saved watch details belong to the previous account and remain hidden. Retry Weigh Anchor until cleanup is confirmed.'
                                      : 'Saved watch details are unavailable or corrupt. Use Weigh Anchor to clear the blocked recovery record.'}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Action Buttons — glassmorphism pills */}
            <div className="shrink-0 px-3 py-1.5 flex gap-2">
                {monitoringBlocked && snapshot?.anchorPosition && !corruptConfigRecovery ? (
                    <button
                        onClick={() => void handleRetryMonitoring()}
                        disabled={isRetryingMonitoring}
                        className="flex-1 rounded-xl border border-amber-300/40 bg-amber-500/15 py-3 text-sm font-black text-amber-100 transition-all active:scale-[0.97] disabled:cursor-wait disabled:opacity-60"
                        aria-label="Retry Anchor Watch monitoring"
                    >
                        {isRetryingMonitoring ? 'Retrying Safety Checks…' : 'Retry Monitoring'}
                    </button>
                ) : monitoringBlocked ? (
                    <div className="flex-1 rounded-xl border border-amber-300/30 bg-amber-500/10 px-3 py-3 text-center text-xs font-black text-amber-100">
                        {foreignAccountRecovery ? 'Previous account — cleanup only' : 'Blocked recovery — cleanup only'}
                    </div>
                ) : syncState?.connected ? (
                    <div className="flex-1 flex items-center justify-center gap-2 py-3 bg-sky-500/8 border border-sky-500/20 rounded-xl">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" />
                        <span className="text-sm text-sky-400 font-mono font-bold tracking-wider">
                            {syncState.sessionCode}
                        </span>
                        <span className="text-sm text-slate-400 uppercase">sharing</span>
                    </div>
                ) : (
                    // The feature's one name, as the setup page's header button
                    // and the shore phone's page title say it (UX scorecard run
                    // 10: 'Shore Share' was a third name). Named by its words,
                    // not 'Create Session', so Voice Control can say what it sees.
                    <button
                        onClick={handleCreateSession}
                        className="flex-1 py-3 bg-sky-500/8 border border-sky-500/20 rounded-xl text-sm text-sky-400 font-bold transition-all active:scale-[0.97] hover:bg-sky-500/12"
                    >
                        <span className="inline-flex items-center gap-2 justify-center">
                            <PhoneIcon className="w-4 h-4" />
                            <span>{authedUser ? 'Start Shore Watch' : 'Sign in for Shore Watch'}</span>
                        </span>
                    </button>
                )}
                <button
                    onClick={() => {
                        const next = !showAisOnRadar;
                        setShowAisOnRadar(next);
                        try {
                            localStorage.setItem('thalassa_anchor_ais', next ? 'on' : 'off');
                        } catch (e) {
                            console.warn('Suppressed:', e);
                            /* */
                        }
                        triggerHaptic('light');
                    }}
                    disabled={monitoringBlocked}
                    className={`py-3 px-3 border rounded-xl text-sm font-bold transition-all active:scale-[0.97] disabled:hidden ${
                        showAisOnRadar
                            ? 'bg-sky-500/12 border-sky-500/30 text-sky-400'
                            : 'bg-white/3 border-white/6 text-slate-500'
                    }`}
                    aria-label={showAisOnRadar ? 'Hide AIS targets' : 'Show AIS targets'}
                >
                    <PowerBoatIcon className="w-5 h-5 mx-auto" />
                </button>
                <button
                    onClick={handleStopWatch}
                    className={`flex-1 py-3 bg-red-500/8 border border-red-500/20 rounded-xl text-red-400 text-sm font-bold transition-all active:scale-[0.97] hover:bg-red-500/12`}
                    aria-label="Stop Watch"
                >
                    ⏏ Weigh Anchor
                </button>
            </div>

            {/* Shore Disconnection Banner — visible when shore device drops */}
            {syncState?.connected && !syncState.peerConnected && syncState.sessionCode && (
                <div className="shrink-0 mx-3 mb-1.5 px-3 py-2 flex items-center gap-2 bg-amber-500/8 border border-amber-500/25 rounded-xl animate-pulse">
                    <span className="w-2 h-2 bg-amber-400 rounded-full shrink-0" />
                    <span className="text-xs text-amber-400 font-bold flex-1 inline-flex items-center gap-1.5">
                        {!!syncState.peerDisconnectedAt && <AlertTriangleIcon className="w-3.5 h-3.5" />}
                        <span>
                            {syncState.peerDisconnectedAt
                                ? `Shore device disconnected · Lost ${formatElapsed(syncState.peerDisconnectedAt)} ago`
                                : 'Waiting for shore device…'}
                        </span>
                    </span>
                    <span className="text-xs text-amber-500/60">Waiting…</span>
                </div>
            )}

            {/* The way back to the offer after "no, keep it here".
                Without this, declining once was a dead end for the whole
                session: the prompt is asked once and there was no other route
                to the feature short of weighing anchor. */}
            {piWatchCapable && !piKeepingWatch && (
                <button
                    onClick={() => setShowPiWatchOffer(true)}
                    className="mx-3 mb-2 flex min-h-[56px] items-center gap-3 rounded-2xl border border-sky-400/30 bg-sky-500/10 px-4 text-left transition-all active:scale-[0.99]"
                >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-sky-400/30 bg-sky-500/15 text-sky-300">
                        <AnchorIcon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-black tracking-tight text-sky-200">
                            Hand the watch to the Pi
                        </span>
                        <span className="block text-[12px] font-medium text-sky-300/70">
                            {piHasFix ? 'Aboard, mains powered, has a fix' : 'Aboard and ready'}
                        </span>
                    </span>
                    <span className="shrink-0 text-sky-300/60">›</span>
                </button>
            )}

            {/* No Pi offer, and WHY. Six fixes were shipped blind because this
                line did not exist: the probe has several failure exits and
                every one of them used to look identical from the deck. */}
            {!piWatchCapable && !piKeepingWatch && piWatchReason && (
                <div className="mx-3 mb-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2">
                    <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        Pi watch unavailable
                    </span>
                    <span className="block text-[12px] font-medium leading-4 text-slate-400">{piWatchReason}</span>
                </div>
            )}

            {/* Main Card — gradient glass, fits available space */}
            <div className="flex-1 min-h-0 mx-3 mb-3 bg-linear-to-b from-slate-900/70 to-slate-950/50 rounded-2xl border border-white/[0.07] flex flex-col overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.3)]">
                {/* Status Badge — animated with dot */}
                <div className="shrink-0 flex justify-center py-2">
                    <div
                        className={`px-6 py-1.5 rounded-full text-sm font-black tracking-widest uppercase transition-all flex items-center gap-2 ${
                            monitoringBlocked
                                ? 'bg-amber-500/15 border border-amber-300/40 text-amber-200'
                                : isHolding
                                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                  : 'bg-red-500/10 border border-red-500/30 text-red-400 animate-pulse'
                        }`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full ${monitoringBlocked ? 'bg-amber-300' : isHolding ? 'bg-emerald-400' : 'bg-red-400'}`}
                        />
                        {liveStatusLabel}
                    </div>
                </div>

                {/* Canvas — fills available space */}
                <div className="flex-1 relative min-h-0">
                    <SwingCircleCanvas
                        snapshot={snapshot}
                        aisTargets={showAisOnRadar ? aisTargets : undefined}
                        ariaLabel={`Anchor watch radar display. ${monitoringBlocked ? 'Monitoring is blocked; values are retained reference data only' : isHolding ? 'Vessel holding position' : 'Vessel drifting'}. Current distance from anchor: ${snapshot ? formatDistance(snapshot.distanceFromAnchor) : 'unknown'}. Swing radius: ${snapshot ? formatDistance(snapshot.swingRadius) : 'unknown'}.`}
                    />
                    {/* Along the radar's foot, side by side so they never overlap:
                        Move anchor, and (126-07d) the area note folded once read,
                        the area in a chip that opens it again. Where the radar is
                        squeezed out (a small phone, landscape, large text) it has
                        no room for that chip, which would lie over the status
                        badge: there the read note leaves none. */}
                    {(canMoveAnchor || areaNoteShown?.folded) && (
                        <div className="pointer-events-none absolute inset-0 [container-type:size]">
                            <div className="absolute inset-x-1.5 bottom-1.5 flex items-end gap-2">
                                {canMoveAnchor && (
                                    <MoveAnchorChip
                                        className="pointer-events-auto shrink-0"
                                        onClick={() => setShowMoveAnchor(true)}
                                    />
                                )}
                                {areaNoteShown?.folded && (
                                    <button
                                        type="button"
                                        data-testid="anchor-area-chip"
                                        onClick={() => setAreaNote({ ...areaNoteShown, folded: false })}
                                        aria-label={`Chart area note: ${areaNoteShown.warnings[0].area}`}
                                        className="pointer-events-auto ml-auto flex min-h-11 min-w-11 items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-950/90 px-3 text-sm font-bold text-amber-100 [@container(max-height:3.5rem)]:hidden"
                                    >
                                        <AlertTriangleIcon className="h-4 w-4 shrink-0" />
                                        <span className="truncate first-letter:uppercase">
                                            {areaNoteShown.warnings[0].area}
                                        </span>
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* The stats and the readout, and the area note read over them.
                    It gives way (min-h-0) only where the card cannot show them
                    all, so the note stays on what the card shows. */}
                <div className="relative min-h-0">
                    {/* 126-07d: the anchor is down inside a charted area where
                        anchoring is a problem: which area, what it is, where that
                        comes from, and that the watch is on. The two most serious,
                        "+N more" for the rest. Or, quietly, that no chart covers
                        the anchor or the chart could not be checked. Under the
                        radar in reading order, drawn over the stats and the
                        readout for a read (AREA_NOTE_READ_MS), never over the
                        radar or its chips: in the flow it took a 375 x 667 radar
                        from 95 px to 5, and the radar is already squeezed out at
                        320 x 568, in landscape and at large text. A long list
                        scrolls inside the note; Dismiss (44 px, floated in its
                        corner so the words use the width under it) or the read
                        running out gives the readout back
                        (browser-tests/anchor-antenna-layout.spec.ts). */}
                    {areaNoteShown && !areaNoteShown.folded && (
                        <div
                            role="status"
                            data-testid="anchor-area-note"
                            className={`absolute inset-x-2 bottom-2 z-10 max-h-[calc(100%-0.5rem)] overflow-y-auto overscroll-contain rounded-xl border pb-1.5 pl-3 text-[12px] leading-snug font-semibold shadow-[0_0_24px_rgba(0,0,0,0.45)] ${
                                areaLines.length
                                    ? 'border-amber-300/50 bg-amber-950 text-amber-100'
                                    : 'border-white/10 bg-slate-900 text-slate-300'
                            }`}
                        >
                            <button
                                type="button"
                                onClick={() => setAreaNote(null)}
                                aria-label="Dismiss the chart area note"
                                className="float-right flex h-11 w-11 items-center justify-center rounded-xl"
                            >
                                <XIcon className="h-4 w-4" />
                            </button>
                            {areaLines.map((line) => (
                                <p key={`${line.source}|${line.kind}|${line.area}`} className="pt-1.5">
                                    {line.words.startsWith(`Inside ${line.area}`) ? (
                                        <>
                                            Inside <strong className="font-black text-amber-50">{line.area}</strong>
                                            {line.words.slice(`Inside ${line.area}`.length)}
                                        </>
                                    ) : (
                                        line.words
                                    )}
                                </p>
                            ))}
                            {areaLines.length < areaNoteShown.warnings.length && (
                                <button
                                    type="button"
                                    onClick={() => setAreaNote({ ...areaNoteShown, all: true })}
                                    className="flex min-h-11 items-center font-black text-amber-50 underline"
                                >
                                    +{areaNoteShown.warnings.length - areaLines.length} more
                                </button>
                            )}
                            {areaLines.length === 0 ? (
                                <p className="pt-3.5">
                                    {areaNoteShown.charts === 'none'
                                        ? 'No chart areas loaded here to check the anchor against.'
                                        : 'The chart here could not be checked.'}
                                </p>
                            ) : (
                                !monitoringBlocked && <p className="pt-1">Your anchor watch is on.</p>
                            )}
                        </div>
                    )}

                    {/* Stats Grid — 2×3 */}
                    <div className="shrink-0 px-2.5 pb-1.5">
                        <div className="grid grid-cols-3 gap-1.5">
                            {/* WHICH receiver the watch believes, not just how
                                accurate it is. 'BOAT' means the vessel's own GPS;
                                'PHONE' means this device — and if this device is
                                ashore, the swing circle is being measured from the
                                wrong place. Those two must never look alike
                                (Shane 2026-08-08, monitoring over Tailscale). */}
                            <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/4">
                                <div className={t.typography.labelSm}>
                                    {snapshot?.gpsSource === 'nmea' ? (
                                        <span className="inline-flex items-center gap-1 text-cyan-300">
                                            <AnchorIcon className="h-3 w-3 shrink-0" />
                                            BOAT GPS
                                        </span>
                                    ) : snapshot?.gpsSource === 'native' ? (
                                        <span className="inline-flex items-center gap-1 text-amber-300">
                                            <DeviceIcon className="h-3 w-3 shrink-0" />
                                            PHONE GPS
                                        </span>
                                    ) : (
                                        'GPS'
                                    )}
                                </div>
                                <div
                                    className={`text-sm font-black font-mono ${(snapshot?.gpsAccuracy ?? 99) < 10 ? 'text-emerald-400' : (snapshot?.gpsAccuracy ?? 99) < 20 ? 'text-amber-400' : 'text-red-400'}`}
                                >
                                    {snapshot ? `±${snapshot.gpsAccuracy.toFixed(0)} m` : '--'}
                                </div>
                            </div>
                            <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/4">
                                <div className={t.typography.labelSm}>Bearing</div>
                                <div className="text-sm font-black font-mono text-slate-200">
                                    {snapshot
                                        ? `${snapshot.bearingToAnchor.toFixed(0)}° ${bearingToCardinal(snapshot.bearingToAnchor)}`
                                        : `--`}
                                </div>
                            </div>
                            <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/4">
                                <div className={t.typography.label}>Max Drift</div>
                                <div className="text-sm font-black font-mono text-slate-200">
                                    {snapshot ? formatDistance(snapshot.maxDistanceRecorded) : `--`}
                                </div>
                            </div>
                            <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/4">
                                <div className={t.typography.label}>Rode</div>
                                <div className="text-sm font-black font-mono text-slate-200">
                                    {snapshot ? `${Math.round(snapshot.config.rodeLength)} m` : '--'}
                                </div>
                            </div>
                            <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/4">
                                <div className={t.typography.label}>Depth</div>
                                <div className="text-sm font-black font-mono text-slate-200">
                                    {snapshot ? `${snapshot.config.waterDepth.toFixed(1)} m` : '--'}
                                </div>
                            </div>
                            <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/4">
                                <div className={t.typography.label}>Scope</div>
                                <div className="text-sm font-black font-mono text-slate-200">
                                    {snapshot
                                        ? (snapshot.config.rodeLength / snapshot.config.waterDepth).toFixed(1)
                                        : `--`}
                                    :1
                                </div>
                            </div>
                        </div>
                        {/* Marked at the boat's GPS with no heading to put it at
                            the bow (126-07c): the circle allows for the antenna
                            twice over, so the radius is larger than the rode
                            explains. One sentence: it comes out of the radar's
                            height (browser-tests/anchor-antenna-layout.spec.ts). */}
                        {snapshot?.markedAtGps && (snapshot.config.antennaAllowanceM ?? 0) > 0 && (
                            <p className="mt-1 text-[11px] leading-snug font-medium text-cyan-200/80">
                                Marked at the GPS,{' '}
                                {units?.length === 'ft'
                                    ? `${Math.round((snapshot.config.antennaAllowanceM ?? 0) / 2 / 0.3048)} ft`
                                    : `${Math.round((snapshot.config.antennaAllowanceM ?? 0) / 2)} m`}{' '}
                                aft of the bow: the circle allows for it.
                            </p>
                        )}
                    </div>

                    {/* Distance / Radius — premium readout */}
                    <div className="shrink-0 border-t border-white/6 px-4 py-1.5 bg-slate-900/30">
                        <div className="flex items-center justify-around gap-4">
                            <div className="text-center flex-1">
                                <div className="text-xs text-slate-400 uppercase tracking-wider">
                                    {monitoringBlocked ? 'Last-Known Distance' : 'Distance'}
                                </div>
                                <div
                                    className={`text-xl font-black font-mono ${monitoringBlocked ? 'text-amber-300' : isHolding ? 'text-emerald-400' : 'text-red-400'}`}
                                >
                                    {snapshot ? formatDistance(snapshot.distanceFromAnchor) : '--'}
                                </div>
                            </div>
                            <div className="w-px h-8 bg-linear-to-b from-transparent via-white/10 to-transparent" />
                            <div className="text-center flex-1">
                                <div className="text-xs text-slate-400 uppercase tracking-wider">Radius</div>
                                <div className="text-xl font-black font-mono text-white">
                                    {snapshot ? formatDistance(snapshot.swingRadius) : `--`}
                                </div>
                            </div>
                        </div>

                        {/* Gradient usage bar */}
                        <div className="mt-1.5 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                            <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{
                                    width: `${holdPercent}%`,
                                    background:
                                        holdPercent > 85
                                            ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                                            : holdPercent > 60
                                              ? 'linear-gradient(90deg, #22c55e, #f59e0b)'
                                              : 'linear-gradient(90deg, #06b6d4, #22c55e)',
                                }}
                            />
                        </div>
                        <div className="flex justify-between text-xs text-slate-400 mt-0.5">
                            <span>Anchor</span>
                            <span className="font-bold font-mono">{holdPercent.toFixed(0)}%</span>
                            <span>Alarm</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Move anchor: the watch THIS phone keeps (canMoveAnchor). */}
            {showMoveAnchor && canMoveAnchor && snapshot && (
                <MoveAnchorSheet
                    snapshot={snapshot}
                    onClose={() => setShowMoveAnchor(false)}
                    onMoved={handleAnchorMoved}
                />
            )}

            {/* The Pi offer lives HERE, in the watching view — the only state
                it means anything in. It was first placed beside the setup
                view's SignInScreen, which is inside that view's early return,
                so the dialog was invisible while watching and appeared the
                instant the anchor was weighed and the view flipped to setup
                (Shane 2026-09-03: "this only comes up after i press weigh the
                anchor"). Gated on viewMode too, so a late-resolving probe can
                never raise it over a view where there is no anchor to hand
                over. */}
            <AnchorPiWatchOfferModal
                isOpen={showPiWatchOffer && viewMode === 'watching'}
                busy={piHandoffBusy}
                piHasFix={piHasFix}
                onAccept={handleAcceptPiWatch}
                onDecline={() => setShowPiWatchOffer(false)}
            />

            <SignInScreen
                isOpen={showShoreSignIn}
                onClose={() => setShowShoreSignIn(false)}
                prompt="Sign in to share Anchor Watch between your vessel and shore devices. Local Anchor Watch remains available without an account."
            />
        </div>
    );
});
