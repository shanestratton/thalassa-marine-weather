/** Private instrument agreement only; no live forecast choice, alarm or navigation adoption. */
import { OWN_BOAT_MODELS, OWN_BOAT_SKILL } from '../ownBoatSkillWire.js';
import type { PrivateWindSample } from './store.js';
import type { VerifiedWindIssue } from './forecast.js';
const HOUR = 3600_000;
export const OWN_SKILL_LEADS = ['0-6h', '6-24h', '24-48h', '48-72h'] as const;
const BOUNDS = [
    [0, 6],
    [6, 24],
    [24, 48],
    [48, 72],
] as const;
export interface ModelScore {
    pairs: number;
    effectiveN: number;
    spanHours: number;
    status: 'warming' | 'ready';
    mae: number | null;
    medianLeadHours: number | null;
}
const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b),
        n = s.length;
    return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
/** Same hourly lag-1 conservative rule as issued station evidence; constants never inflate N. */
export function ownWindEffectiveN(pairs: readonly (readonly [number, number])[]): number {
    const adjacent: [number, number][] = [];
    for (let i = 1; i < pairs.length; i++)
        if (pairs[i][0] - pairs[i - 1][0] === HOUR) adjacent.push([pairs[i - 1][1], pairs[i][1]]);
    if (pairs.length < 3 || adjacent.length < 2) return Math.min(pairs.length, 1);
    const mx = adjacent.reduce((s, p) => s + p[0], 0) / adjacent.length,
        my = adjacent.reduce((s, p) => s + p[1], 0) / adjacent.length;
    let vx = 0,
        vy = 0,
        xy = 0;
    for (const [x, y] of adjacent) {
        vx += (x - mx) ** 2;
        vy += (y - my) ** 2;
        xy += (x - mx) * (y - my);
    }
    if (vx <= 1e-12 || vy <= 1e-12) return 1;
    const rho = Math.min(1, Math.max(0, xy / Math.sqrt(vx * vy)));
    return Math.max(1, Math.min(pairs.length, Math.floor((pairs.length * (1 - rho)) / (1 + rho))));
}
export function scoreOwnWind(
    samples: readonly PrivateWindSample[],
    issues: readonly VerifiedWindIssue[],
    now: number,
    station: string,
) {
    if (samples.length > OWN_BOAT_SKILL.sampleCount || issues.length > 1024 || !Number.isSafeInteger(now))
        throw Error('Private scoring cohort bound');
    const observations = new Map<number, PrivateWindSample>();
    for (const sample of samples) {
        const hour = Math.round(sample.at / HOUR) * HOUR;
        if (
            sample.at < now - OWN_BOAT_SKILL.windowMs ||
            sample.at > now ||
            sample.receivedAt > now ||
            hour > now ||
            Math.abs(sample.at - hour) > 20 * 60_000
        )
            continue;
        const old = observations.get(hour);
        if (
            !old ||
            Math.abs(sample.at - hour) < Math.abs(old.at - hour) ||
            (Math.abs(sample.at - hour) === Math.abs(old.at - hour) && sample.at < old.at)
        )
            observations.set(hour, sample);
    }
    return OWN_SKILL_LEADS.map((lead, index) => {
        const [low, high] = BOUNDS[index],
            candidates = new Map<string, Map<number, { error: number; lead: number }>>();
        for (const issue of issues) {
            if (!OWN_BOAT_MODELS.includes(issue.model) || issue.capturedAt > now || issue.points.length > 73)
                throw Error('Private scored issue bound');
            for (const [at, value] of issue.points) {
                const observation = observations.get(at),
                    hours = (at - issue.runAt) / HOUR;
                if (
                    !observation ||
                    observation.cell !== issue.cell ||
                    issue.capturedAt >= observation.at ||
                    at <= issue.capturedAt ||
                    !(hours > low && hours <= high)
                )
                    continue;
                let model = candidates.get(issue.model);
                if (!model) {
                    model = new Map();
                    candidates.set(issue.model, model);
                }
                const old = model.get(at);
                // Choose the longest available issuer lead without looking at error.
                if (!old || hours > old.lead) model.set(at, { error: value - observation.windMps, lead: hours });
            }
        }
        const common = [...(candidates.values().next().value?.keys() ?? [])]
            .filter((at) => [...candidates.values()].every((model) => model.has(at)))
            .sort((a, b) => a - b);
        const models: Record<string, ModelScore> = {};
        for (const [model, pairs] of candidates) {
            const errors = common.map((at) => [at, pairs.get(at)!.error] as const),
                count = errors.length;
            const effectiveN = ownWindEffectiveN(errors),
                spanHours = count ? (common.at(-1)! - common[0]) / HOUR : 0;
            const ready = effectiveN >= 30 && spanHours >= 240 && candidates.size >= 2;
            models[model] = {
                pairs: count,
                effectiveN,
                spanHours,
                status: ready ? 'ready' : 'warming',
                mae: ready ? errors.reduce((s, p) => s + Math.abs(p[1]), 0) / count : null,
                medianLeadHours: count ? median(common.map((at) => pairs.get(at)!.lead)) : null,
            };
        }
        const ready = Object.entries(models).filter(([, score]) => score.status === 'ready');
        const best = Math.min(...ready.map(([, score]) => score.mae!));
        const tied = ready
            .filter(([, score]) => Math.abs(score.mae! - best) < 1e-9)
            .map(([model]) => model)
            .sort();
        return {
            schema: 1 as const,
            basis: 'forward-captured',
            station,
            metric: 'wind_speed_mps' as const,
            lead,
            windowStart: Math.floor(now / 1000) - 14 * 86400,
            windowEnd: Math.floor(now / 1000),
            models,
            status: ready.length >= 2 ? ('ready' as const) : ('warming' as const),
            closest: ready.length >= 2 && tied.length === 1 ? tied[0] : null,
            tiedModels: ready.length >= 2 && tied.length > 1 ? tied : [],
            effectiveNMethod: 'hourly-lag1-conservative',
            automaticModelSelection: false,
        };
    });
}
