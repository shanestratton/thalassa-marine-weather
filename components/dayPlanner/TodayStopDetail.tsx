import React, { useEffect, useRef, useState } from 'react';
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
import { TodayModal } from './TodayModal';

type Landing = { fromMs: number; toMs: number } | 'no-curve';

/** The landing window at a reviewed stop (todayLoader.loadLandingWindow), asked only when its detail opens. */
export type LandingLoader = (
    stop: LatLon,
    window: DayWindow,
    stay: { arriveMs: number | null; stayEndMs: number | null } | null,
    signal: AbortSignal,
) => Promise<Landing>;

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
 * straight pins. Fits outright at normal text from 375 × 667; at 320 × 568 a
 * reviewed stop's notes may push the later rows into a scroll (the first
 * note in view as it opens), and anything may scroll at large text.
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
                  distanceLine(candidate.distance),
                  ...(leavingMarina ? [LEAVING_MARINA] : []),
              ],
              footnote: 'No times without a forecast. Depth and tide over the route are not checked. Not a clearance.',
              chips: [] as { ms: number; label: string; best: boolean }[],
          };

    // A reviewed stop's own Parks notes stand out from the times around them, and the verdict in its level's colour.
    const notes = new Set(parksNotes(candidate));
    const level = (plan?.weatherLoaded ? chosen?.level : row.level) ?? 'unknown';

    return (
        <TodayModal
            title={detail.title}
            sub={detail.sub}
            onClose={onBack}
            className="today-detail"
            footer={
                <div className="today-actions">
                    <button
                        type="button"
                        className="today-button today-primary"
                        onClick={() => onPlot(plan?.weatherLoaded ? (chosen?.departureMs ?? null) : null)}
                    >
                        Plot on chart
                    </button>
                    <button type="button" className="today-button" onClick={onBack}>
                        Back
                    </button>
                </div>
            }
        >
            <ul aria-label="How the day goes" className="today-rows">
                {detail.rows.map((text, i) => (
                    <li
                        key={text}
                        data-parks={notes.has(text) || undefined}
                        data-why={text === row.why || undefined}
                        data-level={i === 0 && /^[✕≈?] /.test(text) ? level : undefined}
                    >
                        {text}
                    </li>
                ))}
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
