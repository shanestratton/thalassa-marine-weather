/**
 * MoveAnchorSheet — "Anchor is [33] m from the boat, bearing [212] °T".
 *
 * Build 123, must-do #3. The anchor watch is armed wherever the GPS is at that
 * moment, which is usually the BOAT, a rode-length from the hook, and the only
 * cure used to be weighing anchor and arming again. This sheet moves the centre
 * of the watch THIS phone keeps to where the anchor really is, described the
 * way a skipper knows it: how far from the boat, and which way.
 *
 *  - Distance is prefilled with where the boat lies as the swing circle
 *    reckons it: the rode's horizontal reach, √(rode² − depth²), less its sag
 *    (lyingDistanceM), so it opens inside the circle even for a long chain in
 *    deep water. In the skipper's own length unit (metres or feet, from
 *    Settings), never assumed metres. When her fix is the boat's own GPS (the
 *    instruments, or the Pi), it adds the antenna's distance from the bow
 *    (Settings → Vessel → Dimensions, 126-07c) and says so, but never more
 *    than the watch's own circle allows for, so it still opens inside it.
 *  - Bearing is prefilled from the boat's TRUE heading only while it is under
 *    10 s old, and the sheet says where it came from and how old it is, live.
 *    A boat at anchor lies head to the rode, so her heading points at the
 *    hook. Until the skipper types a bearing the prefill keeps up with the
 *    heading as she swings (the point stays put: boat and heading move
 *    together), and once the heading is more than 10 s old it is not used.
 *    Degrees true only, labelled as such: there is no magnetic model yet.
 *  - The boat's fix must be fresh too (ANCHOR_RELOCATE_FIX_MAX_AGE_MS), as the
 *    watch itself requires: the sheet waits for one rather than offer a Move
 *    the watch would refuse.
 *  - A live line says, before anything moves, where the boat would sit in the
 *    swing circle around the new point. Outside it, the move is refused here
 *    and again by the watch itself (AnchorWatchService.relocateAnchor), which
 *    is the authority.
 *  - The preview radar centres on the new anchor, so the boat is seen against
 *    the circle it would have.
 *  - The point comes from destinationPoint, which wraps at 180°.
 *
 * House rules: a CENTRED modal, clear of the tab bar, that lifts above the
 * keyboard with .thalassa-keyboard-safe-sheet (KeyboardResize.None overlays the
 * keyboard on the WebView, so a card with fields must lift itself). The fields
 * sit in a pinned footer under the preview, which is the one thing that gives
 * up space; with the keyboard up the heading, the notes and (on a short phone)
 * the preview step aside, and in landscape the card widens so the sentence is
 * one line. At ordinary text the fields, the check and both buttons fit one
 * screen at 320 px, at 390 px and in landscape, keyboard up or down, in wide
 * fonts. At large text on a small phone the card scrolls inside itself as a
 * last resort, so nothing is ever clipped out of reach.
 * browser-tests/move-anchor-layout.spec.ts measures it.
 *
 * Alarm mode (build 125, 125-03), opened from the alarm screen: the same
 * fields, plus "Only move it if you're sure the anchor hasn't moved", a live
 * verdict on her swing track (AnchorWatchService.checkMoveFromAlarm, judged by
 * services/anchorLateSet.ts: a late set or a drag?) and a "Move and stop
 * alarm" button that goes through AnchorWatchService.relocateAnchorFromAlarm,
 * which judges her track again and is the authority. It sits on the critical layer, over the alarm. It never
 * says the app can always tell a late set from a drag.
 *
 * Pi mode (build 126, 126-07a), opened from Shore Watch on the phone that
 * handed its watch to the boat's Pi: the same fields, preview and units, filled
 * from what the Pi reports (her fix, the circle, the rode). The live check is
 * the Pi's (services/anchorPiMove.ts judgePiMove: a fresh fix, no alarm, the
 * boat inside the new circle, and the new point within the rode's reach of
 * where the Pi's watch was first set). Move hands the point to `onPiMove`,
 * which the page wires to the keeper; then the line says "Sent to the Pi…",
 * and "Moved. The Pi is watching the new point." only once the Pi's own report
 * shows it (up to 30 s, then it says it has not shown it yet). A refusal says
 * the Pi is still watching the old point; no answer says it is watching one or
 * the other and Shore Watch will show which. From ashore it adds 125-03's "Only
 * move it if you're sure the anchor hasn't moved".
 *
 * The Pi keeps its own watch with its own keeper; this sheet never touches it.
 * In pi mode it is handed a function to call, and never names the keeper.
 *
 * Position (build 126, 126-07b), in every mode: a second way to say where the
 * anchor is, beside "From the boat". One field takes a position the way a
 * skipper copies it from the plotter, a guide or a text message (decimal
 * degrees, degrees and minutes, or degrees, minutes and seconds; N/S and E/W
 * before or after, or a minus for decimal degrees; a decimal comma:
 * utils/anchorPosition.ts), and a line under it reads it back ("Reads as
 * 16°46.800′S 179°20.100′E"), so a wrong hemisphere shows before anything
 * moves. Or the skipper drags the anchor on the preview: the live line follows
 * the finger, the view stays where it was when the finger went down (the
 * centre the drag measures from), and letting go fills Position with that
 * point, which is then exactly what Move sends (to 0.001′, about 2 m).
 * Nothing moves until Move. Every check above applies whichever way the
 * point was given: the same plan, the same live check, the same service or
 * keeper. The heading only matters to From the boat. The two tabs sit under
 * the title, or in its row on a short screen (where a small phone's title
 * gives them its place, still naming the dialog), and step aside with it
 * while the keyboard is up: the choice is made before typing.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
    ANCHOR_RELOCATE_FIX_MAX_AGE_MS,
    AnchorWatchService,
    type AnchorWatchConfig,
    type AnchorWatchSnapshot,
} from '../../services/AnchorWatchService';
import {
    judgePiMove,
    piAnchorMatches,
    PI_MOVE_LINES,
    PI_MOVE_REFUSAL_WORDS,
    type LatLonPoint,
    type PiBoatFix,
    type PiMoveResult,
} from '../../services/anchorPiMove';
import { NmeaStore } from '../../services/NmeaStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { calculateBearing, calculateDistance, destinationPoint } from '../../utils/navigationCalculations';
import { formatDmm, parseAnchorPosition } from '../../utils/anchorPosition';
import { freshTrueHeading, HEADING_PREFILL_MAX_AGE_MS, type HeadingReading } from '../../utils/trueHeading';
import { gpsToBowMetres } from '../../utils/gpsAntenna';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { Button } from '../ui/Button';
import { XIcon } from '../Icons';
import { SwingCircleCanvas, type SwingCanvasModel } from './SwingCircleCanvas';
import type { AnchorDragHandlers } from './anchorDrag';
import { bearingToCardinal } from './anchorUtils';

// The heading rule is shared with the watch itself (126-07c): utils/trueHeading.ts.
export { freshTrueHeading, HEADING_PREFILL_MAX_AGE_MS };
/** How long "Sent to the Pi…" waits for the Pi's report to show the new point. */
const PI_REPORT_WAIT_MS = 30_000;
/**
 * The safety margin the app arms a watch with (AnchorWatchService's default),
 * for the lying distance of a Pi watch: its assignment carries the circle, the
 * rode and the depth, but not the margin.
 */
