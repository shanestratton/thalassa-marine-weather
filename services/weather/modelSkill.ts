/** Issued own-server skill only. Display advice never changes a model choice. */
export const SKILL_LEADS = ['0-6h', '6-24h', '24-48h', '48-72h'] as const;
export type SkillLead = (typeof SKILL_LEADS)[number];
export type SkillMetric = 'wind_speed_mps' | 'wave_hs_m';
export const ISSUED_ATMOSPHERE_MODELS = [
    'ecmwf_ifs025',
    'ecmwf_aifs025_single',
    'dwd_icon',
    'ukmo_global_deterministic_10km',
    'jma_gsm',
    'gfs_seamless',
] as const;
export const ISSUED_WAVE_MODELS = ['ecmwf_wam025', 'dwd_gwam', 'meteofrance_wave', 'ncep_gfswave025'] as const;
export interface SkillModelScore {
    readonly pairs: number;
    readonly effectiveN: number;
    readonly spanHours: number;
    readonly status: 'warming' | 'ready';
    readonly mae: number | null;
    readonly medianLeadHours: number | null;
}
export interface IssuedSkill {
    readonly metric: SkillMetric;
    readonly lead: SkillLead;
    readonly status: 'warming' | 'ready';
    readonly closest: string | null;
    readonly tiedModels: readonly string[];
    readonly models: Readonly<Record<string, SkillModelScore>>;
}

export function evidenceRequire(ok: unknown): asserts ok {
    if (!ok) throw new TypeError('Issued weather evidence is unavailable or outside its contract.');
}
export function evidenceRecord(value: unknown): Record<string, unknown> {
    evidenceRequire(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
}
export function evidenceKeys(row: Record<string, unknown>, names: readonly string[]): void {
    evidenceRequire(Object.keys(row).length === names.length && names.every((key) => Object.hasOwn(row, key)));
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, low: number, high: number): value is number =>
    finite(value) && Number.isInteger(value) && value >= low && value <= high;

/** Recheck the publisher's qualification/tie rules at the untrusted client boundary.
 * Original-byte verification belongs to the caller-owned public cohort reader. */
export function decodeIssuedSkill(
    value: unknown,
    station: string,
    metric: SkillMetric,
    lead: SkillLead,
    generatedAt: number,
): IssuedSkill {
    evidenceRequire(metric === 'wind_speed_mps' || metric === 'wave_hs_m');
    const row = evidenceRecord(value);
    evidenceKeys(row, [
        'schema',
        'basis',
        'station',
        'metric',
        'lead',
        'windowStart',
        'windowEnd',
        'models',
        'status',
        'closest',
        'tiedModels',
        'effectiveNMethod',
        'automaticModelSelection',
    ]);
    evidenceRequire(
        row.schema === 1 &&
            row.basis === 'forward-captured' &&
            row.station === station &&
            row.metric === metric &&
            row.lead === lead &&
            row.windowEnd === generatedAt &&
            row.windowStart === generatedAt - 14 * 86400 &&
            row.automaticModelSelection === false &&
            row.effectiveNMethod === 'hourly-lag1-conservative' &&
            (row.status === 'warming' || row.status === 'ready'),
    );
    const source = evidenceRecord(row.models);
    const allowed: readonly string[] = metric === 'wind_speed_mps' ? ISSUED_ATMOSPHERE_MODELS : ISSUED_WAVE_MODELS;
    const index = SKILL_LEADS.indexOf(lead);
    evidenceRequire(index >= 0 && Object.keys(source).length <= allowed.length);
    const bounds = [
        [0, 6],
        [6, 24],
        [24, 48],
        [48, 72],
    ][index];
    const models: Record<string, SkillModelScore> = {};
    const counts = new Set<number>();
    const spans = new Set<number>();
    for (const [id, raw] of Object.entries(source)) {
        evidenceRequire(allowed.includes(id));
        const score = evidenceRecord(raw);
        evidenceKeys(score, ['pairs', 'effectiveN', 'spanHours', 'status', 'mae', 'medianLeadHours']);
        evidenceRequire(
            integer(score.pairs, 0, 337) &&
                integer(score.effectiveN, 0, score.pairs) &&
                finite(score.spanHours) &&
                score.spanHours >= 0 &&
                score.spanHours <= 336 &&
                (score.status === 'warming' || score.status === 'ready') &&
                (score.medianLeadHours === null ||
                    (finite(score.medianLeadHours) &&
                        score.medianLeadHours > bounds[0] &&
                        score.medianLeadHours <= bounds[1])),
        );
        if (score.status === 'ready')
            evidenceRequire(
                score.effectiveN >= 30 &&
                    score.spanHours >= 240 &&
                    finite(score.mae) &&
                    score.mae >= 0 &&
                    Object.keys(source).length >= 2,
            );
        else evidenceRequire(score.mae === null);
        evidenceRequire((score.pairs === 0) === (score.medianLeadHours === null));
        if (score.pairs <= 1) evidenceRequire(score.spanHours === 0);
        counts.add(score.pairs);
        spans.add(score.spanHours);
        models[id] = Object.freeze({
            pairs: score.pairs,
            effectiveN: score.effectiveN,
            spanHours: score.spanHours,
            status: score.status,
            mae: score.mae as number | null,
            medianLeadHours: score.medianLeadHours as number | null,
        });
    }
    evidenceRequire(counts.size <= 1 && spans.size <= 1);
    const ready = Object.entries(models).filter(([, score]) => score.status === 'ready');
    const best = Math.min(...ready.map(([, score]) => score.mae!));
    const tied = ready
        .filter(([, score]) => Math.abs(score.mae! - best) < 1e-9)
        .map(([id]) => id)
        .sort();
    const status = ready.length >= 2 ? 'ready' : 'warming';
    const closest = status === 'ready' && tied.length === 1 ? tied[0] : null;
    const ties = status === 'ready' && tied.length > 1 ? tied : [];
    evidenceRequire(
        row.status === status &&
            row.closest === closest &&
            Array.isArray(row.tiedModels) &&
            JSON.stringify(row.tiedModels) === JSON.stringify(ties),
    );
    return Object.freeze({
        metric,
        lead,
        status,
        closest,
        tiedModels: Object.freeze(ties),
        models: Object.freeze(models),
    });
}

/** No aliasing across resolutions, blends, marine versus atmosphere, or active feed.
 * A 0.25 degree IFS score cannot qualify the ecmwf_ifs 9 km selection. */
export function exactIssuedModelScore(skill: IssuedSkill, sourceDomain: string): SkillModelScore | null {
    const score = Object.hasOwn(skill.models, sourceDomain) ? skill.models[sourceDomain] : undefined;
    return skill.status === 'ready' && score?.status === 'ready' ? score : null;
}
