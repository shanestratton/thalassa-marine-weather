/**
 * The Crew & Float Plan card's words for its count (129-14, Shane 2026-10-14:
 * "the crew and float plan card says two crew. But there is actually three.
 * 2+1 invitee").
 *
 * The count is everyone on the crew register, pending invitees included
 * (services/crew/floatPlanPeople.ts crewRegisterCount); the subtitle says how
 * many of them are still invited. One place for the words, so the card and
 * the layout test that sets them at their longest (browser-tests/
 * menu-pages-fit.spec.ts) cannot drift apart.
 */

/** The value on the card's title line: "3 crew". */
export function crewCountWords(crew: number): string {
    return `${crew} crew`;
}

/**
 * The subtitle while some of them have not answered: "1 invited", the plan's
 * own words. Short enough to stay whole on a 320 pt phone in large text, where
 * the row's one line holds about 120 px ("1 invited, yet to accept" needed 232
 * and was cut to "1 invited, y…"): browser-tests/menu-pages-fit.spec.ts.
 */
export function crewInvitedWords(invited: number): string {
    return `${invited} invited`;
}
