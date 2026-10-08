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
 *    Settings), never assumed metres.
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
 * The Pi keeps its own watch with its own keeper; this sheet never touches it.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import {
    ANCHOR_RELOCATE_FIX_MAX_AGE_MS,
    AnchorWatchService,
    type AnchorWatchConfig,
    type AnchorWatchSnapshot,
} from '../../services/AnchorWatchService';
import { NmeaStore, type NmeaStoreState } from '../../services/NmeaStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { calculateDistance, destinationPoint } from '../../utils/navigationCalculations';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import { Button } from '../ui/Button';
import { XIcon } from '../Icons';
import { SwingCircleCanvas } from './SwingCircleCanvas';

/** A true heading older than this does not prefill the bearing. */
export const HEADING_PREFILL_MAX_AGE_MS = 10_000;
const METRES_PER_FOOT = 0.3048;
const METRES_PER_NM = 1852;

type LengthUnit = 'm' | 'ft';
type LatLon = { latitude: number; longitude: number };

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
 * margin (AnchorWatchService), so this is the circle less its margin, and it
 * always opens inside the circle: the full reach does not, for a long chain in
 * deep water (80 m in 12 m: a 79 m reach, a 77 m circle). Never more than the
 * full reach, for a short rode whose circle is held up by the 20 m floor.
 */
export function lyingDistanceM(
    config: Pick<AnchorWatchConfig, 'rodeLength' | 'waterDepth' | 'safetyMargin'>,
    swingRadiusM: number,
): number {
    const reach = horizontalScopeM(config);
    const lying = swingRadiusM - config.safetyMargin;
    return Number.isFinite(lying) && lying > 0 ? Math.min(reach, lying) : reach;
}

/** A true heading as it was read: degrees, when the instruments sent it, and from where. */
type HeadingReading = { deg: number; at: number; via: string };

/** The boat's true heading if it is fresh enough to stand for the bearing to the anchor. */
export function freshTrueHeading(
    state: Pick<NmeaStoreState, 'headingTrue' | 'remote'>,
    now: number,
): HeadingReading | null {
    const { value, lastUpdated } = state.headingTrue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 360) return null;
    const ageMs = now - lastUpdated;
    if (!(lastUpdated > 0) || ageMs < -1_000 || ageMs > HEADING_PREFILL_MAX_AGE_MS) return null;
    const via = !state.remote ? 'from the instruments' : state.remote.via === 'lan' ? 'via the Pi' : 'via the cloud';
    return { deg: value, at: lastUpdated, via };
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
    const boatToAnchorM = calculateDistance(boat.latitude, boat.longitude, target.lat, target.lon) * METRES_PER_NM;
    const movesM = anchorNow
        ? calculateDistance(anchorNow.latitude, anchorNow.longitude, target.lat, target.lon) * METRES_PER_NM
        : null;
    return { target, boatToAnchorM, inside: boatToAnchorM <= swingRadiusM, movesM };
}

