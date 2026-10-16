/** Deterministic briefing data shared by the card, text share and scheduled push. No network or clock reads. */
import { thunderModelWords, type ConvectiveContext } from '../../utils/convective.ts';
import { weatherWatchLocalSlot } from '../../utils/weatherWatch.ts';
export interface BriefingInput {
    place: string;
    zone: string;
    now: number;
    forecastAt: number | null;
    /** Already-computed Plan Your Day words; no second routing/weather evaluation. */
    dayPlan?: { headline: { text: string }; date: string } | null;
    official: { state: 'live' | 'none' | 'unavailable'; headline?: string; expiresAt?: number; checkedAt?: number };
    convective?: ConvectiveContext | null;
    tide?: { text: string; source: string; datum: string | null; navigationUse: boolean } | null;
    light?: { first: number | null; last: number | null } | null;
    models: readonly string[];
}
export interface Briefing {
    schema: 1;
    place: string;
    zone: string;
    composedAt: number;
    forecastAt: number | null;
    lines: readonly [string, string];
    detail: readonly string[];
    models: readonly string[];
}
const safe = (text: string, limit = 180) =>
    text
        .replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, limit);
export function composeBriefing(input: BriefingInput): Briefing {
    const valid =
        input.forecastAt !== null &&
        Number.isFinite(input.forecastAt) &&
        input.forecastAt <= input.now &&
        input.now - input.forecastAt <= 24 * 3_600_000;
    const live =
        input.official.state === 'live' &&
        !!input.official.headline &&
        (input.official.expiresAt !== undefined
            ? input.official.expiresAt > input.now
            : input.official.checkedAt !== undefined &&
              input.official.checkedAt <= input.now &&
              input.now - input.official.checkedAt <= 5 * 60_000);
    const official = live
        ? `Official warning: ${safe(input.official.headline!)}`
        : input.official.state === 'none'
          ? 'No active official warning in the checked feed; check the issuer.'
          : 'Official warnings not checked; check the issuer.';
    const forecast = !valid
        ? 'Fresh forecast unavailable; day verdict unknown.'
        : input.dayPlan && input.dayPlan.date === weatherWatchLocalSlot(input.now, input.zone)?.day
          ? safe(input.dayPlan.headline.text)
          : input.convective
            ? `${input.convective.gustRangeKts ? `Peak gusts ${input.convective.gustRangeKts.map(Math.round).join('–')} kt across comparable models; ` : ''}${thunderModelWords(input.convective.thunderModels, input.convective.availableModels)}. Day verdict unknown.`
            : 'Day verdict unavailable.';
    const time = (at: number | null) =>
        at !== null && Number.isFinite(at)
            ? new Intl.DateTimeFormat('en-GB', {
                  timeZone: input.zone,
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
              }).format(at)
            : 'unknown';
    const models = [...new Set(input.models.map((model) => safe(model, 64)))].slice(0, 8);
    const tide = input.tide
        ? `${safe(input.tide.text)} · ${safe(input.tide.source, 64)} · datum ${safe(input.tide.datum ?? 'unknown', 32)}${input.tide.navigationUse ? '' : ' · informational only'}`
        : 'Tide unknown; no clearance judgement.';
    return {
        schema: 1,
        place: safe(input.place, 64),
        zone: input.zone,
        composedAt: input.now,
        forecastAt: valid ? input.forecastAt : null,
        lines: [official, forecast],
        detail: [
            ...(input.convective ? [input.convective.text] : []),
            tide,
            `Civil first light ${time(input.light?.first ?? null)}; last light ${time(input.light?.last ?? null)} (${input.zone}).`,
            `Forecast data: ${models.join(', ') || 'unavailable'}. UKMO counted, never quoted.`,
            'Forecast guidance, not an official warning or a navigation clearance.',
        ],
        models,
    };
}
