/**
 * Is a forecast alert already covered by an official warning in force at the
 * same place (129-06's predicate, decision C of 129-07)? Covered means an
 * official warning of the same type, at least as strong: a Gale Warning
 * covers gale-force and strong wind but not storm-force; a Small Craft
 * Advisory covers strong wind and rough seas, never gale-force. Types and
 * strengths come from the issuer's own vocabulary (../official-alerts/
 * classify.ts).
 *
 * One predicate, two callers: utils/officialWarningCover.ts maps the app's
 * "Forecast: …" texts onto it, and check-weather-alerts drops a push it
 * covers (lookahead.ts), since the official warning already says it in the
 * issuer's words.
 */
import { type ClassifiableInfo, classifyOfficialEvent, type OfficialHazard } from '../official-alerts/classify.ts';

export interface OfficialForCover {
    /** official_alerts.id, where the caller has it: matched to the account's deliveries (check-weather-alerts). */
    id?: number;
    provider: string;
    infos: readonly ClassifiableInfo[];
}

/** What a forecast alert reads, on the classifier's scale; null for a type no warning has. */
export type ForecastHazard = readonly [OfficialHazard, number] | null | undefined;

export function officialCovers(want: ForecastHazard, official: readonly OfficialForCover[]): boolean {
    if (!want) return false;
    return official.some((o) =>
        o.infos.some((info) =>
            classifyOfficialEvent(o.provider, info).hazards.some(([h, n]) => h === want[0] && n >= want[1])
        )
    );
}
