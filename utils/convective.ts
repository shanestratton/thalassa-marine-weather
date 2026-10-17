/** Forecast context, never lightning detection or an official warning. Pure and shared with Edge. */
export const CONVECTIVE_MODELS = ['ecmwf_ifs025', 'dwd_icon', 'ukmo_global_deterministic_10km'] as const;
export type ConvectiveModel = (typeof CONVECTIVE_MODELS)[number];
export interface ConvectiveHour {
    at: number;
    code: number | null;
    cape: number | null;
    liftedIndex: number | null;
    inhibition: number | null;
    gustKts: number | null;
}
export interface ConvectiveMember {
    model: ConvectiveModel;
    /** Original forecast run, never the cache receipt clock. */
    runAt: number;
    hours: readonly ConvectiveHour[];
}
const HOUR = 3_600_000;
const bounded = (n: unknown, low: number, high: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
const thunder = (n: number | null) => n === 95 || n === 96 || n === 99;
const midpoint = (values: number[]): number | null => {
    values.sort((a, b) => a - b);
    return values.length
        ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
        : null;
};
export function freshConvectiveMembers(members: readonly ConvectiveMember[], now: number): ConvectiveMember[] {
    const seen = new Set<string>();
    return members.slice(0, 16).filter((member) => {
        if (
            !CONVECTIVE_MODELS.includes(member.model) ||
            seen.has(member.model) ||
            !bounded(member.runAt, now - 24 * HOUR, now)
        )
            return false;
        seen.add(member.model);
        return (
            member.hours.length <= 384 &&
            member.hours.every(
                (hour, i) =>
                    Number.isSafeInteger(hour.at) &&
                    hour.at % HOUR === 0 &&
                    (!i || hour.at > member.hours[i - 1].at) &&
                    (hour.code === null || (Number.isInteger(hour.code) && bounded(hour.code, 0, 99))) &&
                    (hour.cape === null || bounded(hour.cape, 0, 50_000)) &&
                    (hour.liftedIndex === null || bounded(hour.liftedIndex, -50, 50)) &&
                    (hour.inhibition === null || bounded(hour.inhibition, -5000, 5000)) &&
                    (hour.gustKts === null || bounded(hour.gustKts, 0, 325)),
            )
        );
    });
}
export interface ConvectiveContext {
    text: string;
    thunderModels: number;
    availableModels: number;
    /** Numeric derived context excludes UKMO, which is counted/named only. */
    cape: number | null;
    liftedIndex: number | null;
    inhibition: number | null;
    gustRangeKts: readonly [number, number] | null;
}
export function thunderModelWords(count: number, available: number): string {
    return available < 2
        ? `thunder agreement unknown (${count} of 3 show thunder; ${available} available)`
        : `thunder in ${count} of 3 models (${available} available)`;
}
export function convectiveContext(
    members: readonly ConvectiveMember[],
    at: number,
    latitude: number,
    now: number,
): ConvectiveContext {
    const rows = freshConvectiveMembers(members, now).flatMap((member) => {
        const row = member.hours.find((hour) => hour.at === at);
        return row ? [{ model: member.model, row }] : [];
    });
    const coded = rows.filter(({ row }) => row.code !== null);
    const count = coded.filter(({ row }) => thunder(row.code)).length;
    const quotable = rows.filter(({ model }) => model !== 'ukmo_global_deterministic_10km');
    const values = (key: 'cape' | 'liftedIndex' | 'inhibition' | 'gustKts') =>
        quotable.flatMap(({ row }) => (row[key] === null ? [] : [row[key]!]));
    const cape = midpoint(values('cape'));
    const liftedIndex = midpoint(values('liftedIndex'));
    const inhibition = midpoint(values('inhibition'));
    const gusts = values('gustKts');
    // A deliberately conservative *display* heuristic. Tropical background CAPE is often high.
    // It never triggers a push or predicts severity; codes from distinct models do that separately.
    const tropical = bounded(latitude, -23.5, 23.5);
    const raised = tropical ? 2500 : 1000;
    const strong = tropical ? 4000 : 2500;
    const energy =
        cape === null
            ? 'Instability unknown'
            : cape >= strong
              ? 'Strong energy for rising air'
              : cape >= raised
                ? 'Energy for rising air is elevated'
                : 'Limited energy for rising air in this forecast';
    const li =
        liftedIndex === null
            ? 'LI unavailable'
            : liftedIndex < 0
              ? 'LI also suggests unstable air'
              : 'LI does not add an instability signal';
    const cin =
        inhibition === null
            ? 'cap strength unknown'
            : Math.abs(inhibition) >= 100
              ? 'a cap may limit storm initiation'
              : 'little inhibition in this forecast';
    return {
        text: `${energy}; ${thunderModelWords(count, coded.length)}. ${li}; ${cin}. This does not predict lightning or storm severity.`,
        thunderModels: count,
        availableModels: coded.length,
        cape,
        liftedIndex,
        inhibition,
        gustRangeKts: gusts.length >= 2 ? [Math.min(...gusts), Math.max(...gusts)] : null,
    };
}
export interface ConsensusEvent {
    kind: 'storm' | 'gust';
    from: number;
    to: number;
    models: readonly ConvectiveModel[];
}
/** Same fixed three-hour UTC window as 129-07. Missing models/hours cannot vote. */
export function convectiveConsensus(
    members: readonly ConvectiveMember[],
    now: number,
    gustThresholdKts: number | null,
): ConsensusEvent[] {
    const fresh = freshConvectiveMembers(members, now);
    const events: ConsensusEvent[] = [];
    const first = Math.floor(now / HOUR) * HOUR;
    for (const kind of ['storm', 'gust'] as const) {
        if (kind === 'gust' && !bounded(gustThresholdKts, 1, 200)) continue;
        for (let from = first; from < now + 24 * HOUR; from += 3 * HOUR) {
            const to = Math.min(from + 3 * HOUR, now + 24 * HOUR);
            const models = fresh
                .filter((member) =>
                    member.hours.some(
                        (hour) =>
                            hour.at >= from &&
                            hour.at < to &&
                            hour.at + HOUR > now &&
                            (kind === 'storm'
                                ? thunder(hour.code)
                                : hour.gustKts !== null && hour.gustKts >= gustThresholdKts!),
                    ),
                )
                .map((member) => member.model);
            if (models.length >= 2) {
                events.push({ kind, from, to, models });
                break;
            }
        }
    }
    return events;
}
