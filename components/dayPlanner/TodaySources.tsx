import React, { useState } from 'react';
import { ComfortQuickConfig } from '../passage/ComfortQuickConfig';
import { PASSAGE_MODEL_CHOICES } from '../passage/PassageModelModal';
import { openExternalUrl } from '../../services/externalLinks';
import { COMPARE_MODELS, forecastDataCredit } from '../../services/weather/forecastModels';
import type { OfficialWarningsSource } from '../../utils/officialWarningsSource';
import {
    addDays,
    hhmm,
    limitsLine,
    wallTime,
    weekdayShort,
    type DayPlanLimits,
    type DayPlanView,
    type StopLegs,
} from '../../services/dayPlanner/today';
import type { RouteWindModels, TodayBase } from '../../services/dayPlanner/todayLoader';
import { TodayModal } from './TodayModal';

/** The short names the card's credit line uses; the full licence credit is in Sources. */
const SHORT_PROVIDER: Record<string, string> = {
    'UK Met Office': 'UKMO',
    'Environment and Climate Change Canada': 'ECCC',
};

const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

/** The providers whose models answered at the place. */
export function answeredProviders(base: TodayBase | null): string[] {
    return unique(base?.atmos?.models.map((m) => m.provider) ?? []);
}

/** Screen 1's credit: "Forecast: ECMWF, DWD, UKMO, JMA · Waves: Météo-France · Not a clearance". */
export function shortCredit(base: TodayBase | null): string {
    const providers = answeredProviders(base).map((p) => SHORT_PROVIDER[p] ?? p);
    const forecast = providers.length ? `Forecast: ${providers.join(', ')}` : 'No forecast loaded';
    return `${forecast} · Waves: Météo-France · Not a clearance`;
}

/** Which of the seven models answered for the chosen day, by name. */
function modelsForDay(base: TodayBase, view: DayPlanView | null) {
    const date = view?.date;
    const from = date ? wallTime(date, 0, 0, base.zone) : -Infinity;
    const to = date ? wallTime(addDays(date, 1), 0, 0, base.zone) : Infinity;
    const atmos = base.atmos;
    const answered = new Set(
        (atmos?.models ?? [])
            .filter((m) =>
                atmos!.times.some((t, i) => t >= from && t < to && typeof m.values.wind_speed_10m?.[i] === 'number'),
            )
            .map((m) => m.id),
    );
    return {
        names: COMPARE_MODELS.map((m) => m.label),
        answered: COMPARE_MODELS.filter((m) => answered.has(m.id)).length,
        missing: COMPARE_MODELS.filter((m) => !answered.has(m.id)).map((m) => m.label),
    };
}

/**
 * Plan Your Day: "Sources and limits" (build 124). One screen in place of the
 * old planner's fifteen disclaimers: whose limits these are (editable here,
 * the Comfort settings themselves), which models answered, every source and
 * its credit, what is NOT checked, and the official warnings for the place.
 */
export function TodaySources({
    base,
    view,
    limits,
    legs,
    wind,
    warnings,
    onClose,
}: {
    base: TodayBase;
    view: DayPlanView | null;
    limits: DayPlanLimits;
    legs: ReadonlyMap<string, StopLegs>;
    wind: RouteWindModels;
    warnings: OfficialWarningsSource;
    onClose: () => void;
}) {
    const [changing, setChanging] = useState(false);
    const zone = base.zone;
    const day = view ? (view.isToday ? 'today' : weekdayShort(view.date, zone)) : 'today';
    const models = modelsForDay(base, view);
    // The route models that answered for the stops shown, credited with the rest.
    const routeAnswered = unique(
        [...legs.values()].flatMap((l) =>
            l.spread ? Object.keys(l.spread.members) : l.headline ? [l.headline.model] : [],
        ),
    );
    const routeLabels = wind.ids.filter((id) => routeAnswered.includes(id)).map((id) => wind.labels[id] ?? id);
    const routeProviders = PASSAGE_MODEL_CHOICES.filter((c) => routeAnswered.includes(c.openMeteoModel)).map(
        (c) => c.provider,
    );
    const credit = forecastDataCredit(unique([...answeredProviders(base), ...routeProviders]));
    const candidates = base.places?.candidates ?? [];
    const notices = view ? [view.notices.top, ...view.notices.rest].filter((n) => n !== null) : [];

    return (
        <TodayModal title="Sources and limits" onClose={onClose} className="today-list-card">
            <h3 className="today-h3">Your limits</h3>
            <p data-testid="day-plan-limits">{limitsLine(limits)}</p>
            <button
                type="button"
                className="today-button"
                aria-expanded={changing}
                onClick={() => setChanging((v) => !v)}
            >
                Change
            </button>
            {changing && <ComfortQuickConfig expanded onExpandedChange={setChanging} />}

            <h3 className="today-h3">Models</h3>
            {base.atmos ? (
                <p>
                    {models.names.join(', ')} — {models.answered} of {models.names.length} answered for {day}
                </p>
            ) : (
                <p>
                    {base.weather === 'loading'
                        ? 'Still asking the models.'
                        : base.weather === 'offline'
                          ? 'Offline: no model asked.'
                          : 'No model answered.'}
                </p>
            )}
            {base.atmos && models.missing.length > 0 && <p>No answer from {models.missing.join(', ')}.</p>}
            {routeLabels.length > 0 && <p>Along the way to the stops: {routeLabels.join(', ')}.</p>}

            <h3 className="today-h3">Credits</h3>
            <ul className="today-credits">
                {credit && <li>{credit}</li>}
                <li>Waves: Météo-France (MFWAM)</li>
                <li>
                    {base.tidesStatus === 'ok'
                        ? `Tides: WorldTides, ${base.tideStation ?? 'nearest station'}, metres above LAT, approx. ±0.3 m`
                        : 'Tides: no prediction here'}
                </li>
                <li>Places: © OpenStreetMap contributors (ODbL)</li>
                {candidates.some((c) => c.source === 'atlas') && (
                    <li>Queensland anchorage atlas (OpenStreetMap + GBRMPA)</li>
                )}
                {candidates.some((c) => c.reviewed) && (
                    <li>Queensland Parks notes, CC BY 4.0, © State of Queensland</li>
                )}
                <li>Light: worked out on this phone</li>
                {base.weatherAtMs !== null && <li>Forecast {hhmm(base.weatherAtMs, zone)} · refreshes after 30 min</li>}
            </ul>

            {notices.length > 0 && (
                <>
                    <h3 className="today-h3">Notes</h3>
                    <ul className="today-credits">
                        {notices.map((n) => (
                            <li key={n.kind}>{n.text.replace(/ [›↗]$/, '')}</li>
                        ))}
                    </ul>
                </>
            )}

            <p>
                Not checked: depth and tide over the route, the marina approach, currents, holding, gusts funnelling
                round islands, reefs as shelter.
            </p>
            <button
                type="button"
                className="today-button"
                aria-label={`Official warnings: ${warnings.name}, opens outside the app`}
                onClick={() => void openExternalUrl(warnings.url)}
            >
                Official warnings: {warnings.name} ↗
            </button>
            <p className="today-footnote">A planning aid. Cautions, not blocks. Not a clearance.</p>
        </TodayModal>
    );
}
