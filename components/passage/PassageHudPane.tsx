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
 * PHASE 1: the live strip. Distance left ALONG the followed route, then the
 * boat's six numbers, then which lane they came through and what the GPS is
 * doing.
 *
 * PHASE 2 (Shane 2026-09-18, "ok next phase"): LOOK AHEAD. One button turns
 * the strip from LIVE into FORECAST and puts a scrubber in the chart's bottom
 * row. A ghost leaves from where she IS — her reckoned distance along the
 * route, not the route's first point — and runs ahead at the vessel profile's
 * cruising speed, out to arrival or seven days. The strip shows the wind and
 * rain the named model has for the ghost's PLACE at the ghost's MOMENT, the
 * chart's wind field follows the same moment, and a button on the scrubber
 * changes the model for both at once.
 *
 * LIVE AND FORECAST NEVER SHARE A FACE. Live is white under an emerald LIVE;
 * forecast is amber under an amber FCST with the offset beside it, the cells
 * are relabelled (there is no forecast SOG), apparent wind is marked "EST"
 * because it is arithmetic on a forecast and a planned speed, and a moment the
 * model does not reach is a dash and the words PAST FORECAST — never the last
 * hour held. Look-ahead is not remembered: leave the chart, hide the strip or
 * stop following and the next thing on screen is live.
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
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    LOOK_AHEAD_MAX_MS,
    publishPassageGhost,
    publishPassageGhostPath,
    setPassageAheadMs,
    setPassageLookAheadPlaying,
    startPassageLookAhead,
    stopPassageLookAhead,
    togglePassageHud,
    usePassageHudEnabled,
    usePassageHudOpen,
    usePassageLookAhead,
    usePassageRainCoverageHours,
    usePassageSpeedPref,
    usePassageUnsyncedLayers,
    usePassageWindCoverageHours,
} from '../../stores/passageHudStore';
import { usePassageHudInstruments, type HudMetric } from '../../hooks/usePassageHudInstruments';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { setPassageOverlay, usePassageOverlay } from '../../stores/chartPassageOverlay';
import {
    MOTION_MIN_NM,
    buildRouteIndex,
    progressAlongRoute,
    stationOnIndex,
    type RouteProgress,
} from '../../services/routeProgress';
import {
    SPREAD_SOME_DEG,
    SPREAD_SOME_KTS,
    SPREAD_SPLIT_DEG,
    SPREAD_SPLIT_KTS,
    loadRouteSpread,
    peekRouteSpread,
    sampleRouteSpread,
    type RouteSpread,
    type SpreadLevel,
} from '../../services/routeForecastSpread';
import { planAt, planPassage, pointingDeg, type PassageSpeedModel, type SpeedHow } from '../../services/passagePlan';
import { DEFAULT_CRUISING_POLAR } from '../../services/defaultPolar';
import { closeHauledDegFor } from '../../services/sailing/pointOfSail';
import {
    FORECAST_TTL_MS,
    estimateApparentWind,
    loadRouteForecast,
    peekRouteForecast,
    routeForecastKey,
    sampleRouteForecast,
    type RouteForecast,
} from '../../services/routeForecastSampler';
import { vesselCruisingSpeedKts } from '../../services/units';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindStore } from '../../stores/WindStore';
import { requestMapFit } from '../../stores/MapFitTargetStore';
import { PASSAGE_MODEL_CHOICES, PassageModelModal, passageModelChoice } from './PassageModelModal';
import { RouteTimeScrubber, fmtAhead, fmtMoment, type SpreadBandPoint } from './RouteTimeScrubber';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import { NmeaStore } from '../../services/NmeaStore';
import { LocationStore } from '../../stores/LocationStore';
import { GpsService } from '../../services/GpsService';
import { MobService } from '../../services/MobService';
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

const tone = (m: HudMetric, forecast = false): string =>
    m.value === null
        ? 'text-white/40'
        : forecast
          ? 'text-amber-200'
          : m.freshness === 'stale'
            ? 'text-white/60'
            : 'text-white';

interface CellProps {
    label: string;
    value: string;
    unit?: string;
    metric: HudMetric;
    testId: string;
    sentence: string;
    /** A forecast number: amber, and never carrying a live freshness. */
    forecast?: boolean;
    /** A small second line under the value — the five models' range under TWS. */
    sub?: { text: string; tone: 'quiet' | 'amber' | 'red'; testId: string } | null;
}

const SUB_TONE = { quiet: 'text-gray-400', amber: 'text-amber-300', red: 'text-red-400' } as const;

