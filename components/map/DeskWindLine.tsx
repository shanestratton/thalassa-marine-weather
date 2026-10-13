/**
 * The desk planner's wind panel, its two desk-only parts (127-DESKMAP-b):
 * the wind at the trace's start time, and one plain line saying whether the
 * models agree where he is planning. The weather rules: "Where models
 * disagree, say so"; never a single number as fact when they split.
 */
import { useEffect, useRef } from 'react';
import { AGREEMENT_GLYPH, AGREEMENT_WORDS } from '../../services/weather/dayAgreement';
import { forecastDataCredit } from '../../services/weather/forecastModels';
import { useWindAgreementAt } from '../../hooks/useWindAgreementAt';
import { localNoon } from '../../utils/celestial';
import { resolveTimeZone } from '../../utils/timezone';
import { msToLocalInput } from './mapHubHelpers';
import { windFrameForForecastHour } from './windTimeAxis';

interface HandOffWeather {
    windReady: boolean;
    windForecastHours?: number[];
    windState?: { grid?: { refTime?: string } | null } | null;
    setWindHour: (frame: number) => void;
    followWindNow: () => void;
}

/**
 * With a start time set on the trace, the scrubber opens at that hour: when
 * the desk's wind comes on, and again whenever the start changes. A start
 * moved past the forecast, or cleared back to now, hands the timeline back to
 * now. A hand on the scrubber wins afterwards. Re-applied each minute until
 * then, or the timeline's five-minute hand-scrub cooldown would hand it back
 * to now. The label is in the DEPART row's own clock (msToLocalInput), so the
 * two never show different times for one start.
 */
export function useWindStartHandOff(weather: HandOffWeather, startMs: number | null | undefined) {
    const refMs = Date.parse(weather.windState?.grid?.refTime ?? '');
    const hours = weather.windForecastHours ?? [];
    const at =
        startMs != null && weather.windReady && Number.isFinite(refMs)
            ? windFrameForForecastHour(hours, (startMs - refMs) / 3_600_000)
            : null;
    const frame = at && !at.beyond ? Math.round(at.frame * 10) / 10 : null;
    // The start whose hand-off a hand on the scrubber has overruled.
    const overruled = useRef<number | null | undefined>(undefined);
    // The timeline is on a start this hook put it on, not overruled.
    const applied = useRef(false);
    const { setWindHour, followWindNow } = weather;
    useEffect(() => {
        if (frame === null) {
            if (applied.current) followWindNow();
            applied.current = false;
            return;
        }
        if (overruled.current === startMs) return;
        applied.current = true;
        setWindHour(frame);
        const keep = setInterval(() => overruled.current !== startMs && setWindHour(frame), 60_000);
        return () => clearInterval(keep);
    }, [frame, startMs, setWindHour, followWindNow]);
    return {
        frame,
        /** The start is after the grid's last hour: the scrubber stays at now. */
        past: !!at?.beyond && at.frame > 0,
        label: frame === null ? null : `At your ${msToLocalInput(startMs!).slice(11)} start`,
        overrule: () => {
            overruled.current = startMs;
            applied.current = false;
        },
    };
}

const TONE = { agree: 'text-emerald-300', some: 'text-amber-300', split: 'text-red-300' } as const;

/**
 * "Models split here Saturday: strongest wind 12-28 kt across 5 of 7 models",
 * at `point` (the trace's first pin, "at your start", else the still map
 * centre, "here") for the day holding the scrubbed hour. The Glass day card's
 * chain and thresholds (useWindAgreementAt), so the two can never disagree.
 * Under it, every model compared, each under its own licence (the weather
 * rules: "Name whichever models you actually used"). Mounted only while the
 * panel is open; a refusal (a 429 among them) silences it until the panel
 * opens again.
 */
export function DeskWindAgreement({
    point,
    pinned,
    validMs,
}: {
    point: { lat: number; lon: number } | null;
    pinned?: boolean;
    validMs: number | null;
}) {
    // The day holding the scrubbed hour, by an instant inside the comparison:
    // its local noon, or for today the current hour (the comparison starts
    // now). While a model's grid loads there is no scrubbed hour: the last
    // one holds, so the line never flickers to "not known". Days are the
    // place's own, as the comparison cuts them.
    const timeZone = point ? resolveTimeZone(point.lat, point.lon) : undefined;
    const held = useRef<number | null>(null);
    if (validMs !== null) held.current = validMs;
    const hourNow = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const dayMs =
        held.current === null ? hourNow : Math.max(localNoon(new Date(held.current), timeZone).getTime(), hourNow);
    const verdict = useWindAgreementAt(point, dayMs, true, undefined, true);
    if (!point) return null;
    const where = pinned ? 'at your start' : 'here';
    const level = verdict?.level;
    const range = verdict?.speedRange;
    const day =
        verdict &&
        new Date(`${verdict.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    const credit = level && range ? forecastDataCredit(verdict.providers, 'Compared via Open-Meteo') : null;
    return (
        <>
            <p
                data-testid="desk-wind-agreement"
                role="status"
                className="flex items-start gap-1.5 px-2 text-[11px] leading-snug text-slate-300"
            >
                {level && (
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`mt-px h-3.5 w-3.5 shrink-0 ${TONE[level]}`}
                        aria-hidden="true"
                    >
                        <path d={AGREEMENT_GLYPH[level]} />
                    </svg>
                )}
                <span>
                    {verdict === undefined
                        ? `Comparing the models ${where}…`
                        : level && range
                          ? `${AGREEMENT_WORDS[level]} ${where} ${day}: strongest wind ${Math.round(range[0])}-${Math.round(range[1])} kt across ${verdict.thin ? 'only ' : ''}${verdict.members} of ${verdict.peak} models`
                          : `Model agreement not known ${where}`}
                </span>
            </p>
            {credit && (
                <p data-testid="desk-wind-compared" className="px-2 text-[10px] leading-snug text-slate-400">
                    {credit}
                </p>
            )}
        </>
    );
}