export interface MoveAnchorSheetProps {
    /** The live watch, as the page holds it. */
    snapshot: AnchorWatchSnapshot;
    onClose: () => void;
    /** The watch accepted the move. */
    onMoved?: () => void;
    /** 'alarm': opened from the alarm screen, to move the mark and stop the alarm. */
    mode?: 'watch' | 'alarm';
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

export const MoveAnchorSheet: React.FC<MoveAnchorSheetProps> = ({ snapshot, onClose, onMoved, mode = 'watch' }) => {
    const fromAlarm = mode === 'alarm';
    const unit: LengthUnit = useSettingsStore((state) => (state.settings.units?.length === 'ft' ? 'ft' : 'm'));
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
        String(Math.round(fromMetres(lyingDistanceM(snapshot.config, snapshot.swingRadius), unit))),
    );
    // null until the skipper types a bearing: the prefill follows the heading
    // until then, and what they type is theirs (no heading overwrites it).
    const [typedBearing, setTypedBearing] = useState<string | null>(null);
    const following = typedBearing === null;
    const headingAgeMs = reading ? Math.max(0, now - reading.at) : null;
    const headingStale = following && headingAgeMs !== null && headingAgeMs > HEADING_PREFILL_MAX_AGE_MS;
    const heading = following && reading && !headingStale ? reading : null;
    const bearingText = typedBearing ?? (heading ? String(Math.round(heading.deg) % 360).padStart(3, '0') : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const titleId = useId();
    const hintId = useId();
    const titleRef = useRef<HTMLHeadingElement>(null);
    // The heading takes focus, not a field: the keyboard stays down until the
    // skipper asks for it, so the preview and the check are seen first.
    const trapRef = useFocusTrap<HTMLElement>(true, { onEscape: onClose, initialFocusRef: titleRef });

    const distanceEntry = parseEntry(distanceText);
    const bearingEntry = parseEntry(bearingText);
    const distanceM = distanceEntry !== null && distanceEntry > 0 ? toMetres(distanceEntry, unit) : null;
    const bearingDeg = bearingEntry !== null && bearingEntry >= 0 && bearingEntry <= 360 ? bearingEntry % 360 : null;
    const boat = snapshot.vesselPosition;
    const fixStale =
        !!boat && !(Number.isFinite(boat.timestamp) && now - boat.timestamp <= ANCHOR_RELOCATE_FIX_MAX_AGE_MS);
    const plan =
        boat && distanceM !== null && bearingDeg !== null
            ? planAnchorMove(boat, snapshot.anchorPosition, distanceM, bearingDeg, snapshot.swingRadius)
            : null;
    const alarm = snapshot.state === 'alarm';
    const movable = fromAlarm
        ? alarm && snapshot.alarmCause === 'drag'
        : snapshot.state === 'watching' || snapshot.state === 'paused';
    // From the alarm: does her track back the move? Asked of the watch live,
    // before the tap (it holds her whole track; the snapshot's trail is short).
    const verdict =
        fromAlarm && movable && plan?.inside && boat && !fixStale
            ? AnchorWatchService.checkMoveFromAlarm(plan.target.lat, plan.target.lon)
            : null;
    const canMove = !!plan && plan.inside && movable && !fixStale && !busy && (!fromAlarm || !!verdict?.ok);
    // Too early, or a track this phone did not see: no point would pass, so how
    // the fields were filled is beside the point, and the hint makes room.
    const noPointWouldDo = verdict?.ok === false && (verdict.refusal === 'too-early' || verdict.refusal === 'unseen');

    // `more` is the second sentence, which steps aside while the keyboard is up
    // (the colour, "outside" and the disabled button still say it then).
    let live: { text: string; more?: string; tone: 'ok' | 'warn' | 'quiet' };
    const [boatWords, circleWords] = plan ? sayPair(plan.boatToAnchorM, snapshot.swingRadius, unit) : ['', ''];
    if (fromAlarm && !alarm) live = { text: 'The alarm has stopped.', tone: 'quiet' };
    else if (fromAlarm && !movable)
        live = {
            text: 'GPS is lost, so a move cannot be checked. Silence the alarm and check her position.',
            tone: 'warn',
        };
    else if (alarm && !fromAlarm) live = { text: 'Silence the alarm before moving the anchor.', tone: 'warn' };
    else if (!movable) live = { text: 'There is no anchor watch on this phone to move.', tone: 'warn' };
    else if (!boat) live = { text: 'Waiting for a position fix for the boat.', tone: 'quiet' };
    else if (fixStale) live = { text: 'Waiting for a fresh position fix for the boat.', tone: 'quiet' };
    else if (headingStale)
        live = {
            text: `The boat’s heading is ${Math.round((headingAgeMs ?? 0) / 1000)} s old, too old to use. Enter the bearing, or wait for a fresh heading.`,
            tone: 'warn',
        };
    else if (!plan) live = { text: 'Enter the distance and the bearing from the boat to the anchor.', tone: 'quiet' };
    else if (verdict && !verdict.ok)
        live = { text: verdict.lead, more: verdict.error.slice(verdict.lead.length + 1), tone: 'warn' };
    else if (plan.inside)
        live = {
            text: `The boat would be ${boatWords} from the anchor, inside your ${circleWords} circle.`,
            more: fromAlarm
                ? 'Her track so far fits a swing round it.'
                : plan.movesM !== null
                  ? `The anchor moves ${say(plan.movesM, unit)}.`
                  : undefined,
            tone: 'ok',
        };
    else
        live = {
            text: `The boat would be ${boatWords} from the anchor, outside your ${circleWords} circle.`,
            more: fromAlarm ? 'The alarm would go on sounding.' : 'The alarm would sound at once.',
            tone: 'warn',
        };

    const rodeWords = `${say(snapshot.config.rodeLength, unit)} in ${say(snapshot.config.waterDepth, unit)}`;
    const distanceWords = `Distance from your rode (${rodeWords}), less its sag.`;
    const hint = !following
        ? `${distanceWords} Bearing in °T, true, not magnetic.`
        : heading
          ? `${distanceWords} Bearing from the boat’s heading, ${Math.round((headingAgeMs ?? 0) / 1000)} s ago, ${heading.via}. °T is true, not magnetic.`
          : `${distanceWords} No fresh boat heading: enter the bearing in °T, true, not magnetic.`;

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!canMove || !plan) return;
        // The prefill is checked again at the moment of the tap, not as of the
        // last tick of the sheet's clock.
        if (following && (!reading || Date.now() - reading.at > HEADING_PREFILL_MAX_AGE_MS)) {
            setError('The boat’s heading has gone stale. Check the bearing and try again.');
            return;
        }
        setBusy(true);
        setError(null);
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
                <header className={`flex shrink-0 items-center gap-2 pt-1 pr-1 pl-4 ${KEYBOARD_ASIDE}`}>
                    <h2
                        id={titleId}
                        ref={titleRef}
                        tabIndex={-1}
                        className="ui-dialog-title min-w-0 flex-1 outline-none"
                    >
                        Move anchor
                    </h2>
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
                        snapshot={snapshot}
                        previewAnchor={plan ? { latitude: plan.target.lat, longitude: plan.target.lon } : null}
                        className="absolute inset-0 h-full w-full"
                        ariaLabel="Preview of the swing circle around the new anchor, with the boat"
                    />
                </div>

                <form noValidate onSubmit={(event) => void submit(event)} className={FORM}>
                    {/* One sentence, read as the skipper would say it. */}
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
                                    setError(null);
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
                                    setError(null);
                                }}
                                className={`${FIELD} w-14`}
                            />
                            <span aria-hidden="true" title="degrees true, not magnetic">
                                °T
                            </span>
                        </span>
                    </p>
                    {/* Under the fields, so they sit where they do in the watch-page
                        sheet (the keyboard guard measures them there); it steps
                        aside with the hint while the keyboard is up. */}
                    {fromAlarm && (
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
                            aria-label={busy ? 'Moving the anchor' : fromAlarm ? undefined : 'Move anchor'}
                            className={fromAlarm ? 'px-3! py-2! leading-tight' : undefined}
                        >
                            {busy ? 'Moving…' : fromAlarm ? 'Move and stop alarm' : 'Move'}
                        </Button>
                    </div>
                </form>
            </section>
        </OverlayPortal>
    );
};
