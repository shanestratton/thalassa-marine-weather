/**
 * PassageHudPane — the one place to look while under way, on the chart.
 *
 * Shane, 2026-09-17, after three days north on Serene Summer: "the only real
 * issue i have is i dont really know which screen to look at … a new layer on
 * the obs page. this layer will show cog, sog, wind speed, direction and true
 * and apparent … the current track that we are on, and the route we are
 * following … most of the info needs to be on a pane that can be hidden to one
 * side (left i am thinking)."
 *
 * PHASE 1 (this file): the live strip. Distance left ALONG the followed route,
 * then the boat's six numbers, then which lane they came through and what the
 * GPS is doing. Phase 2 adds the bottom scrubber, the ghost starting from the
 * boat's own position, a 7-day horizon and a forecast state with a
 * change-model button (Shane's decisions, 2026-09-18). Nothing here shows a
 * forecast yet, and nothing here ever dresses a forecast as a live reading.
 *
 * WHY A 76 px STRIP AND NOT A CARD. Two review rounds measured a 176–200 px
 * card against the chart's real furniture: it covered the Copernicus licence
 * credit (121 px tall, not a 30 px slot), the wind legend, the ENC notice and
 * the tide scrubber, and on the flagship phone left 207 px of height — all six
 * instruments below the fold. The centred furniture all starts at x >= 76 on
 * a 393 px phone, so a strip no wider than that, down the left edge like a
 * chartplotter's data bar, clears every one of them and shows every number at
 * once. What DOES share its column is dealt with one piece at a time, each
 * measured: the Back chevron moves INTO the strip (App hides its own while the
 * strip is shown), the wind legend folds to its chip and steps right, the
 * squall/lightning legend stack and the ENC coverage notice step right, and
 * the strip stands down entirely for a storm card, the planning surfaces and a
 * landscape phone. It sits at z-549, one under the offline card (z-550), so that
 * notice reads whole until it is dismissed. Not a dialog: the chart stays live.
 *
 * OFF BY DEFAULT. Settings → Preferences → "Passage strip on the chart".
 * Three review rounds each found new furniture in this column; until it has
 * been seen on the water it reaches nobody who did not ask for it.
 *
 * HONESTY:
 *   - dead instruments are dashes, not the last number, and NOT the phone's
 *     SOG/COG standing in (Shane 2026-09-18: "show dashes");
 *   - stale values stay, dimmed;
 *   - COG is only a course when she is making way (>= 1 kn), the same rule the
 *     Instrument Panel uses — a moored boat's fixes wander;
 *   - a cloud reading is tagged as such, position included: it never steers.
 *     The pane does NOT start the cloud lane itself;
 *   - distance along the route uses the BOAT's fresh fix, else this phone's
 *     position only (never its speed or heading), aged honestly — a fix is as
 *     old as its own timestamp says, however recently it was handed over.
 *
 * THE PASSAGE OVERLAY IS THE SKIPPER'S SWITCH. The first cut flipped the
 * chart's Passage overlay with the pane and review found five ways that went
 * wrong (the overlay persists but "I did that" did not; MapHub only clears its
 * route and track from the layer button's own OFF path; every return to the
 * chart re-listed the ship's log). So there is one explicit button — the same
 * ON the layer button performs — and OFF stays where it works.
 */
import React, { useEffect, useRef, useState } from 'react';
import { usePassageHudEnabled, usePassageHudOpen, togglePassageHud } from '../../stores/passageHudStore';
import { usePassageHudInstruments, type HudMetric } from '../../hooks/usePassageHudInstruments';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { setPassageOverlay, usePassageOverlay } from '../../stores/chartPassageOverlay';
import { MOTION_MIN_NM, progressAlongRoute, type RouteProgress } from '../../services/routeProgress';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import { NmeaStore } from '../../services/NmeaStore';
import { LocationStore } from '../../stores/LocationStore';
import { GpsService } from '../../services/GpsService';
import { GpsReceiverStatusService, type GpsReceiverStatus } from '../../services/GpsReceiverStatusService';
import { getCachedActiveVoyage } from '../../services/VoyageService';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import { triggerHaptic } from '../../utils/system';
import {
    DASH,
    fixSourceSentence,
    fixSourceTag,
    fmtBearing,
    fmtKnots,
    fmtNm,
    fmtRelative,
    gpsStateTag,
    laneSentence,
    laneTag,
    type FixSource,
} from './passageHudFormat';