const ARMING_MARGIN_M = 10;
const METRES_PER_FOOT = 0.3048;
const METRES_PER_NM = 1852;

type LengthUnit = 'm' | 'ft';
type LatLon = { latitude: number; longitude: number };
/** Where the anchor is said to be: measured from the boat, or as a position (126-07b). */
type How = 'boat' | 'position';
/** How a position is typed, without a degree sign (the iOS keyboard hides it). */
const POSITION_EXAMPLE = '16 46.8 S 179 20.1 E';

const fromMetres = (metres: number, unit: LengthUnit) => (unit === 'ft' ? metres / METRES_PER_FOOT : metres);
const toMetres = (value: number, unit: LengthUnit) => (unit === 'ft' ? value * METRES_PER_FOOT : value);
const say = (metres: number, unit: LengthUnit, digits = 0) => `${fromMetres(metres, unit).toFixed(digits)} ${unit}`;
/** Two lengths that round alike get a decimal, so "43 m … outside your 43 m circle" cannot happen. */
const sayPair = (a: number, b: number, unit: LengthUnit): [string, string] => {
    const digits = Math.round(fromMetres(a, unit)) === Math.round(fromMetres(b, unit)) ? 1 : 0;
    return [say(a, unit, digits), say(b, unit, digits)];
};

/** The rode's horizontal reach, √(rode² − depth²), in metres. */
function horizontalScopeM(config: Pick<AnchorWatchConfig, 'rodeLength' | 'waterDepth'>): number {
    return Math.sqrt(Math.max(0, config.rodeLength ** 2 - config.waterDepth ** 2));
}

/**
 * Where the boat lies from the anchor as the swing circle reckons it, in
 * metres: the reach less the rode's sag. The circle is that plus the safety
 * margin and any GPS antenna allowance (AnchorWatchService), so this is the
 * circle less both, and it always opens inside the circle: the full reach does
 * not, for a long chain in deep water (80 m in 12 m: a 79 m reach, a 77 m
 * circle). Never more than the full reach, for a short rode whose circle is
 * held up by the 20 m floor.
 */
export function lyingDistanceM(
    config: Pick<AnchorWatchConfig, 'rodeLength' | 'waterDepth' | 'safetyMargin' | 'antennaAllowanceM'>,
    swingRadiusM: number,
): number {
    const reach = horizontalScopeM(config);
    const lying = swingRadiusM - config.safetyMargin - (config.antennaAllowanceM ?? 0);
    return Number.isFinite(lying) && lying > 0 ? Math.min(reach, lying) : reach;
}

const sameReading = (a: HeadingReading | null, b: HeadingReading) =>
    !!a && a.deg === b.deg && a.at === b.at && a.via === b.via;

/** A typed number, with a decimal comma as readily as a point. */
function parseEntry(text: string): number | null {
    const cleaned = text.trim().replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
}

export interface AnchorMovePlan {
    /** The new anchor, longitude wrapped into ±180°. */
    target: { lat: number; lon: number };
    /** Boat to the new anchor, measured back (metres). */
    boatToAnchorM: number;
    /** Whether the boat would be inside the swing circle around it. */
    inside: boolean;
    /** How far the anchor moves from where the watch has it now (metres). */
    movesM: number | null;
    /** Which way it moves (°T), when it moves at all. */
    movesTowardDeg: number | null;
}

