/** Bounded private subjective preference. No identity, storage or service dependency;
 * safe as an explicit routing-worker input. This is never weather skill. */
export const PERSONAL_COMFORT_INPUTS = ['size', 'steepness', 'pitching', 'cross'] as const;
export type PersonalComfortInput = (typeof PERSONAL_COMFORT_INPUTS)[number];
export interface ComfortPreference {
    schema: 1;
    profile: { type: 'sail' | 'power'; length: number; revision: number };
    adjustments: Record<PersonalComfortInput, -1 | 0 | 1>;
    qualified: Record<PersonalComfortInput, { reports: number; voyages: number }>;
}
export function comfortPreferenceLabel(
    preference: ComfortPreference | null | undefined,
    input: string | null | undefined,
): string {
    const count =
        input && PERSONAL_COMFORT_INPUTS.includes(input as PersonalComfortInput)
            ? preference?.qualified[input as PersonalComfortInput]
            : null;
    return count && count.reports >= 6 && count.voyages >= 3 ? 'personal preference beta' : 'uncalibrated beta';
}
export function validComfortPreference(
    value: unknown,
    vessel?: { type: string; length: number } | null,
): value is ComfortPreference {
    if (!value || typeof value !== 'object' || !vessel) return false;
    const p = value as Partial<ComfortPreference>;
    if (
        p.schema !== 1 ||
        !p.profile ||
        !['sail', 'power'].includes(p.profile.type) ||
        p.profile.type !== vessel.type ||
        p.profile.length !== vessel.length ||
        !Number.isFinite(p.profile.length) ||
        !(p.profile.length > 0 && p.profile.length <= 1000) ||
        !Number.isSafeInteger(p.profile.revision) ||
        p.profile.revision < 1 ||
        !p.adjustments ||
        !p.qualified
    )
        return false;
    return PERSONAL_COMFORT_INPUTS.every((key) => {
        const count = p.qualified![key],
            adjustment = p.adjustments![key];
        return (
            [-1, 0, 1].includes(adjustment) &&
            !!count &&
            Number.isInteger(count.reports) &&
            count.reports >= 0 &&
            count.reports <= 120 &&
            Number.isInteger(count.voyages) &&
            count.voyages >= 0 &&
            count.voyages <= count.reports &&
            (adjustment === 0 || (count.reports >= 6 && count.voyages >= 3))
        );
    });
}
