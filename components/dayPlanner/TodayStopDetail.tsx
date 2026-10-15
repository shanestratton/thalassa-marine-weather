import React, { Suspense, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { PassageSpeedModel } from '../../services/passagePlan';
import type { LatLon } from '../../services/dayPlanner/places';
import type { Segment } from '../../services/weather/shelter/shelterGeometry';
import {
    LEAVING_MARINA,
    distanceLine,
    parksNotes,
    shortDate,
    stopDetail,
    stopVerdict,
    wallTime,
    zoneAbbrev,
    type DayPlanView,
    type DayWindow,
    type DepartureEval,
    type StayOption,
    type StopDetail,
    type StopDetailArgs,
    type StopRow,
} from '../../services/dayPlanner/today';
import {
    STOP_ROUTE_WORDS,
    routeRowWords,
    routeTimingLine,
    type RouteState,
    type StopRouteAction,
} from '../../services/dayPlanner/stopRoute';
import { useDraftConfirmRequest } from '../../stores/draftConfirmStore';
import { TodayModal } from './TodayModal';

type Landing = { fromMs: number; toMs: number } | 'no-curve';

// The route picture and the shelter rose (132-PYD-9), drawn in their own chunk. One that will not load says so in
// the picture's room and leaves the rose out: never an error screen, never a reload.
type Pictures = typeof import('./TodayStopPicture');
const pictures = () => import('./TodayStopPicture').catch(() => null);
const StopMap = React.lazy<React.ComponentType<React.ComponentProps<Pictures['StopMap']>>>(() =>
    pictures().then((m) => ({
        default: m?.StopMap ?? (() => <p className="today-pic-band">Picture didn&rsquo;t load</p>),
    })),
);
const ShelterRose = React.lazy<React.ComponentType<React.ComponentProps<Pictures['ShelterRose']>>>(() =>
    pictures().then((m) => ({ default: m?.ShelterRose ?? (() => null) })),
);

/**
 * How tall the route picture may be (132-PYD-9): what the page has left with
 * it out, as much as the room allows (96-160 px, half its column's width), or
 * nothing. The plan comes first: where only the picture would make the page
 * scroll, or under 72 px are left (too small to read its words and the wind
 * apart), it is not drawn. Where the page scrolls without it (large text, a
 * reviewed stop's notes on an SE) and in phone landscape's two columns, it
 * takes its full size in the scroll. 0 with no layout (a test's DOM).
 */
export function pictureHeight(plan: HTMLElement): number {
    const room = pictureRoom(plan);
    if (!room) return 0;
    const tall = Math.min(160, Math.max(96, 96 + (room.inner - 576) / 4), plan.clientWidth / 2);
    const fit = room.left < -1 || room.row ? tall : Math.min(tall, room.left - room.gap);
    return fit >= 72 ? Math.floor(fit) : 0;
}

/** The room the stop page has, as if the picture were not on it: what the card could still grow by, or less what
 *  its body already scrolls by (`left`, the picture's gap included); the room the card is given (`inner`). */
export function pictureRoom(plan: HTMLElement) {
    const body = plan.closest('.today-body');
    const card = plan.closest('.today-card');
    const overlay = card?.parentElement;
    if (!body || !card || !overlay) return null;
    const px = (value: string) => parseFloat(value) || 0;
    const pad = getComputedStyle(overlay);
    const inner = overlay.clientHeight - px(pad.paddingTop) - px(pad.paddingBottom);
    const over = body.scrollHeight - body.clientHeight;
    const gap = px(getComputedStyle(plan).rowGap);
    const box = plan.querySelector<HTMLElement>('.today-pic');
    return {
        inner,
        gap,
        row: getComputedStyle(body).flexDirection === 'row',
        left:
            (over > 0.5 ? -over : Math.max(0, inner - card.getBoundingClientRect().height)) +
            (box ? box.offsetHeight + gap : 0),
    };
}

/** The landing window at a reviewed stop (todayLoader.loadLandingWindow), asked only when its detail opens. */
export type LandingLoader = (
    stop: LatLon,
    window: DayWindow,
    stay: { arriveMs: number | null; stayEndMs: number | null } | null,
    signal: AbortSignal,
) => Promise<Landing>;

/** The stop page's route (127-PYD-2): set only where routing is offered (his account in 127). */
export interface StopRouteView {
    /** Asked, running or done; undefined before the tap. */
    state: RouteState | undefined;
    /** Why it cannot route yet, with what one tap does about it. */
    blocked: { words: string; action?: StopRouteAction } | null;
    /** His account: how long it took. */
    owner: boolean;
    draftM: number;
    onRoute: (departureMs: number | null) => void;
    /** Routed: Auto's chart over Plan Your Day, at this leave (127-PYD-3). */
    onShow: (departureMs: number | null) => void;
    onAction: (action: StopRouteAction) => void;
    /** Routed (127-PYD-11): the leave window's words for the leave she chose, or still checking the tide. */
    leave?: LeaveSay | 'checking' | null;
}

/** The leave window's row (`more`: its closing sentences), and footnote, for the leave she chose (pure: a chip
 *  tap fetches nothing). */
export type LeaveSay = (chosenMs: number | null) => { text: string; more: string | null; footnote: string | null };

/**
 * Plan Your Day, screen 2 (build 124): one stop. Since 132-PYD-8 a plan read
 * at a glance, not ten rows of prose: its level at the top, always, in its
 * colour ("✓ Inside your limits", "✕ Over your limits: SE 30 kn on the way",
 * 127-PYD-1); the route row, with the distance; the times big ("LEAVE 07:00 ·
 * ASHORE 10:28 · HOME 15:57", what each leg takes under them); the leave
 * chips, the best departure's window (a tap recomputes in place); up to four
 * facts (shelter, sea, the light to spare, local notes); and a reviewed
 * stop's own Parks notes (Cid Harbour's sharks) in full, never folded, with
 * the landing tide where Queensland Parks name one. How each time was worked
 * out is a tap away, every row as it was: why it is here (127-PYD-4), leave
 * and there, ashore or at anchor with the shelter's reason, what a place with
 * no local notes is and what her charts say at its pin, home, the light, the
 * sea, and the polar and wind the times were sailed on. What is not checked,
 * and "Not a clearance", stay under it all. With no times it says why where
 * they would be.
 * Where routing is offered (127-PYD-2, his account in 127) the route row says
 * each stage with its own seconds, then the routed distance and what the
 * router found (it is then the distance row), or why there is no route with
 * the estimate under it; the owner's timing line sits under it. The one main
 * button follows the route (127-PYD-3), and never plots a straight line:
 * "Route round the land", "Finding the way…", then "Show route on chart"
 * (Auto's chart over this page, at the chosen leave); "Plot your saved route"
 * for her own line; else "Plot by hand", her start and the stop as two marks
 * with why there is no route. Each sets the departure. Fits outright at normal
 * text from 320 × 568 for a stop with no local notes and from 375 × 667 with
 * them; at 320 × 568 a reviewed stop's notes may push the leave chips and the
 * details into a scroll (the first note in view as it opens). Phone landscape
 * reads it in two columns, the plan on the left and the facts and notes on the
 * right, and anything may scroll at large text.
 * 132-PYD-9: a small rose beside the shelter word shows which way the land
 * shelters her, and under the facts and notes a small picture of the way:
 * land from OpenStreetMap, her start, the stop and the wind, with the routed
 * line once routed, never a straight line. It takes only the room the plan
 * leaves (pictureHeight).
 */
export function TodayStopDetail({
    row,
    view,
    stay,
    speed,
    polarIsOwn,
    polar = null,
    leavingMarina,
    loadLanding,
    onPlot,
    onBack,
    route = null,
    hidden,
    start,
    coastline,
}: {
    row: StopRow;
    view: DayPlanView;
    stay: StayOption;
    speed: PassageSpeedModel;
    /** Where she plans from, and the coastline read round it (TodayBase): the picture's dot and land. */
    start: LatLon;
    coastline: readonly Segment[] | null;
    polarIsOwn: boolean;
    /** The routers' polar the times were sailed on; it decides the footnote's words. */
    polar?: StopDetailArgs['polar'];
    leavingMarina: boolean;
    /** Set only for a reviewed stop whose Parks note names a landing tide. */
    loadLanding: LandingLoader | null;
    /** Plot by hand (or her saved route), with why there is no route. */
    onPlot: (departureMs: number | null, why: string) => void;
    onBack: () => void;
    route?: StopRouteView | null;
    /** While Auto's chart shows this route over Plan Your Day. */
    hidden?: boolean;
}) {
    const plan = row.plan;
    const [chosenMs, setChosenMs] = useState<number | null>(null);
    const chosen: DepartureEval | null =
        (chosenMs !== null ? plan?.departures.find((d) => d.departureMs === chosenMs) : null) ?? plan?.best ?? null;
    const [landing, setLanding] = useState<Landing | undefined>(undefined);
    const arriveMs = chosen?.arriveMs ?? null;
    const stayEndMs = chosen?.stayEndMs ?? null;
    const window = view.window;
    const candidate = row.candidate;

    // The day's window is rebuilt with every recompute; the curve is asked
    // again only when the day or the stay's times change.
    const windowRef = useRef(window);
    windowRef.current = window;
    const day = `${window.date}|${window.zone}`;
    useEffect(() => {
        if (!loadLanding) return;
        const controller = new AbortController();
        setLanding(undefined);
        loadLanding(
            { lat: candidate.lat, lon: candidate.lon },
            windowRef.current,
            { arriveMs, stayEndMs },
            controller.signal,
        )
            .then((result) => {
                if (!controller.signal.aborted) setLanding(result);
            })
            .catch(() => {
                /* closed, or no curve: the row says so once it answers */
            });
        return () => controller.abort();
    }, [loadLanding, candidate.lat, candidate.lon, day, arriveMs, stayEndMs]);

    const zone = window.zone;
    const state = route?.state;
    const routed = state?.kind === 'routed';
    const busy = state?.kind === 'queued' || state?.kind === 'routing';
    // No route: the estimate stays, in the route row (one row fewer, so a long refusal fits).
    const estimate = state?.kind === 'no-route' ? distanceLine(candidate.distance) : null;
    // Routed, the leave window says when the tide allows the way out, so the marina line goes (127-PYD-11).
    const leave = routed ? route?.leave : null;
    const marina = leavingMarina && !leave;
    // Its own seconds while it routes, counted from the tap (Auto's provider sends words, not seconds).
    const [, tick] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [busy]);
    // The draft modal asks over this page: it steps down a layer while it does.
    const asking = !!useDraftConfirmRequest();
    // Back from Auto's chart, focus returns to the button that opened it (after the traps settle).
    const main = useRef<HTMLButtonElement>(null);
    const wasHidden = useRef(false);
    useEffect(() => {
        if (wasHidden.current && !hidden) main.current?.focus({ preventScroll: true });
        wasHidden.current = !!hidden;
    }, [hidden]);
    // Times only from a route forecast that loaded (a failed leg's walk is in no wind).
    const detail: StopDetail = plan?.weatherLoaded
        ? stopDetail({
              plan,
              departure: chosen,
              stay,
              window,
              speed,
              polarIsOwn,
              polar,
              leavingMarina: marina,
              landing: loadLanding ? (landing ?? undefined) : undefined,
              why: row.why,
              place: row.place,
              routed: routed ? { draftM: route!.draftM } : null,
              updating: routed && (row.route === 'estimate' ? 'estimate' : row.route === 'updating'),
          })
        : {
              title: row.name,
              sub: `${shortDate(window.date, zone)} · times in ${zoneAbbrev(window.firstLightMs ?? wallTime(window.date, 12, 0, zone), zone)}`,
              rows: [row.why, row.place].filter((text): text is string => !!text),
              footnote: 'No times without a forecast. Depth and tide over the route are not checked. Not a clearance.',
              how: '',
              chips: [],
              // Over on the wind at the place, even with no route weather: its verdict first.
              verdict: row.level === 'over' ? stopVerdict('over', row.reason) : null,
              times: [],
              facts: [row.shelter],
          };

    // A place beyond the five opens on the area wind's times, under them its weather along the way, loading
    // or failed; one in Not today with times (a gap in a day over her limits) opens on why (127-PYD-5).
    const gap = row.line2Reason ? undefined : view.notToday.find((r) => r.id === row.id)?.reason;
    const verdict = gap ? `✕ ${gap[0].toUpperCase()}${gap.slice(1)}` : detail.verdict;
    const level = gap ? 'over' : ((plan?.weatherLoaded ? chosen?.level : row.level) ?? 'unknown');
    // A reviewed stop's own Parks notes, whole on the page, and the landing tide's window with them.
    const notes = parksNotes(candidate);
    const landingRow = detail.rows.find((text) => text.startsWith('Landing window'));
    // The distance is in the route block: the route row is it once routed, and holds the estimate with no route.
    const far = distanceLine(candidate.distance);
    // The rest of the rows as they were, and how the times were worked out, a tap away (132-PYD-8). A gap's
    // page keeps its leave's own verdict there.
    const rest = [
        ...detail.rows.filter(
            (text) =>
                text !== verdict &&
                text !== far &&
                text !== landingRow &&
                text !== LEAVING_MARINA &&
                !notes.includes(text),
        ),
        ...(detail.how ? [detail.how] : []),
    ];
    const departure = plan?.weatherLoaded ? (chosen?.departureMs ?? null) : null;
    const said = leave && leave !== 'checking' ? leave(departure) : null;
    // The plan's fold 2 (127-PYD-11): where the leave row's closing sentences alone stand between the page and one
    // screen (a reviewed day trip at 375 × 667), they fold under its first, a tap away. Measured unfolded first, and
    // again whenever its words, the page's rows or the screen change; left open where folding would not make it fit.
    const leaveLi = useRef<HTMLLIElement>(null);
    const [resizes, resized] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        // globalThis: `window` here is her day's.
        globalThis.addEventListener('resize', resized);
        return () => globalThis.removeEventListener('resize', resized);
    }, []);
    const foldKey = said?.more ? `${resizes}|${said.text}|${detail.rows.join('|')}|${detail.chips.length}` : null;
    const [fold, setFold] = useState<{ key: string; on: boolean } | null>(null);
    // The facts' half of the page, where the route picture goes (132-PYD-9).
    const glance = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const body = leaveLi.current?.closest('.today-body');
        // With the details open the page scrolls by her choice: measured again as they close (132-PYD-8).
        if (!foldKey || !body || body.querySelector('.today-how[open]')) return;
        // Measured as if the route picture were not there: it takes only the room the plan leaves (132-PYD-9).
        const room = glance.current && pictureRoom(glance.current);
        const over = room ? room.left < -1 : body.scrollHeight - body.clientHeight > 1;
        if (fold?.key !== foldKey) setFold({ key: foldKey, on: over });
        else if (fold.on && over) setFold({ key: foldKey, on: false });
    }, [foldKey, fold]);
    const folded = !!foldKey && fold?.key === foldKey && fold.on;
    // The route picture's height (132-PYD-9), measured after every render, as the page's rows, the leave fold and
    // the screen settle; kept while the details are open, as the fold is, and while Auto's chart hides the page.
    // It settles: it sets only a height that differs, and the room it reads counts the picture's own back in.
    const [pic, setPic] = useState(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useLayoutEffect(() => {
        const plan = glance.current;
        if (!plan || hidden || plan.querySelector('.today-how[open]')) return;
        const height = pictureHeight(plan);
        if (Math.abs(height - pic) > 1) setPic(height);
    });
    // Blocked (other than a draft to confirm), she can still plot by hand: the row says what routing needs.
    const toRoute = !!route && (busy || (!state && (!route.blocked || route.blocked.action === 'confirm-draft')));
    // The route block (132-PYD-8): the distance (unless the route row says it), the route row, when to leave for the
    // tide or his timing, and the marina line.
    const items: React.ReactElement[] = routed || estimate ? [] : [<li key="far">{far}</li>];
    if (route) {
        const blocked = state ? null : route.blocked;
        const words = !state
            ? (blocked?.words ?? STOP_ROUTE_WORDS.notYet)
            : state.kind === 'routed'
              ? routeRowWords(state.proposal.engine, state.leg.nm)
              : state.words;
        const secs = state && 'since' in state ? Math.floor((Date.now() - state.since) / 1000) : 0;
        const time = route.owner && state && 'wallMs' in state ? routeTimingLine(state) : null;
        items.push(
            <li key="route" data-route={state?.kind ?? (blocked ? 'blocked' : 'ready')}>
                {blocked?.action ? (
                    <button
                        type="button"
                        className="today-notice today-notice-button"
                        onClick={() =>
                            blocked.action === 'confirm-draft'
                                ? route.onRoute(departure)
                                : route.onAction(blocked.action!)
                        }
                    >
                        {words}
                        {blocked.action === 'preferences' ? ' (also in Settings → Preferences)' : ''}
                    </button>
                ) : (
                    <>
                        {/* VoiceOver hears the stage, never the ticking seconds. */}
                        <span aria-live="polite">{busy ? words.replace(/…$/, '') : words}</span>
                        {busy && <span aria-hidden="true">{secs > 0 ? ` · ${secs} s` : '…'}</span>}
                        {/* With the leave row under it, his timing joins the route row: the page still fits (127-PYD-11). */}
                        {time && leave && (
                            <>
                                {' · '}
                                <span className="today-route-time">{time}</span>
                            </>
                        )}
                        {estimate && (
                            <>
                                <br />
                                <span>{estimate}</span>
                                {/* His timing on the estimate's line: a long refusal still fits one screen. */}
                                {time && (
                                    <>
                                        {' · '}
                                        <span className="today-route-time">{time}</span>
                                    </>
                                )}
                            </>
                        )}
                    </>
                )}
            </li>,
            // Under the route row: when to leave to carry the tide over its shallow bits.
            ...(leave
                ? [
                      <li key="leave" ref={leaveLi} data-leave={said ? '' : 'checking'}>
                          {folded ? (
                              <details className="today-leave-more">
                                  <summary>{said!.text.slice(0, -said!.more!.length - 1)}</summary> {said!.more}
                              </details>
                          ) : (
                              (said?.text ?? 'Checking the tide on the way…')
                          )}
                      </li>,
                  ]
                : []),
            ...(time && routed && !leave
                ? [
                      <li key="time" className="today-route-time">
                          {time}
                      </li>,
                  ]
                : []),
        );
    }
    if (marina) items.push(<li key="marina">{LEAVING_MARINA}</li>);

    return (
        <TodayModal
            title={detail.title}
            sub={detail.sub}
            onClose={onBack}
            className="today-detail"
            layer={asking ? 'modal' : 'nested'}
            active={!asking}
            hidden={hidden}
            footer={
                <div className="today-actions">
                    {/* One main button, by the route's state (127-PYD-3): never a straight line. */}
                    <button
                        ref={main}
                        type="button"
                        className="today-button today-primary"
                        disabled={toRoute && busy}
                        onClick={() =>
                            toRoute
                                ? route!.onRoute(departure)
                                : routed
                                  ? route!.onShow(departure)
                                  : onPlot(
                                        departure,
                                        state?.kind === 'no-route' ? state.words : (route?.blocked?.words ?? ''),
                                    )
                        }
                    >
                        {toRoute
                            ? busy
                                ? 'Finding the way…'
                                : 'Route round the land'
                            : routed
                              ? 'Show route on chart'
                              : candidate.distance.basis === 'saved'
                                ? 'Plot your saved route'
                                : 'Plot by hand'}
                    </button>
                    <button type="button" className="today-button" onClick={onBack}>
                        Back
                    </button>
                </div>
            }
        >
            {/* The plan (132-PYD-8): its level, the way, the times big and when to leave; beside it in phone
                landscape, its facts, its notes and the rest. */}
            <div className="today-plan">
                {verdict && (
                    <p className="today-level" data-level={level}>
                        {verdict}
                    </p>
                )}
                {items.length > 0 && (
                    <ul aria-label="The way" className="today-rows">
                        {items}
                    </ul>
                )}
                {detail.times.length > 0 ? (
                    <ol aria-label="Times" className="today-times">
                        {detail.times.map((time) => (
                            <li key={time.label}>
                                <span className="today-times-label">{time.label}</span>{' '}
                                <span className="today-times-at">{time.at}</span>{' '}
                                <span className="today-times-note">{time.note}</span>
                            </li>
                        ))}
                    </ol>
                ) : (
                    // No times: why, where they would be.
                    !plan?.weatherLoaded && (
                        <p className="today-untimed">
                            {row.pending
                                ? 'Checking the weather along the way…'
                                : plan
                                  ? "Weather not checked: the forecast along the way didn't load."
                                  : 'Weather not checked: no forecast loaded.'}
                        </p>
                    )
                )}
                {row.along && <p className="today-untimed">{row.along}</p>}
                {detail.chips.length > 0 && (
                    <div role="group" aria-label="Leave at" className="today-days today-leave">
                        {detail.chips.map((chip) => (
                            <button
                                key={chip.ms}
                                type="button"
                                className="today-chip"
                                aria-pressed={chip.ms === chosen?.departureMs}
                                onClick={() => setChosenMs(chip.ms)}
                            >
                                {chip.label}
                                {chip.best ? ' best' : ''}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className="today-plan" ref={glance}>
                <ul aria-label="At a glance" className="today-glance">
                    {detail.facts.map((fact, i) => (
                        <li key={fact}>
                            {/* The first fact is the shelter word: beside it, which way the land shelters her. */}
                            {i === 0 && candidate.fetchLandNM && (
                                <span className="today-rose">
                                    <Suspense fallback={null}>
                                        <ShelterRose table={candidate.fetchLandNM} />
                                    </Suspense>
                                </span>
                            )}
                            {fact}
                        </li>
                    ))}
                    {notes.length > 0 && <li data-notes="">Local notes</li>}
                </ul>
                {/* Cautions, often (sharks, reef markers): whole, never folded away. */}
                {(notes.length > 0 || landingRow) && (
                    <ul aria-label="Local notes" className="today-rows">
                        {notes.map((note) => (
                            <li key={note} data-parks="">
                                {note}
                            </li>
                        ))}
                        {landingRow && <li>{landingRow}</li>}
                    </ul>
                )}
                {/* The way in a picture, under the facts it draws (132-PYD-9): the routed line only once routed. */}
                {pic > 0 && (
                    <div className="today-pic" style={{ width: 2 * pic, height: pic }}>
                        <Suspense fallback={null}>
                            <StopMap
                                start={start}
                                stop={candidate}
                                route={state?.kind === 'routed' ? state.leg.route.points : null}
                                coastline={coastline}
                                wind={plan?.weatherLoaded ? (chosen?.out ?? null) : null}
                            />
                        </Suspense>
                    </div>
                )}
                {rest.length > 0 && (
                    <details className="today-how" onToggle={resized}>
                        <summary>How each time was worked out</summary>
                        <ul aria-label="How the day goes" className="today-rows">
                            {rest.map((text) => (
                                <li key={text} data-why={text === row.why || undefined}>
                                    {text}
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
                <p className="today-footnote">
                    {detail.footnote}
                    {said?.footnote ? ` ${said.footnote}` : ''}
                </p>
            </div>
        </TodayModal>
    );
}