/** Below this she is not making way and COG is noise. Matches the Instrument Panel. */
export const HUD_MAKING_WAY_KTS = 1;
/** A phone fix older than this is said to be old… */
export const HUD_PHONE_FIX_FRESH_MS = 60_000;
/** …and past this it is not a position any more. */
export const HUD_PHONE_FIX_DEAD_MS = 10 * 60_000;
/** A reckoning older than this is not worth resuming from. */
const RECKONING_MAX_AGE_MS = 30 * 60_000;

/**
 * Where she was last reckoned along each followed route — kept OUTSIDE the
 * component, because the strip unmounts on every trip to another page and an
 * out-and-back must not forget it is on the way home each time she comes back
 * to the chart. Keyed on the route array itself, so a new route starts clean.
 */
const reckoning = new WeakMap<object, { alongNm: number; at: number }>();

/** Test seam. */
export function __forgetReckoningForTests(route: object): void {
    reckoning.delete(route);
}

const tone = (m: HudMetric): string =>
    m.value === null ? 'text-white/40' : m.freshness === 'stale' ? 'text-white/60' : 'text-white';

interface CellProps {
    label: string;
    value: string;
    unit?: string;
    metric: HudMetric;
    testId: string;
    sentence: string;
}

const Cell: React.FC<CellProps> = ({ label, value, unit, metric, testId, sentence }) => (
    <div
        className="border-b border-white/10 px-1 py-1 text-center"
        data-testid={testId}
        data-freshness={metric.value === null ? 'none' : metric.freshness}
        title={sentence}
        aria-label={sentence}
    >
        <p className="text-[10px] font-black uppercase leading-none text-gray-400">{label}</p>
        <p className={`font-mono text-[17px] font-black leading-tight tabular-nums ${tone(metric)}`}>
            {value}
            {unit && metric.value !== null && <span className="text-[10px] font-bold text-gray-500">{unit}</span>}
        </p>
    </div>
);

interface RouteFix {
    progress: RouteProgress;
    source: FixSource;
    ageMin: number;
}

const ClosedTab: React.FC<{ onToggle: () => void }> = ({ onToggle }) => (
    <button
        type="button"
        onClick={onToggle}
        aria-label="Show passage instruments"
        aria-expanded={false}
        data-testid="passage-hud-toggle"
        className="thalassa-passage-hud-tab absolute left-0 z-549 flex h-20 w-7 flex-col items-center justify-center gap-1 rounded-r-xl border border-l-0 border-white/15 bg-slate-950/90 shadow-xl backdrop-blur-md active:scale-95"
    >
        <svg className="h-3.5 w-3.5 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span
            className="text-[10px] font-black uppercase tracking-widest text-white/70"
            style={{ writingMode: 'vertical-rl' }}
        >
            HUD
        </span>
    </button>
);