/** What putting the anchor at `point` (typed, or dragged on the preview) would mean. */
export function planFromPoint(
    boat: LatLon,
    anchorNow: LatLon | null,
    point: LatLon,
    swingRadiusM: number,
): AnchorMovePlan {
    const lon = point.longitude;
    const target = { lat: point.latitude, lon: Math.abs(lon) <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180 };
    const boatToAnchorM = calculateDistance(boat.latitude, boat.longitude, target.lat, target.lon) * METRES_PER_NM;
    const movesM = anchorNow
        ? calculateDistance(anchorNow.latitude, anchorNow.longitude, target.lat, target.lon) * METRES_PER_NM
        : null;
    const movesTowardDeg =
        anchorNow && movesM !== null && movesM > 0
            ? calculateBearing(anchorNow.latitude, anchorNow.longitude, target.lat, target.lon)
            : null;
    return { target, boatToAnchorM, inside: boatToAnchorM <= swingRadiusM, movesM, movesTowardDeg };
}

/** Where a distance and true bearing from the boat put the anchor, and what that would mean. */
export function planAnchorMove(
    boat: LatLon,
    anchorNow: LatLon | null,
    distanceM: number,
    bearingDeg: number,
    swingRadiusM: number,
): AnchorMovePlan {
    const target = destinationPoint(boat.latitude, boat.longitude, bearingDeg, distanceM / METRES_PER_NM);
    return planFromPoint(boat, anchorNow, { latitude: target.lat, longitude: target.lon }, swingRadiusM);
}

/** The watch the Pi keeps, as Shore Watch hears it from the Pi (126-07a). */
export interface PiMoveSource {
    /** Where the Pi is watching now, from its latest report. */
    anchor: LatLonPoint;
    /** The boat as the Pi last reported her. */
    boatFix: PiBoatFix | null;
    swingRadius: number;
    /** The skipper's setup numbers, when the Pi was given them (an older app gave none). */
    rodeLength?: number;
    waterDepth?: number;
    /** Where the Pi's watch was first set. */
    centreAtSet: LatLonPoint | null;
    /** This phone reaches the Pi off the boat (its tailnet address answered). */
    ashore: boolean;
    /** The Pi reports a drag alarm, or has lost the boat's GPS. */
    alarm: boolean;
    gpsLost: boolean;
}

interface SheetCallbacks {
    onClose: () => void;
    /** The move took: the watch accepted it, or (pi) the Pi's report shows it. */
    onMoved?: () => void;
}

export type MoveAnchorSheetProps = SheetCallbacks &
    (
        | {
              /** 'alarm': opened from the alarm screen, to move the mark and stop the alarm. */
              mode?: 'watch' | 'alarm';
              /** The live watch, as the page holds it. */
              snapshot: AnchorWatchSnapshot;
          }
        | {
              /** 'pi': the mark of the watch the boat's Pi keeps, from Shore Watch. */
              mode: 'pi';
              pi: PiMoveSource;
              /** Sends the new point to the Pi (the page wires it to the keeper). */
              onPiMove: (lat: number, lon: number) => Promise<PiMoveResult>;
          }
    );

/**
 * The watch being moved, the same shape whoever keeps it: what the fields,
 * the check and the preview read.
 */
interface MoveSubject {
    boat: (LatLon & { timestamp: number }) | null;
    anchor: LatLon | null;
    swingRadius: number;
    /** Rode and depth, when known. */
    rode: Pick<AnchorWatchConfig, 'rodeLength' | 'waterDepth'> | null;
    /** Where she lies from the anchor as the circle reckons it, or null to leave the distance empty. */
    lyingM: number | null;
    /** The boat's GPS antenna aft of the bow, in metres, when her fix is from it (else 0, 126-07c). */
    gpsToBowM: number;
    /** What the preview radar draws. */
    model: SwingCanvasModel;
}

/** Where a move of the Pi's mark stands, after Move. */
type PiPhase =
    | { kind: 'idle' }
    | { kind: 'sent' | 'unknown'; target: LatLon; at: number }
    | { kind: 'refused' }
    | { kind: 'moved' };
const PI_IDLE: PiPhase = { kind: 'idle' };

/** The Pi's watch as the preview radar draws it: no trail (Shore Watch's radar has it). */
function piCanvasModel(pi: PiMoveSource): SwingCanvasModel {
    return {
        state: pi.alarm ? 'alarm' : 'watching',
        anchorPosition: { latitude: pi.anchor.latitude, longitude: pi.anchor.longitude },
        vesselPosition: pi.boatFix && { latitude: pi.boatFix.latitude, longitude: pi.boatFix.longitude },
        swingRadius: pi.swingRadius,
        gpsAccuracy: pi.boatFix?.accuracy ?? 0,
        positionHistory: [],
    };
}

/**
 * The Pi's fix is the boat's GPS antenna, so the distance from it to the hook
 * is her lie plus the antenna's distance from the bow (126-07c). The Pi's
 * assignment carries the circle but not its allowance: a boat GPS with a
 * heading, the usual Pi boat, arms with the antenna's distance once, so that
 * is what is taken out. Exact then, and still inside the circle when it was
 * armed with twice it, or with none. A circle with no room for it past its
 * margin (a short rode on the 20 m floor) keeps the lie alone.
 */
function piSubject(pi: PiMoveSource, model: SwingCanvasModel | null, gpsToBowM: number): MoveSubject {
    const rode =
        pi.rodeLength !== undefined && pi.waterDepth !== undefined
            ? { rodeLength: pi.rodeLength, waterDepth: pi.waterDepth }
            : null;
    const fromAntenna = pi.swingRadius - ARMING_MARGIN_M - gpsToBowM > 0 ? gpsToBowM : 0;
    const lying =
        rode &&
        lyingDistanceM({ ...rode, safetyMargin: ARMING_MARGIN_M, antennaAllowanceM: fromAntenna }, pi.swingRadius);
    return {
        boat: pi.boatFix,
        anchor: pi.anchor,
        swingRadius: pi.swingRadius,
        rode,
        // No rode, no guess: the distance starts empty.
        lyingM: lying === null ? null : lying + fromAntenna,
        gpsToBowM: fromAntenna,
        model: model ?? piCanvasModel(pi),
    };
}

