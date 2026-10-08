import React, { useEffect, useRef, useState } from 'react';
import type { PassageSpeedModel } from '../../services/passagePlan';
import type { LatLon } from '../../services/dayPlanner/places';
import {
    distanceLine,
    shortDate,
    stopDetail,
    wallTime,
    zoneAbbrev,
    type DayPlanView,
    type DayWindow,
    type DepartureEval,
    type StayOption,
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
 * how it was measured, and the marina line when she starts in one. The leave
 * chips are the best departure's window; a tap recomputes in place. "Plot on
 * chart" sets the departure and opens the Manual plotter with straight pins.
 * Fits 320 × 568 at normal text; it scrolls only at large text.
 */
export function TodayStopDetail({
    row,
    view,
    stay,
    speed,
    polarIsOwn,
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
    const detail = plan
        ? stopDetail({
              plan,
              departure: chosen,
              stay,
              window,
              speed,
              polarIsOwn,
              leavingMarina,
              landing: loadLanding ? (landing ?? undefined) : undefined,
          })
        : {
              title: row.name,
              sub: `${shortDate(window.date, zone)} · times in ${zoneAbbrev(window.firstLightMs ?? wallTime(window.date, 12, 0, zone), zone)}`,
              rows: [
                  row.pending ? 'Checking the weather along the way…' : 'Weather not checked: no forecast loaded.',
                  distanceLine(candidate.distance),
                  ...(leavingMarina
                      ? ['Leaving a marina: check its approach depth against the tide before you go.']
                      : []),
              ],
              footnote: 'No times without a forecast. Depth and tide over the route are not checked. Not a clearance.',
              chips: [] as { ms: number; label: string; best: boolean }[],
          };

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
                        onClick={() => onPlot(chosen?.departureMs ?? null)}
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
                {detail.rows.map((text) => (
                    <li key={text}>{text}</li>
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