const OpenPane: React.FC<{ onToggle: () => void; onBack?: () => void }> = ({ onToggle, onBack }) => {
    const inst = usePassageHudInstruments();
    const overlayOn = usePassageOverlay();
    const isFollowing = useFollowRouteStore((s) => s.isFollowing);
    const voyagePlan = useFollowRouteStore((s) => s.voyagePlan);
    const routeCoords = useFollowRouteStore((s) => s.routeCoords);
    const following = isFollowing && routeCoords.length >= 2;

    // The lane and her course can change while the route effect is running;
    // read them fresh.
    const viaRef = useRef(inst.via);
    viaRef.current = inst.via;
    const cogRef = useRef<number | null>(null);
    cogRef.current =
        inst.sog.value !== null && inst.sog.value >= HUD_MAKING_WAY_KTS && inst.cog.value !== null
            ? inst.cog.value
            : null;

    // The layer button offers Passage for an active voyage OR a followed
    // route; this button performs the same ON, so it answers to the same two.
    const [voyageActive, setVoyageActive] = useState<boolean>(() => !!getCachedActiveVoyage());
    useEffect(() => {
        const sync = () => setVoyageActive(!!getCachedActiveVoyage());
        sync();
        window.addEventListener('thalassa:active-voyage-changed', sync);
        return () => window.removeEventListener('thalassa:active-voyage-changed', sync);
    }, []);

    // ── Progress along the followed route ──
    const [fix, setFix] = useState<RouteFix | null>(null);
    useEffect(() => {
        if (!following) {
            setFix(null);
            return;
        }
        // Resume where she was last reckoned on THIS route, if that was recent.
        const remembered = reckoning.get(routeCoords);
        let lastAlong: number | undefined =
            remembered && Date.now() - remembered.at <= RECKONING_MAX_AGE_MS ? remembered.alongNm : undefined;
        let heading: number | undefined;
        let refPos: { lat: number; lon: number } | null = null;

        // This phone's position, from a PASSIVE watch (no ensureRunning: it can
        // never raise a permission prompt). A fix is as old as its own stamp.
        let phone: { lat: number; lon: number; at: number } | null = null;
        const take = (p: { latitude: number; longitude: number; timestamp?: number } | null) => {
            if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
            const stamp = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : Date.now();
            const at = Math.min(Date.now(), stamp);
            if (Date.now() - at > HUD_PHONE_FIX_DEAD_MS) return;
            phone = { lat: p.latitude, lon: p.longitude, at };
        };
        take(GpsService.getLastKnownPosition());

        const compute = () => {
            const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState());
            let at: { lat: number; lon: number } | null = null;
            let source: FixSource = 'boat';
            let ageMin = 0;
            if (own && own.source === 'nmea') {
                at = { lat: own.lat, lon: own.lon };
                source = viaRef.current === 'cloud' ? 'boat-cloud' : 'boat';
            } else if (phone) {
                const age = Date.now() - phone.at;
                if (age <= HUD_PHONE_FIX_DEAD_MS) {
                    at = { lat: phone.lat, lon: phone.lon };
                    source = age <= HUD_PHONE_FIX_FRESH_MS ? 'phone' : 'phone-old';
                    ageMin = Math.round(age / 60_000);
                }
            }
            if (at) {
                if (!refPos) refPos = at;
                else if (calculateDistance(refPos.lat, refPos.lon, at.lat, at.lon) >= MOTION_MIN_NM) {
                    heading = calculateBearing(refPos.lat, refPos.lon, at.lat, at.lon);
                    refPos = at;
                }
            }
            // Her own COG when she has one — a course made good lags 93 m, and
            // round a marina hairpin that is long enough to read the wrong lane.
            const headingDeg =
                source !== 'phone' && source !== 'phone-old' && cogRef.current !== null ? cogRef.current : heading;
            const progress = at ? progressAlongRoute(routeCoords, at, { alongNm: lastAlong, headingDeg }) : null;
            if (progress) {
                lastAlong = progress.alongNm;
                reckoning.set(routeCoords, { alongNm: progress.alongNm, at: Date.now() });
            }
            setFix((prev) => {
                if (!progress) return prev === null ? prev : null;
                const next: RouteFix = { progress, source, ageMin };
                return prev &&
                    prev.source === next.source &&
                    prev.ageMin === next.ageMin &&
                    fmtNm(prev.progress.toGoNm) === fmtNm(next.progress.toGoNm) &&
                    fmtNm(prev.progress.alongNm) === fmtNm(next.progress.alongNm) &&
                    fmtNm(prev.progress.offTrackNm) === fmtNm(next.progress.offTrackNm)
                    ? prev
                    : next;
            });
        };

        const unwatch = GpsService.watchPosition((pos) => take(pos));
        compute();
        const id = setInterval(compute, 2000);
        return () => {
            clearInterval(id);
            unwatch();
        };
    }, [following, routeCoords]);

    // ── What the GPS receiver is doing ──
    const [receiver, setReceiver] = useState<GpsReceiverStatus>(() => GpsReceiverStatusService.getStatus());
    useEffect(() => {
        let disposed = false;
        const refresh = () => {
            void GpsReceiverStatusService.refresh().then((r) => {
                if (!disposed) setReceiver(r);
            });
        };
        refresh();
        const id = setInterval(refresh, 5000);
        return () => {
            disposed = true;
            clearInterval(id);
        };
    }, []);

    const makingWay = inst.sog.value !== null && inst.sog.value >= HUD_MAKING_WAY_KTS;
    const cogMetric: HudMetric = makingWay ? inst.cog : { value: null, freshness: inst.cog.freshness };
    const anyValue = [inst.sog, inst.cog, inst.aws, inst.awa, inst.tws, inst.twd].some((m) => m.value !== null);
    const connected = inst.connectionStatus === 'connected' || inst.connectionStatus === 'remote';
    const routeName =
        voyagePlan?.origin && voyagePlan?.destination
            ? `${voyagePlan.origin} → ${voyagePlan.destination}`
            : voyagePlan?.destination || 'the followed route';
    const gpsTag = receiver.active ? gpsStateTag(receiver.detail) : null;

    const routeSentence = !following
        ? 'No route being followed. Follow one from the Log page and the distance left along it appears here.'
        : !fix
          ? `Following ${routeName}. No position — waiting for the boat’s GPS or this phone’s.`
          : `Following ${routeName}: ${fmtNm(fix.progress.toGoNm)} nautical miles to go, ${fmtNm(
                fix.progress.alongNm,
            )} of ${fmtNm(fix.progress.totalNm)} along the route${
                fix.progress.offTrackNm >= 0.5 ? `, including ${fmtNm(fix.progress.offTrackNm)} back to the line` : ''
            }. ${fixSourceSentence(fix.source, fix.ageMin)}.`;

    const cogSentence =
        inst.sog.value !== null && !makingWay
            ? 'Course over ground: not making way, no course to show'
            : `Course over ground ${fmtBearing(cogMetric)} true`;

    return (
        <aside
            aria-label="Passage instruments"
            data-testid="passage-hud"
            className="thalassa-passage-hud absolute left-0 z-549 flex w-[4.75rem] flex-col overflow-hidden rounded-r-2xl border border-l-0 border-white/15 bg-slate-950/92 shadow-2xl backdrop-blur-xl"
        >
            {/* Back lives HERE while the strip is shown: App's own chevron sits in
                this column, and index.css hides it for exactly as long as this
                one is on screen. */}
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    data-testid="hud-back"
                    className="flex h-10 shrink-0 items-center justify-center border-b border-white/10 active:scale-95"
                >
                    <svg
                        className="h-5 w-5 text-white"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
            )}
            <p className="shrink-0 border-b border-white/10 py-1 text-center text-[10px] font-black uppercase leading-none tracking-widest text-emerald-300">
                Live
            </p>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {/* The route FIRST: it is the number the strip exists to show. */}
                <div
                    className="border-b border-white/10 px-1 py-1 text-center"
                    data-testid="hud-route"
                    title={routeSentence}
                    aria-label={routeSentence}
                >
                    <p className="text-[10px] font-black uppercase leading-none text-gray-400">To go</p>
                    <p
                        className={`font-mono text-[19px] font-black leading-tight tabular-nums ${
                            !fix ? 'text-white/40' : fix.source === 'phone-old' ? 'text-white/60' : 'text-white'
                        }`}
                    >
                        {fix ? fmtNm(fix.progress.toGoNm) : DASH}
                        {fix && <span className="text-[10px] font-bold text-gray-500">NM</span>}
                    </p>
                    <p
                        className={`text-[10px] font-black uppercase leading-none ${
                            fix && fix.source !== 'boat' ? 'text-amber-300' : 'text-gray-400'
                        }`}
                        data-testid="hud-fix-source"
                    >
                        {!following ? 'NO ROUTE' : fix ? fixSourceTag(fix.source, fix.ageMin) : 'NO FIX'}
                    </p>
                    {fix && fix.progress.offTrackNm >= 0.5 && (
                        <p
                            className="text-[10px] font-black uppercase leading-none text-amber-300"
                            data-testid="hud-off-line"
                        >
                            {fmtNm(fix.progress.offTrackNm)} OFF
                        </p>
                    )}
                </div>

                <Cell
                    label="SOG"
                    value={fmtKnots(inst.sog)}
                    unit="kn"
                    metric={inst.sog}
                    testId="hud-sog"
                    sentence={`Speed over ground ${fmtKnots(inst.sog)} knots`}
                />
                <Cell
                    label="COG"
                    value={fmtBearing(cogMetric)}
                    metric={cogMetric}
                    testId="hud-cog"
                    sentence={cogSentence}
                />
                <Cell
                    label="TWS"
                    value={fmtKnots(inst.tws)}
                    unit="kn"
                    metric={inst.tws}
                    testId="hud-tws"
                    sentence={`True wind speed ${fmtKnots(inst.tws)} knots`}
                />
                <Cell
                    label="TWD"
                    value={fmtBearing(inst.twd)}
                    metric={inst.twd}
                    testId="hud-twd"
                    sentence={`True wind from ${fmtBearing(inst.twd)} true`}
                />
                <Cell
                    label="AWS"
                    value={fmtKnots(inst.aws)}
                    unit="kn"
                    metric={inst.aws}
                    testId="hud-aws"
                    sentence={`Apparent wind speed ${fmtKnots(inst.aws)} knots`}
                />
                <Cell
                    label="AWA"
                    value={fmtRelative(inst.awa)}
                    metric={inst.awa}
                    testId="hud-awa"
                    sentence={`Apparent wind angle ${fmtRelative(inst.awa)}, P is port, S is starboard`}
                />

                <p
                    className={`px-1 pt-1 text-center text-[10px] font-black uppercase leading-tight ${
                        inst.via === 'cloud' || !anyValue ? 'text-amber-300' : 'text-gray-400'
                    }`}
                    data-testid="hud-lane"
                    title={laneSentence(inst.via, connected, anyValue)}
                    aria-label={laneSentence(inst.via, connected, anyValue)}
                >
                    {laneTag(inst.via, connected, anyValue)}
                </p>
                {gpsTag && (
                    <p
                        className={`px-1 pb-1 text-center text-[10px] font-black uppercase leading-tight ${
                            gpsTag === 'GPS LIVE' || gpsTag === 'EXT GPS LIVE' ? 'text-gray-400' : 'text-amber-300'
                        }`}
                        data-testid="hud-gps"
                        title={`${receiver.label} · ${receiver.detail}`}
                        aria-label={`${receiver.label} · ${receiver.detail}`}
                    >
                        {gpsTag}
                    </p>
                )}
            </div>

            <div className="flex shrink-0 border-t border-white/10">
                {/* Route & track: the same ON the layer button performs. OFF lives
                    there, because only MapHub's own path clears what it drew. */}
                <button
                    type="button"
                    data-testid="hud-show-passage"
                    disabled={!(following || voyageActive) || overlayOn}
                    aria-pressed={overlayOn}
                    aria-label={
                        overlayOn
                            ? 'Route and track are on the chart. Turn them off with Passage in the layer button.'
                            : following || voyageActive
                              ? 'Show route and track on the chart'
                              : 'Show route and track on the chart — cast off or follow a route first'
                    }
                    title={
                        overlayOn ? 'On the chart — turn off with Passage in the layer button' : 'Show route & track'
                    }
                    onClick={() => {
                        void triggerHaptic('light');
                        setPassageOverlay(true);
                    }}
                    className="flex h-11 w-1/2 items-center justify-center border-r border-white/10 active:scale-95 disabled:active:scale-100"
                >
                    <svg
                        className={`h-5 w-5 ${
                            overlayOn ? 'text-sky-300' : following || voyageActive ? 'text-white' : 'text-white/40'
                        }`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.2}
                    >
                        <circle cx="6" cy="18" r="2.2" />
                        <circle cx="18" cy="6" r="2.2" />
                        <path strokeLinecap="round" strokeDasharray="3 3" d="M8 17c4-1 3-8 8-10" />
                    </svg>
                </button>
                <button
                    type="button"
                    onClick={onToggle}
                    aria-label="Hide passage instruments"
                    aria-expanded
                    data-testid="passage-hud-toggle"
                    className="flex h-11 w-1/2 items-center justify-center active:scale-95"
                >
                    <svg
                        className="h-5 w-5 text-white/70"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
            </div>
        </aside>
    );
};

export const PassageHudPane: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
    const enabled = usePassageHudEnabled();
    const open = usePassageHudOpen();
    const toggle = () => {
        void triggerHaptic('light');
        togglePassageHud();
    };
    if (!enabled) return null;
    // Two components on purpose: the closed tab subscribes to nothing.
    return open ? <OpenPane onToggle={toggle} onBack={onBack} /> : <ClosedTab onToggle={toggle} />;
};