/**
 * This phone's watch: from the antenna only while it believes the boat's GPS,
 * and never more than its own circle allows for (126-07c). A watch armed from
 * the phone, restored from before 126, or running when the distance was
 * entered has no allowance, so it keeps the lie alone and opens inside.
 */
function watchSubject(snapshot: AnchorWatchSnapshot, gpsToBowM: number): MoveSubject {
    const fromAntenna = snapshot.gpsSource === 'nmea' ? Math.min(gpsToBowM, snapshot.config.antennaAllowanceM ?? 0) : 0;
    return {
        boat: snapshot.vesselPosition,
        anchor: snapshot.anchorPosition,
        swingRadius: snapshot.swingRadius,
        rode: snapshot.config,
        lyingM: lyingDistanceM(snapshot.config, snapshot.swingRadius) + fromAntenna,
        gpsToBowM: fromAntenna,
        model: snapshot,
    };
}

const FIELD =
    'min-h-11 min-w-0 rounded-xl border border-white/20 bg-white/5 px-2.5 py-2 text-center text-base font-bold text-white tabular-nums outline-hidden focus:border-sky-400';
// Tailwind only sees whole literal class names, so each variant is spelled out.
/** Steps aside while the keyboard is up, to keep the fields and buttons on screen. */
const KEYBOARD_ASIDE = "[html[data-keyboard-open='true']_&]:hidden";
/** The preview: gone in a short landscape band, and on a short phone while the keyboard is up. */
const PREVIEW_ASIDE =
    "[@media(max-height:500px)]:hidden [@media(max-height:700px)]:[html[data-keyboard-open='true']_&]:hidden";
/** Tighter while the keyboard is up. */
const FORM =
    "flex flex-none flex-col gap-1.5 px-4 pt-2 pb-4 [html[data-keyboard-open='true']_&]:pt-1 [html[data-keyboard-open='true']_&]:pb-3";
/**
 * The tabs (126-07b): their own row under the title, and on a short screen (a
 * small phone, or landscape) in the title's row, where the preview has no
 * height left to give them. Only where the header has 17rem for them (the
 * header is the container): at large text on a small phone they keep their
 * own row, and the card scrolls, as it may there.
 */
const TABS =
    'order-last grid basis-full grid-cols-2 gap-2 pr-3 [@media(max-height:600px)]:@min-[17rem]:order-none [@media(max-height:600px)]:@min-[17rem]:min-w-0 [@media(max-height:600px)]:@min-[17rem]:flex-1 [@media(max-height:600px)]:@min-[17rem]:basis-0 [@media(max-height:600px)]:@min-[17rem]:pr-0';
/** On a small phone the title gives the tabs its place; it still names the dialog. */
const TITLE_ASIDE = '[@media(orientation:portrait)_and_(max-height:600px)]:@min-[17rem]:sr-only';
/** The Position field: on the label's line where it fits, on its own where it does not. */
const POSITION_FIELD =
    'min-h-11 min-w-0 flex-1 basis-56 rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-base font-bold text-white tabular-nums outline-hidden placeholder:font-normal placeholder:text-slate-500 focus:border-sky-400';

