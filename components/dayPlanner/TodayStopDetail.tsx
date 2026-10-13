import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { PassageSpeedModel } from '../../services/passagePlan';
import type { LatLon } from '../../services/dayPlanner/places';
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
 * Plan Your Day, screen 2 (build 124): one stop, and how each time on screen
 * 1 was worked out — leave and there, ashore or at anchor, the landing tide
 * where Queensland Parks name one, home, the light, the sea, the distance and
 * how it was measured, and the marina line when she starts in one. A
 * reviewed stop's own Parks notes (Cid Harbour's sharks) sit under the stay.
 * Since 127-PYD-1 it opens on its verdict when it is not Inside ("✕ Over your
 * limits: SE 30 kn on the way"), drawn in its level's colour; since 127-PYD-4
 * the next row says why it is here ("In the lee of the NE breeze · sailing
 * both ways · 3 h 29 under way"), and a place with no local notes says what
 * it is and what her charts say at its pin.
 * The leave chips are the best departure's window; a tap recomputes in place.
 * Where routing is offered (127-PYD-2, his account in 127) a route row says
 * each stage with its own seconds, then the routed distance and what the
 * router found (it is then the distance row), or why there is no route with
 * the estimate under it; the owner's timing line sits under it. The one main
 * button follows the route (127-PYD-3), and never plots a straight line:
 * "Route round the land", "Finding the way…", then "Show route on chart"
 * (Auto's chart over this page, at the chosen leave); "Plot your saved route"
 * for her own line; else "Plot by hand", her start and the stop as two marks
 * with why there is no route. Each sets the departure. Fits outright at normal text
 * from 375 × 667; at 320 × 568 a reviewed stop's notes may push the later
 * rows into a scroll (the first note in view as it opens), and anything may
 * scroll at large text.
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
}: {
    row: StopRow;
    view: DayPlanView;
    stay: StayOption;
    speed: PassageSpeedModel;
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
    const detail = plan?.weatherLoaded
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
              rows: [
                  // Over on the wind at the place, even with no route weather: its verdict first.
                  ...(row.level === 'over' ? [stopVerdict('over', row.reason)] : []),
                  ...(row.why ? [row.why] : []),
                  row.pending
                      ? 'Checking the weather along the way…'
                      : plan
                        ? "Weather not checked: the forecast along the way didn't load."
                        : 'Weather not checked: no forecast loaded.',
                  ...(row.place ? [row.place] : []),
                  ...parksNotes(candidate),
                  // Routed, the route row is the distance row.
                  ...(routed ? [] : [distanceLine(candidate.distance)]),
                  ...(marina ? [LEAVING_MARINA] : []),
              ],
              footnote: 'No times without a forecast. Depth and tide over the route are not checked. Not a clearance.',
              chips: [] as { ms: number; label: string; best: boolean }[],
          };

    // A place beyond the five opens on the area wind's times, under them its weather along the way, loading
    // or failed; one in Not today with times (a gap in a day over her limits) opens on why (127-PYD-5).
    if (row.along) detail.rows.splice(detail.rows.findIndex((t) => t.startsWith('Leave ')) + 1, 0, row.along);
    const gap = row.line2Reason ? undefined : view.notToday.find((r) => r.id === row.id)?.reason;
    if (gap) detail.rows.unshift(`✕ ${gap[0].toUpperCase()}${gap.slice(1)}`);
    // A reviewed stop's own Parks notes stand out from the times around them, and the verdict in its level's colour.
    const notes = new Set(parksNotes(candidate));
    const level = gap ? 'over' : ((plan?.weatherLoaded ? chosen?.level : row.level) ?? 'unknown');
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
    useLayoutEffect(() => {
        const body = leaveLi.current?.closest('.today-body');
        if (!foldKey || !body) return;
        const over = body.scrollHeight - body.clientHeight > 1;
        if (fold?.key !== foldKey) setFold({ key: foldKey, on: over });
        else if (fold.on && over) setFold({ key: foldKey, on: false });
    }, [foldKey, fold]);
    const folded = !!foldKey && fold?.key === foldKey && fold.on;
    // Blocked (other than a draft to confirm), she can still plot by hand: the row says what routing needs.
    const toRoute = !!route && (busy || (!state && (!route.blocked || route.blocked.action === 'confirm-draft')));
    const items = detail.rows
        .filter((text) => text !== estimate)
        .map((text, i) => (
            <li
                key={text}
                data-parks={notes.has(text) || undefined}
                data-why={text === row.why || undefined}
                data-level={i === 0 && /^[✕≈?] /.test(text) ? level : undefined}
            >
                {text}
            </li>
        ));
    if (route) {
        const blocked = state ? null : route.blocked;
        const words = !state
            ? (blocked?.words ?? STOP_ROUTE_WORDS.notYet)
            : state.kind === 'routed'
              ? routeRowWords(state.proposal.engine, state.leg.nm)
              : state.words;
        const secs = state && 'since' in state ? Math.floor((Date.now() - state.since) / 1000) : 0;
        const time = route.owner && state && 'wallMs' in state ? routeTimingLine(state) : null;
        // Where the distance row is (or was): before the marina line, else last.
        items.splice(
            marina ? items.length - 1 : items.length,
            0,
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
            <ul aria-label="How the day goes" className="today-rows">
                {items}
            </ul>
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
            <p className="today-footnote">
                {detail.footnote}
                {said?.footnote ? ` ${said.footnote}` : ''}
            </p>
        </TodayModal>
    );
}
