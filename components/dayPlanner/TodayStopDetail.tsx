import React, { useEffect, useReducer, useRef, useState } from 'react';
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
    onAction: (action: StopRouteAction) => void;
}

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
 * "Plot on chart" sets the departure and opens the Manual plotter with
 * straight pins. Where routing is offered (127-PYD-2, his account in 127)
 * the main button is "Route round the land" until the route is in ("Plot on
 * chart" while a setting stands in the way): a route row says each stage
 * with its own seconds, then the routed distance and what the router found
 * (it is then the distance row), or why there is no route with the estimate
 * under it; the owner's timing line sits under it. Fits outright at normal text
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
    onPlot: (departureMs: number | null) => void;
    onBack: () => void;
    route?: StopRouteView | null;
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
    // Its own seconds while it routes, counted from the tap (Auto's provider sends words, not seconds).
    const [, tick] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [busy]);
    // The draft modal asks over this page: it steps down a layer while it does.
    const asking = !!useDraftConfirmRequest();
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
              leavingMarina,
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
                  ...(leavingMarina ? [LEAVING_MARINA] : []),
              ],
              footnote: 'No times without a forecast. Depth and tide over the route are not checked. Not a clearance.',
              chips: [] as { ms: number; label: string; best: boolean }[],
          };

    // A reviewed stop's own Parks notes stand out from the times around them, and the verdict in its level's colour.
    const notes = new Set(parksNotes(candidate));
    const level = (plan?.weatherLoaded ? chosen?.level : row.level) ?? 'unknown';
    const departure = plan?.weatherLoaded ? (chosen?.departureMs ?? null) : null;
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
            leavingMarina ? items.length - 1 : items.length,
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
            ...(time && routed
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
            footer={
                <div className="today-actions">
                    {/* One main button (127-PYD-3's states own it next): Route round the land until it is in. */}
                    <button
                        type="button"
                        className="today-button today-primary"
                        disabled={toRoute && busy}
                        onClick={() => (toRoute ? route?.onRoute(departure) : onPlot(departure))}
                    >
                        {toRoute ? 'Route round the land' : 'Plot on chart'}
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
            <p className="today-footnote">{detail.footnote}</p>
        </TodayModal>
    );
}