export const MoveAnchorSheet: React.FC<MoveAnchorSheetProps> = (props) => {
    const { onClose, onMoved } = props;
    const fromAlarm = props.mode === 'alarm';
    const pi = props.mode === 'pi' ? props.pi : null;
    const snapshot = props.mode === 'pi' ? null : props.snapshot;
    const unit: LengthUnit = useSettingsStore((state) => (state.settings.units?.length === 'ft' ? 'ft' : 'm'));
    // Settings → Vessel → Dimensions: the boat's GPS antenna aft of the bow (126-07c).
    const antennaM = useSettingsStore((state) => gpsToBowMetres(state.settings.vessel));
    // The page builds `pi` afresh each render; the preview redraws only when
    // what it draws changes.
    const piModel = useMemo(
        () => (pi ? piCanvasModel(pi) : null),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the drawn fields, not the object
        [
            pi?.alarm,
            pi?.anchor.latitude,
            pi?.anchor.longitude,
            pi?.boatFix?.latitude,
            pi?.boatFix?.longitude,
            pi?.boatFix?.accuracy,
            pi?.swingRadius,
        ],
    );
    const subject =
        props.mode === 'pi' ? piSubject(props.pi, piModel, antennaM) : watchSubject(props.snapshot, antennaM);
    // The sheet's clock: ages are said as they are NOW, and a heading or a fix
    // that goes stale while the sheet is open stops counting, not just one
    // that was stale when it opened.
    const [now, setNow] = useState(() => Date.now());
    // The freshest true heading seen while the sheet is open.
    const [reading, setReading] = useState(() => freshTrueHeading(NmeaStore.getState(), Date.now()));
    useEffect(() => {
        const timer = window.setInterval(() => {
            const at = Date.now();
            setNow(at);
            const fresh = freshTrueHeading(NmeaStore.getState(), at);
            if (fresh) setReading((previous) => (sameReading(previous, fresh) ? previous : fresh));
        }, 1_000);
        return () => window.clearInterval(timer);
    }, []);
    const [distanceText, setDistanceText] = useState(() =>
        subject.lyingM === null ? '' : String(Math.round(fromMetres(subject.lyingM, unit))),
    );
    // null until the skipper types a bearing: the prefill follows the heading
    // until then, and what they type is theirs (no heading overwrites it).
    const [typedBearing, setTypedBearing] = useState<string | null>(null);
    const following = typedBearing === null;
    // 126-07b: From the boat, or a Position (typed, or dragged on the preview).
    const [how, setHow] = useState<How>('boat');
    const byBoat = how === 'boat';
    const [positionText, setPositionText] = useState('');
    // A drag on the preview while the finger is down: where the preview was
    // centred when the finger went down (it stays there, the point the drag
    // measures from), and where the anchor is now.
    const [dragging, setDragging] = useState<{ from: LatLon; at: LatLon } | null>(null);
    const headingAgeMs = reading ? Math.max(0, now - reading.at) : null;
    const headingStale = following && headingAgeMs !== null && headingAgeMs > HEADING_PREFILL_MAX_AGE_MS;
    const heading = following && reading && !headingStale ? reading : null;
    const bearingText = typedBearing ?? (heading ? String(Math.round(heading.deg) % 360).padStart(3, '0') : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Pi mode: where the move stands once sent (126-07a).
    const [piPhase, setPiPhase] = useState<PiPhase>(PI_IDLE);
    const piLate = piPhase.kind === 'sent' && now - piPhase.at > PI_REPORT_WAIT_MS;
    const piAwaiting = piPhase.kind === 'sent' && !piLate;
    // Moved only once the Pi's OWN report shows the new point, after a yes or
    // after no answer at all (it may have taken it anyway).
    const piShowsTarget =
        !!pi && (piPhase.kind === 'sent' || piPhase.kind === 'unknown') && piAnchorMatches(pi.anchor, piPhase.target);
    useEffect(() => {
        if (!piShowsTarget) return;
        setPiPhase({ kind: 'moved' });
        onMoved?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the report first shows it
    }, [piShowsTarget]);
    /** An edit starts again after an answer, but not while a yes awaits the Pi's report. */
    const edited = () => {
        setError(null);
        if (!piAwaiting) setPiPhase(PI_IDLE);
    };

    const titleId = useId();
    const hintId = useId();
    const readbackId = useId();
    const titleRef = useRef<HTMLHeadingElement>(null);
    // The heading takes focus, not a field: the keyboard stays down until the
    // skipper asks for it, so the preview and the check are seen first.
    const trapRef = useFocusTrap<HTMLElement>(true, { onEscape: onClose, initialFocusRef: titleRef });

    const distanceEntry = parseEntry(distanceText);
    const bearingEntry = parseEntry(bearingText);
    const distanceM = distanceEntry !== null && distanceEntry > 0 ? toMetres(distanceEntry, unit) : null;
    const bearingDeg = bearingEntry !== null && bearingEntry >= 0 && bearingEntry <= 360 ? bearingEntry % 360 : null;
    const boat = subject.boat;
    const fixStale =
        !!boat && !(Number.isFinite(boat.timestamp) && now - boat.timestamp <= ANCHOR_RELOCATE_FIX_MAX_AGE_MS);
    const typed = byBoat ? null : parseAnchorPosition(positionText);
    // The point the fields describe, which the preview centres on.
    const fieldsPlan = !boat
        ? null
        : byBoat
          ? distanceM !== null && bearingDeg !== null
              ? planAnchorMove(boat, subject.anchor, distanceM, bearingDeg, subject.swingRadius)
              : null
          : typed
            ? planFromPoint(boat, subject.anchor, { latitude: typed.lat, longitude: typed.lon }, subject.swingRadius)
            : null;
    const alarm = snapshot?.state === 'alarm';
    const movable = pi
        ? true
        : fromAlarm
          ? alarm && snapshot?.alarmCause === 'drag'
          : snapshot?.state === 'watching' || snapshot?.state === 'paused';
    // A drag is offered whenever a move could be: in every mode, either tab.
    const dragOn = movable && !busy && piPhase.kind !== 'moved';
    useEffect(() => {
        if (!dragOn) setDragging(null);
    }, [dragOn]);
    const drag = dragOn ? dragging : null;
    const fieldsPoint = fieldsPlan && { latitude: fieldsPlan.target.lat, longitude: fieldsPlan.target.lon };
    // While a finger drags the anchor, the live check follows it; the preview
    // stays centred where it was, so the anchor stays under the finger.
    const plan = drag && boat ? planFromPoint(boat, subject.anchor, drag.at, subject.swingRadius) : fieldsPlan;
    const preview = drag ? drag.from : fieldsPoint;
    const onAnchorDrag: AnchorDragHandlers | undefined = dragOn
        ? {
              move: (latitude, longitude, from) => setDragging({ from, at: { latitude, longitude } }),
              // Let go: Position, filled with the point, which is what Move will send.
              end: (lat, lon) => {
                  setDragging(null);
                  setHow('position');
                  setPositionText(formatDmm(lat, lon));
                  edited();
              },
              cancel: () => setDragging(null),
          }
        : undefined;
    // Only From the boat takes the bearing from the heading.
    const headingMatters = byBoat && !drag;
    // From the alarm: does her track back the move? Asked of the watch live,
    // before the tap (it holds her whole track; the snapshot's trail is short).
    const verdict =
        fromAlarm && movable && plan?.inside && boat && !fixStale
            ? AnchorWatchService.checkMoveFromAlarm(plan.target.lat, plan.target.lon)
            : null;
    // The Pi's watch: the Pi's guards, live (judgePiMove; the keeper asks again).
    const piVerdict =
        pi && plan
            ? judgePiMove({
                  now,
                  boatFix: pi.boatFix,
                  alarm: pi.alarm,
                  gpsLost: pi.gpsLost,
                  target: { latitude: plan.target.lat, longitude: plan.target.lon },
                  swingRadiusM: pi.swingRadius,
                  centreAtSet: pi.centreAtSet,
                  rodeLength: pi.rodeLength,
                  waterDepth: pi.waterDepth,
              })
            : null;
    const canMove =
        !!plan &&
        plan.inside &&
        movable &&
        !fixStale &&
        !busy &&
        !drag &&
        (!fromAlarm || !!verdict?.ok) &&
        (!pi || (!!piVerdict?.ok && !piAwaiting && piPhase.kind !== 'moved'));
    // Too early, or a track this phone did not see: no point would pass, so how
    // the fields were filled is beside the point, and the hint makes room.
    const noPointWouldDo = verdict?.ok === false && (verdict.refusal === 'too-early' || verdict.refusal === 'unseen');

    // `more` is the second sentence, which steps aside while the keyboard is up
    // (the colour, "outside" and the disabled button still say it then).
    let live: { text: string; more?: string; tone: 'ok' | 'warn' | 'quiet' };
    const lineOf = ([text, more]: readonly [string, string], tone: 'ok' | 'warn' | 'quiet') => ({
        text,
        more: more || undefined,
        tone,
    });
    // The page closes the sheet on these; for the moment until it does, they are said.
    const piBlocked = pi?.gpsLost ? 'gps-lost' : pi?.alarm ? 'alarm' : null;
    const [boatWords, circleWords] = plan ? sayPair(plan.boatToAnchorM, subject.swingRadius, unit) : ['', ''];
    if (piPhase.kind === 'moved') live = lineOf(PI_MOVE_LINES.moved, 'ok');
    else if (piPhase.kind === 'sent')
        live = piLate ? lineOf(PI_MOVE_LINES.late, 'warn') : lineOf(PI_MOVE_LINES.sent, 'quiet');
    else if (piPhase.kind === 'refused') live = lineOf(PI_MOVE_LINES.refused, 'warn');
    else if (piPhase.kind === 'unknown') live = lineOf(PI_MOVE_LINES.unknown, 'warn');
    else if (piBlocked) live = lineOf(PI_MOVE_REFUSAL_WORDS[piBlocked], 'warn');
    else if (fromAlarm && !alarm) live = { text: 'The alarm has stopped.', tone: 'quiet' };
    else if (fromAlarm && !movable)
        live = {
            text: 'GPS is lost, so a move cannot be checked. Silence the alarm and check her position.',
            tone: 'warn',
        };
    else if (alarm && !fromAlarm) live = { text: 'Silence the alarm before moving the anchor.', tone: 'warn' };
    else if (!movable) live = { text: 'There is no anchor watch on this phone to move.', tone: 'warn' };
    else if (!boat)
        live = {
            text: pi ? 'Waiting for the Pi to report the boat’s position.' : 'Waiting for a position fix for the boat.',
            tone: 'quiet',
        };
    else if (fixStale)
        live = {
            text: pi
                ? 'Waiting for a fresh position of the boat from the Pi.'
                : 'Waiting for a fresh position fix for the boat.',
            tone: 'quiet',
        };
    else if (headingMatters && headingStale)
        live = {
            text: `The boat’s heading is ${Math.round((headingAgeMs ?? 0) / 1000)} s old, too old to use. Enter the bearing, or wait for a fresh heading.`,
            tone: 'warn',
        };
    else if (!plan)
        live = byBoat
            ? { text: 'Enter the distance and the bearing from the boat to the anchor.', tone: 'quiet' }
            : positionText.trim()
              ? { text: `That isn’t a position I can read: try ${POSITION_EXAMPLE}`, tone: 'warn' }
              : { text: 'Type the anchor’s position, or drag the anchor on the preview.', tone: 'quiet' };
    else if (verdict && !verdict.ok)
        live = { text: verdict.lead, more: verdict.error.slice(verdict.lead.length + 1), tone: 'warn' };
    else if (plan.inside && piVerdict && !piVerdict.ok)
        live = { text: piVerdict.lead, more: piVerdict.error.slice(piVerdict.lead.length + 1), tone: 'warn' };
    else if (plan.inside)
        live = {
            text: `The boat would be ${boatWords} from the anchor, inside your ${circleWords} circle.`,
            more: fromAlarm
                ? 'Her track so far fits a swing round it.'
                : plan.movesM !== null
                  ? `The anchor moves ${say(plan.movesM, unit)}${
                        plan.movesM >= 1 && plan.movesTowardDeg !== null
                            ? ` ${bearingToCardinal(plan.movesTowardDeg)}`
                            : ''
                    }.`
                  : undefined,
            tone: 'ok',
        };
    else
        live = {
            text: `The boat would be ${boatWords} from the anchor, outside your ${circleWords} circle.`,
            more: fromAlarm ? 'The alarm would go on sounding.' : 'The alarm would sound at once.',
            tone: 'warn',
        };

    const distanceWords = subject.rode
        ? `Distance from your rode (${say(subject.rode.rodeLength, unit)} in ${say(subject.rode.waterDepth, unit)}), less its sag${
              subject.gpsToBowM > 0 ? `, plus ${say(subject.gpsToBowM, unit)} from the GPS to the bow` : ''
          }.`
        : 'The Pi has no rode for this watch: enter the distance.';
    const hint = !byBoat
        ? 'As the plotter shows it: degrees, minutes or seconds with N/S and E/W, or decimal degrees with a minus. Or drag the anchor on the preview.'
        : !following
          ? `${distanceWords} Bearing in °T, true, not magnetic.`
          : heading
            ? `${distanceWords} Bearing from the boat’s heading, ${Math.round((headingAgeMs ?? 0) / 1000)} s ago, ${heading.via}. °T is true, not magnetic.`
            : `${distanceWords} No fresh boat heading: enter the bearing in °T, true, not magnetic.`;
    // From the alarm, and from ashore on the Pi's watch: 125-03's words.
    const caution = fromAlarm || !!pi?.ashore;

    /** Pi mode: hand the point to the page, then say what the Pi answered. */
    const sendToPi = async (onPiMove: (lat: number, lon: number) => Promise<PiMoveResult>, target: LatLon) => {
        let result: PiMoveResult;
        try {
            result = await onPiMove(target.latitude, target.longitude);
        } catch (caught) {
            const error =
                caught instanceof Error && caught.message ? caught.message : 'The move was not sent. Try again.';
            result = { ok: false, outcome: 'invalid', error };
        }
        if (result.ok) setPiPhase({ kind: 'sent', target, at: Date.now() });
        else if (result.outcome === 'refused') setPiPhase({ kind: 'refused' });
        else if (result.outcome === 'unknown') setPiPhase({ kind: 'unknown', target, at: Date.now() });
        else setError(result.error);
    };

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!canMove || !plan) return;
        // The prefill is checked again at the moment of the tap, not as of the
        // last tick of the sheet's clock.
        if (byBoat && following && (!reading || Date.now() - reading.at > HEADING_PREFILL_MAX_AGE_MS)) {
            setError('The boat’s heading has gone stale. Check the bearing and try again.');
            return;
        }
        setBusy(true);
        setError(null);
        if (props.mode === 'pi') {
            await sendToPi(props.onPiMove, { latitude: plan.target.lat, longitude: plan.target.lon });
            setBusy(false);
            return;
        }
        let failure: string | null = null;
        try {
            const result = fromAlarm
                ? await AnchorWatchService.relocateAnchorFromAlarm(plan.target.lat, plan.target.lon)
                : await AnchorWatchService.relocateAnchor(plan.target.lat, plan.target.lon);
            if (!result.ok) failure = result.error;
        } catch (caught) {
            failure =
                caught instanceof Error && caught.message ? caught.message : 'The anchor was not moved. Try again.';
        }
        setBusy(false);
        if (failure) setError(failure);
        else onMoved?.();
    };

    return (
        <OverlayPortal
            // Over the alarm screen when opened from it: both are critical, and
            // this one, mounted later, paints on top.
            layer={fromAlarm ? 'critical' : 'modal'}
            // Presentation, not the dialog: the dialog is the card, which lifts
            // itself above the keyboard (.thalassa-keyboard-safe-sheet). Marking
            // the backdrop as the dialog would also opt it into index.css's
            // keyboard padding for centred dialogs and lift the card twice.
            role="presentation"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            className="flex items-center justify-center bg-black/70 px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] [html[data-keyboard-open='true']_&]:pb-4"
        >
            <section
                ref={trapRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={hintId}
                data-move-anchor-sheet
                data-keyboard-focus-scope
                // Up to the whole band between the safe area and the tab bar
                // while the keyboard is down (the utility's 68vh would squeeze
                // a short phone for no reason); the utility takes over with it up.
                // From the alarm the card moves to its keyboard place at once,
                // as it does under reduced motion: measured mid-glide, the field
                // reads low and the keyboard guard pads the card with scroll
                // space it keeps (WebKit, 844 x 390). The alarm is no time to glide.
                style={
                    { '--sheet-max-vh': '100%', ...(fromAlarm ? { transition: 'none' } : {}) } as React.CSSProperties
                }
                // overflow-y-auto, not hidden: where the card cannot fit (large
                // text on a small phone) it scrolls as a last resort, so the
                // live check, Cancel and Move are never clipped out of reach.
                className="thalassa-keyboard-safe-sheet relative flex w-full max-w-sm flex-col overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-slate-900 text-white shadow-2xl [@media(max-height:500px)]:max-w-2xl"
            >
                <header
                    className={`@container flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 pt-1 pr-1 pl-4 ${KEYBOARD_ASIDE}`}
                >
                    <h2
                        id={titleId}
                        ref={titleRef}
                        tabIndex={-1}
                        className={`ui-dialog-title min-w-0 flex-1 outline-none ${TITLE_ASIDE}`}
                    >
                        Move anchor
                    </h2>
                    {/* How the anchor's place is given (126-07b). Chosen before
                        typing, so it steps aside with the header while the
                        keyboard is up. */}
                    <div role="group" aria-label="Where the anchor is" className={TABS}>
                        {(['boat', 'position'] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={how === value}
                                onClick={() => {
                                    setHow(value);
                                    edited();
                                }}
                                className={`min-h-11 min-w-0 rounded-xl border px-2 text-sm leading-tight font-bold ${
                                    how === value
                                        ? 'border-sky-400 bg-sky-500/20 text-white'
                                        : 'border-white/15 bg-white/5 text-slate-300'
                                }`}
                            >
                                {value === 'boat' ? 'From the boat' : 'Position'}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-white/10 hover:text-white"
                    >
                        <XIcon className="h-5 w-5" />
                    </button>
                </header>

                {/* The one part that gives up space: it shrinks first, and
                    steps aside on short screens while the keyboard is up. */}
                <div className={`relative mx-3 h-[200px] min-h-0 shrink ${PREVIEW_ASIDE}`}>
                    <SwingCircleCanvas
                        snapshot={subject.model}
                        previewAnchor={preview}
                        onAnchorDrag={onAnchorDrag}
                        className="absolute inset-0 h-full w-full"
                        ariaLabel="Preview of the swing circle around the new anchor, with the boat"
                    />
                </div>

                <form noValidate onSubmit={(event) => void submit(event)} className={FORM}>
                    {byBoat ? (
                        /* One sentence, read as the skipper would say it. */
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-base font-semibold text-white">
                            <span>Anchor is</span>
                            <span className="inline-flex items-center gap-1.5">
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    aria-label={`Distance from the boat to the anchor, in ${unit === 'ft' ? 'feet' : 'metres'}`}
                                    value={distanceText}
                                    onChange={(event) => {
                                        setDistanceText(event.target.value);
                                        edited();
                                    }}
                                    className={`${FIELD} w-[4.5rem]`}
                                />
                                <span aria-hidden="true">{unit}</span>
                            </span>
                            <span>from the boat, bearing</span>
                            <span className="inline-flex items-center gap-1.5">
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    aria-label="Bearing from the boat to the anchor, in degrees true"
                                    placeholder="°T"
                                    value={bearingText}
                                    onChange={(event) => {
                                        setTypedBearing(event.target.value);
                                        edited();
                                    }}
                                    className={`${FIELD} w-14`}
                                />
                                <span aria-hidden="true" title="degrees true, not magnetic">
                                    °T
                                </span>
                            </span>
                        </p>
                    ) : (
                        /* The readback sits beside the field where there is room
                            (landscape), under it where there is not. */
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-base font-semibold text-white">
                            <span aria-hidden="true">Anchor at</span>
                            <input
                                type="text"
                                inputMode="text"
                                autoCapitalize="characters"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck={false}
                                aria-label="Anchor at: position, latitude and longitude"
                                aria-describedby={typed ? readbackId : undefined}
                                placeholder={POSITION_EXAMPLE}
                                value={positionText}
                                onChange={(event) => {
                                    setPositionText(event.target.value);
                                    edited();
                                }}
                                className={POSITION_FIELD}
                            />
                            {/* How it was read: a wrong hemisphere shows here first. */}
                            {typed && (
                                <p
                                    id={readbackId}
                                    data-testid="move-anchor-readback"
                                    className="min-w-0 text-sm leading-snug font-semibold text-sky-200 tabular-nums"
                                >
                                    Reads as {formatDmm(typed.lat, typed.lon)}
                                </p>
                            )}
                        </div>
                    )}
                    {/* Under the fields, so they sit where they do in the watch-page
                        sheet (the keyboard guard measures them there); it steps
                        aside with the hint while the keyboard is up. */}
                    {caution && (
                        <p
                            data-testid="move-anchor-caution"
                            className={`text-sm leading-snug font-semibold text-amber-200 ${KEYBOARD_ASIDE}`}
                        >
                            Only move it if you’re sure the anchor hasn’t moved.
                        </p>
                    )}
                    <p
                        id={hintId}
                        data-testid="move-anchor-hint"
                        className={`text-xs leading-snug text-slate-400 ${noPointWouldDo ? 'hidden' : KEYBOARD_ASIDE}`}
                    >
                        {hint}
                    </p>
                    <p
                        role="status"
                        aria-live="polite"
                        className={`text-sm leading-snug font-semibold ${
                            live.tone === 'ok'
                                ? 'text-emerald-300'
                                : live.tone === 'warn'
                                  ? 'text-amber-300'
                                  : 'text-slate-300'
                        }`}
                    >
                        {live.text}
                        {live.more && <span className={KEYBOARD_ASIDE}> {live.more}</span>}
                    </p>
                    {error && (
                        <p role="alert" className="text-sm text-red-300">
                            {error}
                        </p>
                    )}
                    {/* Side by side at every size, so the pair is one row even at
                        320 px with large text and the keyboard up. The dialog is
                        "Move anchor", so the button says "Move"; its name keeps
                        the whole phrase (label in name, for Voice Control). */}
                    {/* From the alarm the button says what it does in full, so it
                        takes the wider column and wraps tight at 320 px. */}
                    <div
                        className={`grid gap-2 ${fromAlarm ? 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'grid-cols-2'}`}
                    >
                        <Button onClick={onClose}>Cancel</Button>
                        <Button
                            type="submit"
                            variant="primary"
                            disabled={!canMove}
                            aria-label={
                                busy
                                    ? pi
                                        ? 'Sending the move to the Pi'
                                        : 'Moving the anchor'
                                    : fromAlarm
                                      ? undefined
                                      : 'Move anchor'
                            }
                            className={fromAlarm ? 'px-3! py-2! leading-tight' : undefined}
                        >
                            {busy ? (pi ? 'Sending…' : 'Moving…') : fromAlarm ? 'Move and stop alarm' : 'Move'}
                        </Button>
                    </div>
                </form>
            </section>
        </OverlayPortal>
    );
};