const Cell: React.FC<CellProps> = ({ label, value, unit, metric, testId, sentence, forecast = false, sub = null }) => (
    <div
        className="border-b border-white/10 px-1 py-0.5 text-center"
        data-testid={testId}
        data-freshness={metric.value === null ? 'none' : forecast ? 'forecast' : metric.freshness}
        title={sentence}
        aria-label={sentence}
    >
        <p
            className={`text-[10px] font-black uppercase leading-none ${forecast ? 'text-amber-300/80' : 'text-gray-400'}`}
        >
            {label}
        </p>
        <p className={`font-mono text-[17px] font-black leading-tight tabular-nums ${tone(metric, forecast)}`}>
            {value}
            {unit && metric.value !== null && <span className="text-[10px] font-bold text-gray-500">{unit}</span>}
        </p>
        {sub && (
            <p
                className={`font-mono text-[10px] font-black leading-none tabular-nums ${SUB_TONE[sub.tone]}`}
                data-testid={sub.testId}
            >
                {sub.text}
            </p>
        )}
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

/** Every model on offer, asked for in ONE request (services/routeForecastSpread). */
const SPREAD_MODEL_IDS = PASSAGE_MODEL_CHOICES.map((c) => c.openMeteoModel);
/** Points across the scrubber's axis at which the five models are compared for its band. */
const SPREAD_BAND_POINTS = 40;

/** How she is making her way, for the 76 px tag and for a screen reader. */
const HOW_TAG: Record<SpeedHow, string> = {
    sail: 'SAIL',
    tack: 'TACK',
    motor: 'MOTOR',
    cruise: 'CRUISE',
    assumed: 'NO WX',
};
const HOW_WORDS: Record<SpeedHow, string> = {
    sail: 'under sail',
    tack: 'tacking to windward',
    motor: 'under engine',
    cruise: 'at her cruising speed',
    assumed: 'at her cruising speed, assumed, because there is no wind forecast for this stretch',
};

/** Narrow read: WindStore changes at scrub rate (its hour); the model does not. */
const currentWindModel = () => WindStore.getState().model;

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
                    // …and to a twentieth of a mile whatever the label rounds to:
                    // past 10 NM the label is whole miles, and the look-ahead's
                    // ghost, which leaves from this figure, sat up to a mile
                    // astern of the boat at NOW.
                    Math.round(prev.progress.alongNm * 20) === Math.round(next.progress.alongNm * 20) &&
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

    // ── Look ahead (phase 2) ──
    const look = usePassageLookAhead();
    const windCoverageHours = usePassageWindCoverageHours();
    const unsyncedLayers = usePassageUnsyncedLayers();
    const vessel = useSettingsStore((st) => st.settings.vessel);
    const cruiseKts = vesselCruisingSpeedKts(vessel, 0);
    // ONE model on the chart: the wind layer's. See PassageModelModal.
    const windModel = useSyncExternalStore(WindStore.subscribe, currentWindModel, currentWindModel);
    const model = passageModelChoice(windModel);
    const [modelOpen, setModelOpen] = useState(false);

    // Leaving the chart, or no longer following, ends the glance.
    useEffect(() => () => stopPassageLookAhead(), []);
    // So does a man overboard, from anywhere it can be raised (this page, the
    // MOB page, the watch). The recovery chart is no place for a ghost hull, a
    // dashed line and a strip of forecasts where the instruments were.
    useEffect(
        () =>
            MobService.subscribe((state) => {
                if (state.active) stopPassageLookAhead();
            }),
        [],
    );
    useEffect(() => {
        if (look.on && !following) stopPassageLookAhead();
    }, [look.on, following]);

    // The strip stands down by CSS for a storm card, the planning surfaces and
    // a landscape phone. It is still mounted then, and a look-ahead left
    // running behind it would keep the chart's own time controls away with
    // nothing on screen to give them back.
    const asideRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (!look.on) return;
        const id = setInterval(() => {
            const el = asideRef.current;
            if (el && typeof getComputedStyle === 'function' && getComputedStyle(el).display === 'none') {
                stopPassageLookAhead();
            }
        }, 1000);
        return () => clearInterval(id);
    }, [look.on]);

    // Labels are clock times; keep the clock moving while they are on screen.
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (!look.on) return;
        setNowMs(Date.now());
        const id = setInterval(() => setNowMs(Date.now()), 30_000);
        return () => clearInterval(id);
    }, [look.on]);

    // The series for THIS route and THIS model. Held with its key, and only
    // ever read back through the key, so a reply for the model or route the
    // skipper has just left cannot be shown under the new one's name.
    const forecastKey = following ? routeForecastKey(routeCoords, model.openMeteoModel) : '';
    const [loaded, setLoaded] = useState<{
        key: string;
        forecast: RouteForecast | null;
        spread: RouteSpread | null;
        failed: boolean;
    } | null>(null);
    useEffect(() => {
        if (!look.on || !following) return;
        let cancelled = false;
        const key = routeForecastKey(routeCoords, model.openMeteoModel);
        const run = () => {
            // PHASE 3: ONE request for all five models. It is a superset of the
            // pinned model's own request — every member is handed to the
            // sampler's cache — so the pinned model usually costs nothing, and
            // changing model in the dialog is instant. If it fails, or the
            // pinned model is not in it, fall back to phase 2's single request:
            // the spread is extra, never a precondition for the headline.
            const cachedSpread = peekRouteSpread(routeCoords, SPREAD_MODEL_IDS);
            const cached = peekRouteForecast(routeCoords, model.openMeteoModel);
            if (cached && cachedSpread) {
                setLoaded({ key, forecast: cached, spread: cachedSpread, failed: false });
                return;
            }
            void (async () => {
                const id = model.openMeteoModel;
                const spread = await loadRouteSpread(routeCoords, SPREAD_MODEL_IDS);
                // loadRouteSpread hands back its STALE bundle while the service
                // is refusing the five-model request. That must not stand in for
                // the headline: after the first hour a spread outage would have
                // become a headline outage (review, 2026-09-19). Go back for the
                // one model, as phase 2 did; the stale member is the last resort.
                const spreadFresh = !!spread && Date.now() - spread.fetchedAt <= FORECAST_TTL_MS;
                const member = spread?.members[id] ?? null;
                const forecast = (spreadFresh ? member : null) ?? (await loadRouteForecast(routeCoords, id)) ?? member;
                // …and never an un-aged old range under a fresher headline: the
                // range is shown only when it is fresh, or exactly as old as the
                // headline (then the "N MIN OLD" note covers both).
                const shownSpread =
                    spread && (spreadFresh || (forecast !== null && spread.fetchedAt >= forecast.fetchedAt))
                        ? spread
                        : null;
                if (!cancelled) setLoaded({ key, forecast, spread: shownSpread, failed: !forecast });
            })();
        };
        run();
        // Cheap to ask: the sampler answers from its cache until the series is
        // an hour old, and after a failure it will not go back to the service
        // for a minute. Two minutes is how long a skipper looking at NO
        // FORECAST waits for the signal to come back — measured the hard way,
        // when the proxy's rate limit answered 429 and the first cut then sat
        // on its dashes for ten.
        const id = setInterval(run, 2 * 60_000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [look.on, following, routeCoords, model.openMeteoModel]);
    const mine = loaded && loaded.key === forecastKey ? loaded : null;
    // While this key's series is still arriving, a CACHED member (the spread
    // request primes all five) is read here, synchronously, so a model change
    // does not pass through a render with no forecast — which walked a flat
    // "assumed" plan, shortened the axis, and let the clamp below drag a parked
    // offset back to the flat-speed arrival for good (review, 2026-09-19).
    const forecast = mine
        ? mine.forecast
        : look.on && following
          ? peekRouteForecast(routeCoords, model.openMeteoModel)
          : null;
    const spread = mine ? mine.spread : look.on && following ? peekRouteSpread(routeCoords, SPREAD_MODEL_IDS) : null;
    /** False only while this route+model's series is still LOADING (offline settles as failed). */
    const forecastSettled = mine !== null;

    // ── THE PLAN (phase 3) ──
    // Phase 2 ran the ghost at one flat speed, so offset → distance was a
    // multiplication done in five places. By the wind it is non-linear and
    // sequential, so it is WALKED ONCE into a table (services/passagePlan) and
    // everything below reads that table: the axis length, the ghost, TO GO, the
    // "AT x KN" tag, the apparent-wind estimate and the screen-reader sentence.
    // The way BACK TO THE LINE is sailed first (`toGoNm` counts it), so LIVE and
    // FCST agree at NOW and a boat abeam of the far end gets an axis, not 0.0.
    const speedPref = usePassageSpeedPref();
    const polarData = useSettingsStore((st) => st.settings.polarData);
    const polarBoatModel = useSettingsStore((st) => st.settings.polarBoatModel);
    const isSail = vessel?.type === 'sail';
    const closeHauledDeg = closeHauledDegFor(vessel);
    const speedModel = useMemo<PassageSpeedModel>(
        () => ({
            mode: speedPref,
            cruiseKts,
            isSail,
            // The skipper's own table when she has chosen one; else the generic
            // cruising polar. NEVER the learned "smart" polar: it loads async,
            // only after the Polars page is opened, and its unfilled cells are
            // literal zeros that interpolate to half speed.
            polar: polarData ?? DEFAULT_CRUISING_POLAR,
            closeHauledDeg,
        }),
        [speedPref, cruiseKts, isSail, polarData, closeHauledDeg],
    );
    const routeIndex = useMemo(() => (following ? buildRouteIndex(routeCoords) : null), [following, routeCoords]);
    const canLookAhead = following && !!fix && cruiseKts > 0;
    const startAlongNm = fix?.progress.alongNm ?? null;
    const backNm = fix ? Math.max(0, fix.progress.toGoNm - fix.progress.remainingNm) : 0;
    // Re-walked when she has moved a twentieth of a mile, the forecast or the
    // speed model changed, or the clock ticked (30 s) — never per scrub tick.
    const plan = useMemo(
        () =>
            look.on && routeIndex && startAlongNm !== null && cruiseKts > 0
                ? planPassage({
                      index: routeIndex,
                      startAlongNm,
                      backNm,
                      startMs: nowMs,
                      forecast,
                      model: speedModel,
                      maxMs: LOOK_AHEAD_MAX_MS,
                  })
                : null,
        [look.on, routeIndex, startAlongNm, backNm, nowMs, forecast, speedModel, cruiseKts],
    );
    const arrivalMs = plan?.arrivalMs ?? null;
    const liveMaxMs = plan ? plan.endMs : 0;
    // A lost fix makes the END of the axis unknown — not the skipper's offset.
    // The chart's wind is still standing at look.aheadMs; collapsing the axis to
    // zero had the strip and scrubber reading NOW over a field parked at +6 h.
    // …and so does a series that is still LOADING with nothing cached to read:
    // the plan walked meanwhile is the flat "assumed" one, and its shorter axis
    // is not the truth about anything. Hold the last settled axis until it lands.
    const lastMaxRef = useRef(0);
    const axisKnown = !!plan && (forecastSettled || forecast !== null || lastMaxRef.current === 0);
    if (axisKnown) lastMaxRef.current = liveMaxMs;
    const maxMs = axisKnown ? liveMaxMs : lastMaxRef.current;
    const aheadMs = Math.min(look.aheadMs, maxMs);
    const moment = plan ? planAt(plan, aheadMs) : null;
    const planToGoNm = moment?.toGoNm ?? 0;
    const planKts = moment?.kts ?? cruiseKts;
    const planBoatKts = moment?.boatKts ?? cruiseKts;
    const planHow: SpeedHow = moment?.how ?? 'cruise';
    const planArrived = moment?.arrived ?? false;
    // She advances, the axis shortens: never leave the offset past its end. NOT
    // while the series is loading — see above. And a skipper PARKED AT THE END
    // stays at the end: the plan is re-walked every 30 s and its arrival moves
    // by seconds each time, which un-arrived her and left Play with nothing to
    // do (review, 2026-09-19).
    // "Parked at the end" is decided when the OFFSET moves, against the axis as
    // it then is — not inferred afterwards from how the axis changed. (The first
    // cut compared against the previous axis length, and the jump from the flat
    // plan to the by-the-wind one made every later offset look like "the end".)
    const maxMsRef = useRef(maxMs);
    maxMsRef.current = maxMs;
    const parkedAtEndRef = useRef(false);
    useEffect(() => {
        parkedAtEndRef.current = look.on && maxMsRef.current > 0 && look.aheadMs >= maxMsRef.current - 1000;
    }, [look.on, look.aheadMs]);
    useEffect(() => {
        if (!look.on || !plan || !axisKnown) return;
        if (look.aheadMs > maxMs || (parkedAtEndRef.current && look.aheadMs !== maxMs)) {
            setPassageAheadMs(maxMs, maxMs);
        }
    }, [look.on, look.aheadMs, maxMs, plan, axisKnown]);

    // THE GHOST LEAVES FROM WHERE SHE IS (Shane 2026-09-18), not the route's
    // first point — and holds abeam on the line while the way back is sailed.
    const station = look.on && routeIndex && moment ? stationOnIndex(routeIndex, moment.alongNm) : null;
    const ghostLabel = fmtAhead(aheadMs);
    const ghostLat = station?.lat ?? null;
    const ghostLon = station?.lon ?? null;
    const ghostBearing = station?.bearingDeg ?? null;
    useEffect(() => {
        publishPassageGhost(
            ghostLat !== null && ghostLon !== null && ghostBearing !== null
                ? { lat: ghostLat, lon: ghostLon, bearingDeg: ghostBearing, label: ghostLabel }
                : null,
        );
    }, [ghostLat, ghostLon, ghostBearing, ghostLabel]);

    // …and the line she rides: from abeam of the boat to the destination. The
    // Obs chart draws no followed-route line of its own, so this is the only
    // one there is for a skipper who has not cast off a named voyage.
    const abeamLat = fix?.progress.abeam.lat ?? null;
    const abeamLon = fix?.progress.abeam.lon ?? null;
    const abeamLeg = fix?.progress.legIndex ?? null;
    useEffect(() => {
        publishPassageGhostPath(
            look.on && abeamLat !== null && abeamLon !== null && abeamLeg !== null
                ? [{ lat: abeamLat, lon: abeamLon }, ...routeCoords.slice(abeamLeg + 1)]
                : null,
        );
    }, [look.on, abeamLat, abeamLon, abeamLeg, routeCoords]);

    const sample = station ? sampleRouteForecast(forecast, station.alongNm, nowMs + aheadMs) : null;
    // Tacking, she is close-hauled either side of the wind — not steering the
    // route's bearing — and sailing faster than she is getting anywhere. The
    // estimate is worked on THAT heading at her speed through the water, and no
    // side is claimed (it alternates). Arrived, she has stopped: no estimate.
    const tackingNow = planHow === 'tack' && !planArrived;
    const apparent =
        !sample || !station || planArrived
            ? null
            : tackingNow && sample.twdDeg !== null
              ? estimateApparentWind(sample.twsKts, sample.twdDeg, planBoatKts, sample.twdDeg - pointingDeg(speedModel))
              : estimateApparentWind(sample.twsKts, sample.twdDeg, planKts, station.bearingDeg);
    // The five models at the ghost's place and moment — the range AROUND the
    // pinned model's number, never instead of it (one model on the chart).
    const spreadNow = station ? sampleRouteSpread(spread, station.alongNm, nowMs + aheadMs) : null;
    const spreadWords =
        !spreadNow || spreadNow.level === 'none'
            ? null
            : spreadNow.level === 'split'
              ? 'the models disagree'
              : spreadNow.level === 'some'
                ? 'some divergence between the models'
                : 'the models agree';
    // The band the scrubber draws: the five models' range ALONG HER PLAN — at
    // each moment, at the place the plan has her at that moment. Per plan, not
    // per scrub tick.
    const spreadBand = useMemo<SpreadBandPoint[] | null>(() => {
        if (!plan || !spread || !routeIndex || plan.endMs <= 0) return null;
        const out: SpreadBandPoint[] = [];
        const step = plan.endMs / SPREAD_BAND_POINTS;
        const rank: SpreadLevel[] = ['none', 'agree', 'some', 'split'];
        for (let i = 0; i <= SPREAD_BAND_POINTS; i++) {
            const offset = step * i;
            const at = planAt(plan, offset);
            if (!at) continue;
            const s = sampleRouteSpread(spread, at.alongNm, nowMs + offset);
            const pinned = sampleRouteForecast(forecast, at.alongNm, nowMs + offset).twsKts;
            // One band point stands for up to 4.2 h of a seven-day axis, and the
            // data is hourly: a split that lasts two hours between two points
            // must not vanish from the overview. Shape is the point's own value;
            // LEVEL is the worst found anywhere in its interval.
            let level = s.level;
            const from = Math.max(0, offset - step / 2);
            const to = Math.min(plan.endMs, offset + step / 2);
            for (let t = from; t <= to && step > 3_600_000; t += 3_600_000) {
                const there = planAt(plan, t);
                if (!there) continue;
                const l = sampleRouteSpread(spread, there.alongNm, nowMs + t).level;
                if (rank.indexOf(l) > rank.indexOf(level)) level = l;
            }
            out.push({ f: i / SPREAD_BAND_POINTS, minKts: s.minKts, maxKts: s.maxKts, pinnedKts: pinned, level });
        }
        return out.some((p) => p.minKts !== null) ? out : null;
    }, [plan, spread, routeIndex, forecast, nowMs]);
    // Whoever's numbers are on screen is credited — every one of them.
    const spreadProviders = useMemo(() => {
        if (!spread) return null;
        const names = PASSAGE_MODEL_CHOICES.filter((c) => spread.members[c.openMeteoModel]).map((c) => c.provider);
        return [...new Set(names)];
    }, [spread]);
    const rainCoverageHours = usePassageRainCoverageHours();

    const fc = (value: number | null | undefined): HudMetric => ({
        value: value === null || value === undefined ? null : Math.round(value * 10) / 10,
        freshness: 'live',
    });
    // A refetch that fails keeps the old series — an aged forecast is worth
    // having offshore — but it must WEAR its age: the first cut showed Monday
    // evening's run on Tuesday morning as though it were this hour's. The grace
    // covers one refresh round, so a healthy hourly refetch never flashes it.
    const forecastAgeMs = forecast ? Math.max(0, nowMs - forecast.fetchedAt) : 0;
    const forecastOld = forecastAgeMs > FORECAST_TTL_MS + 5 * 60_000;
    const forecastAgeTag =
        forecastAgeMs < 2 * 3_600_000
            ? `${Math.round(forecastAgeMs / 60_000)} MIN OLD`
            : `${Math.floor(forecastAgeMs / 3_600_000)} H OLD`;
    const forecastNote = !look.on
        ? null
        : !fix
          ? 'NO FIX'
          : !mine
            ? 'LOADING'
            : mine.failed || !forecast
              ? 'NO FORECAST'
              : sample?.beyond
                ? 'PAST FORECAST'
                : forecastOld
                  ? forecastAgeTag
                  : null;
    // "Where models disagree, say so." Its own line, so it never hides the age
    // of a stale run or is hidden by it.
    const modelsSplit = look.on && !!sample && !sample.beyond && spreadNow?.level === 'split';

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

    // ONCE, on the way in: put the rest of the passage on screen. Measured on
    // the real chart — at harbour zoom the ghost was off the glass within the
    // first hour of scrubbing, which is a scrubber moving nothing anyone can
    // see. Never again after that: the skipper's own pan and zoom win.
    const frameRemainingRoute = () => {
        if (!fix) return;
        const ahead = [fix.progress.abeam, ...routeCoords.slice(fix.progress.legIndex + 1)];
        const lats = ahead.map((p) => p.lat);
        const lons = ahead.map((p) => p.lon);
        const bbox: [number, number, number, number] = [
            Math.min(...lons),
            Math.min(...lats),
            Math.max(...lons),
            Math.max(...lats),
        ];
        // A span past 180° is a route over the antimeridian, where a min/max
        // box means "the whole planet". Leave the camera alone.
        if (!bbox.every(Number.isFinite) || bbox[2] - bbox[0] > 180) return;
        requestMapFit({ bbox, paddingPx: 96, maxZoom: 11 });
    };

    const forecastRouteSentence =
        !station || !fix
            ? 'Looking ahead: no position to start from'
            : `At ${fmtMoment(nowMs + aheadMs)}, ${fmtAhead(aheadMs)}, making ${planKts.toFixed(
                  1,
              )} knots along ${routeName}: ${fmtNm(planToGoNm)} nautical miles to go, ${planArrived ? 'arrived' : HOW_WORDS[planHow]}${''}. A plan, not a measurement.`;

    const cogSentence =
        inst.sog.value !== null && !makingWay
            ? 'Course over ground: not making way, no course to show'
            : `Course over ground ${fmtBearing(cogMetric)} true`;

    return (
        <>
            <aside
                ref={asideRef}
                aria-label={look.on ? 'Passage forecast, looking ahead along the route' : 'Passage instruments'}
                data-testid="passage-hud"
                data-mode={look.on ? 'forecast' : 'live'}
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
                {look.on ? (
                    <p
                        className="shrink-0 border-b border-amber-300/30 bg-amber-300/10 py-1 text-center text-[10px] font-black uppercase leading-tight tracking-widest text-amber-300"
                        data-testid="hud-mode"
                        role="status"
                    >
                        Fcst
                        <span className="block font-mono tracking-normal text-amber-200">{ghostLabel}</span>
                    </p>
                ) : (
                    <p
                        className="shrink-0 border-b border-white/10 py-1 text-center text-[10px] font-black uppercase leading-none tracking-widest text-emerald-300"
                        data-testid="hud-mode"
                    >
                        Live
                    </p>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {look.on ? (
                        <>
                            {/* FORECAST. Nothing in this branch is an instrument. */}
                            <div
                                className="border-b border-white/10 px-1 py-1 text-center"
                                data-testid="hud-route"
                                title={forecastRouteSentence}
                                aria-label={forecastRouteSentence}
                            >
                                <p className="text-[10px] font-black uppercase leading-none text-amber-300/80">To go</p>
                                <p
                                    className={`font-mono text-[19px] font-black leading-tight tabular-nums ${
                                        station ? 'text-amber-200' : 'text-white/40'
                                    }`}
                                >
                                    {station && fix ? fmtNm(planToGoNm) : DASH}
                                    {station && <span className="text-[10px] font-bold text-gray-500">NM</span>}
                                </p>
                                <p className="text-[10px] font-black uppercase leading-none text-gray-400">
                                    {planArrived ? 'ARRIVED' : `${planKts.toFixed(1)}KN ${HOW_TAG[planHow]}`}
                                </p>
                            </div>
                            <Cell
                                forecast
                                label="TWS"
                                value={fmtKnots(fc(sample?.twsKts))}
                                unit="kn"
                                metric={fc(sample?.twsKts)}
                                testId="hud-tws"
                                sentence={`Forecast true wind speed ${fmtKnots(fc(sample?.twsKts))} knots, ${model.label}${
                                    spreadNow && spreadNow.minKts !== null && spreadNow.maxKts !== null
                                        ? `. ${spreadNow.members.length} of ${spreadNow.of} models say ${Math.floor(
                                              spreadNow.minKts,
                                          )} to ${Math.ceil(spreadNow.maxKts)} knots — ${spreadWords}`
                                        : ''
                                }`}
                                // THE RANGE AROUND IT. The headline stays the chart's
                                // one named model; this is what the others say, and
                                // how many of them said it.
                                sub={
                                    spreadNow && spreadNow.minKts !== null && spreadNow.maxKts !== null
                                        ? {
                                              // Rounded OUTWARD, so the range always holds the
                                              // headline above it ("6–9" under 9.4 read as though
                                              // the pinned model were outside the models). The
                                              // count shows only when someone did not answer —
                                              // that is when it matters.
                                              text: `${Math.floor(spreadNow.minKts)}–${Math.ceil(spreadNow.maxKts)}${
                                                  spreadNow.members.length < spreadNow.of
                                                      ? ` ${spreadNow.members.length}/${spreadNow.of}`
                                                      : ''
                                              }`,
                                              // Coloured by the SPEED range alone. A split
                                              // that is all about direction used to paint
                                              // "18–18" red — a range with nothing wrong in
                                              // it. That disagreement is named on TWD.
                                              tone:
                                                  (spreadNow.spreadKts ?? 0) >= SPREAD_SPLIT_KTS
                                                      ? 'red'
                                                      : (spreadNow.spreadKts ?? 0) >= SPREAD_SOME_KTS
                                                        ? 'amber'
                                                        : 'quiet',
                                              testId: 'hud-tws-spread',
                                          }
                                        : null
                                }
                            />
                            <Cell
                                forecast
                                label="Gust"
                                value={model.noGust ? 'N/A' : fmtKnots(fc(sample?.gustKts))}
                                unit={model.noGust ? undefined : 'kn'}
                                metric={model.noGust ? fc(null) : fc(sample?.gustKts)}
                                testId="hud-gust"
                                sentence={
                                    model.noGust
                                        ? `${model.label} does not publish a gust forecast`
                                        : `Forecast gust ${fmtKnots(fc(sample?.gustKts))} knots, ${model.label}`
                                }
                            />
                            <Cell
                                forecast
                                label="TWD"
                                value={fmtBearing(fc(sample?.twdDeg))}
                                metric={fc(sample?.twdDeg)}
                                testId="hud-twd"
                                sentence={`Forecast true wind from ${fmtBearing(fc(sample?.twdDeg))} true, ${model.label}${
                                    spreadNow && spreadNow.dirSpreadDeg !== null
                                        ? `. The models are ${Math.round(spreadNow.dirSpreadDeg)} degrees apart on direction`
                                        : ''
                                }`}
                                // Only when it is news: the line costs height.
                                sub={
                                    spreadNow &&
                                    spreadNow.dirSpreadDeg !== null &&
                                    spreadNow.dirSpreadDeg >= SPREAD_SOME_DEG
                                        ? {
                                              text: `${Math.round(spreadNow.dirSpreadDeg)}° apart`,
                                              tone: spreadNow.dirSpreadDeg >= SPREAD_SPLIT_DEG ? 'red' : 'amber',
                                              testId: 'hud-twd-spread',
                                          }
                                        : null
                                }
                            />
                            <Cell
                                forecast
                                label="AWS est"
                                value={fmtKnots(fc(apparent?.awsKts))}
                                unit="kn"
                                metric={fc(apparent?.awsKts)}
                                testId="hud-aws"
                                sentence={`Estimated apparent wind speed ${fmtKnots(
                                    fc(apparent?.awsKts),
                                )} knots — worked from the forecast and her planned speed, not measured`}
                            />
                            <Cell
                                forecast
                                label="AWA est"
                                // Tacking, the side alternates and is not knowable:
                                // the angle, and no P or S.
                                value={
                                    tackingNow && apparent
                                        ? `${Math.round(Math.abs(apparent.awaDeg))}°`
                                        : fmtRelative(fc(apparent?.awaDeg))
                                }
                                metric={fc(apparent?.awaDeg)}
                                testId="hud-awa"
                                sentence={
                                    tackingNow && apparent
                                        ? `Estimated apparent wind angle ${Math.round(
                                              Math.abs(apparent.awaDeg),
                                          )} degrees, close-hauled on either tack — worked from the forecast, not measured`
                                        : `Estimated apparent wind angle ${fmtRelative(
                                              fc(apparent?.awaDeg),
                                          )}, P is port, S is starboard — worked from the forecast, not measured`
                                }
                            />
                            <Cell
                                forecast
                                // The chance rides in the label: a line of its own
                                // cost the height that put the last cell below
                                // the fold on a phone paying both insets.
                                label={
                                    sample && sample.precipProb !== null
                                        ? `Rain ${Math.round(sample.precipProb)}%`
                                        : 'Rain'
                                }
                                value={
                                    sample?.precipMm === null || sample?.precipMm === undefined
                                        ? DASH
                                        : sample.precipMm.toFixed(1)
                                }
                                unit="mm"
                                metric={fc(sample?.precipMm)}
                                testId="hud-rain"
                                sentence={
                                    sample?.precipMm === null || sample?.precipMm === undefined
                                        ? 'No rain forecast for that moment'
                                        : `Forecast rain ${sample.precipMm.toFixed(1)} millimetres in the hour${
                                              sample.precipProb === null
                                                  ? ''
                                                  : `, ${Math.round(sample.precipProb)} percent chance`
                                          }, ${model.label}`
                                }
                            />
                            {/* The MODEL is named on the scrubber, which is on
                                screen for exactly as long as these numbers are —
                                on its change-model button and in its credit. */}
                        </>
                    ) : (
                        <>
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
                                        !fix
                                            ? 'text-white/40'
                                            : fix.source === 'phone-old'
                                              ? 'text-white/60'
                                              : 'text-white'
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
                                        gpsTag === 'GPS LIVE' || gpsTag === 'EXT GPS LIVE'
                                            ? 'text-gray-400'
                                            : 'text-amber-300'
                                    }`}
                                    data-testid="hud-gps"
                                    title={`${receiver.label} · ${receiver.detail}`}
                                    aria-label={`${receiver.label} · ${receiver.detail}`}
                                >
                                    {gpsTag}
                                </p>
                            )}
                        </>
                    )}
                </div>

                {/* THE WARNINGS STAND OUTSIDE THE SCROLLER. On a 393x852 phone paying both
                insets the forecast cells can run a few pixels past the fold, and what
                was below it was MODELS SPLIT and the age of a stale run — the two
                lines that change what the numbers above them mean (review,
                2026-09-19). Whatever overflows now is a cell, and the clipped cell is
                its own cue to scroll. */}
                {look.on && (modelsSplit || forecastNote) && (
                    <div className="shrink-0 border-t border-white/10">
                        {modelsSplit && (
                            <p
                                className="px-1 py-1 text-center text-[10px] font-black uppercase leading-none text-red-400"
                                data-testid="hud-models-split"
                                role="status"
                            >
                                MODELS SPLIT
                            </p>
                        )}
                        {forecastNote && (
                            <p
                                className="px-1 py-1 text-center text-[10px] font-black uppercase leading-tight text-amber-300"
                                data-testid="hud-forecast-note"
                                role="status"
                            >
                                {forecastNote}
                            </p>
                        )}
                    </div>
                )}

                {/* LOOK AHEAD / back to LIVE. Entering draws the route too — the
                same explicit ON as the button below: a ghost with no line to
                ride is a boat adrift on the chart. OFF still lives in the
                layer button. */}
                <button
                    type="button"
                    data-testid="hud-look-ahead"
                    disabled={!look.on && !canLookAhead}
                    aria-pressed={look.on}
                    aria-label={
                        look.on
                            ? 'Back to live instruments'
                            : canLookAhead
                              ? 'Look ahead along the route'
                              : !following
                                ? 'Look ahead along the route — follow a route first'
                                : cruiseKts > 0
                                  ? 'Look ahead along the route — waiting for a position'
                                  : 'Look ahead along the route — set a cruising speed in Settings, Vessel'
                    }
                    onClick={() => {
                        void triggerHaptic('light');
                        if (look.on) {
                            stopPassageLookAhead();
                            return;
                        }
                        setPassageOverlay(true);
                        startPassageLookAhead();
                        frameRemainingRoute();
                    }}
                    className={`flex h-10 shrink-0 items-center justify-center gap-1 border-t border-white/10 text-[11px] font-black uppercase tracking-wide active:scale-95 disabled:active:scale-100 ${
                        look.on ? 'text-emerald-300' : canLookAhead ? 'text-amber-300' : 'text-white/40'
                    }`}
                >
                    {look.on ? 'Live' : 'Ahead'}
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5}>
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d={look.on ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
                        />
                    </svg>
                </button>

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
                            overlayOn
                                ? 'On the chart — turn off with Passage in the layer button'
                                : 'Show route & track'
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
            {look.on && (
                <RouteTimeScrubber
                    aheadMs={aheadMs}
                    maxMs={maxMs}
                    endsAtArrival={arrivalMs !== null}
                    arrivalEstimated={speedModel.mode === 'polar' && speedModel.isSail}
                    assumedFromMs={plan?.assumedFromMs ?? null}
                    spreadBand={spreadBand}
                    spreadProviders={spreadProviders}
                    rainCoverageHours={rainCoverageHours}
                    playing={look.playing}
                    nowMs={nowMs}
                    windCoverageHours={windCoverageHours}
                    unsyncedLayers={unsyncedLayers}
                    modelLabel={model.label}
                    modelProvider={model.provider}
                    cruiseKts={cruiseKts}
                    onAhead={(ms) => setPassageAheadMs(ms, maxMs)}
                    onPlaying={setPassageLookAheadPlaying}
                    onOpenModel={() => setModelOpen(true)}
                />
            )}
            <PassageModelModal
                visible={modelOpen}
                onClose={() => setModelOpen(false)}
                cruiseKts={cruiseKts}
                isSail={isSail}
                polarName={polarData ? (polarBoatModel ?? 'Your') : null}
            />
        </>
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
