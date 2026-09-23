/** Thalassa's bounded vessel snapshot; status fields are never SevenCs wire fields. */
export type AutoroutingDimension =
    | { status: 'measured' | 'estimated'; valueM: number }
    | { status: 'missing' };

export interface AutoroutingVesselProfile {
    length: AutoroutingDimension;
    beam: AutoroutingDimension;
    airDraft: AutoroutingDimension;
    draftStatus: 'measured' | 'estimated' | 'missing';
}

/** Trial bounds, not claimed provider limits or yacht safety recommendations. */
export const AUTOROUTING_VESSEL_LIMITS_M = { length: 300, beam: 100, airDraft: 150 } as const;

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

function dimension(value: unknown, maximumM: number): AutoroutingDimension {
    if (!record(value)) throw new Error('Invalid vessel dimension.');
    if (value.status === 'missing' && Object.keys(value).length === 1) return { status: 'missing' };
    if (
        (value.status !== 'measured' && value.status !== 'estimated') ||
        Object.keys(value).length !== 2 ||
        !Object.keys(value).every((key) => key === 'status' || key === 'valueM') ||
        typeof value.valueM !== 'number' || !Number.isFinite(value.valueM) ||
        value.valueM <= 0 || value.valueM > maximumM
    ) throw new Error('Invalid vessel dimension.');
    return { status: value.status, valueM: value.valueM };
}

/** Validate and detach every nested value before asynchronous work. */
export function validateAutoroutingVesselProfile(value: unknown): AutoroutingVesselProfile {
    if (
        !record(value) || Object.keys(value).length !== 4 ||
        !Object.keys(value).every((key) => ['length', 'beam', 'airDraft', 'draftStatus'].includes(key)) ||
        typeof value.draftStatus !== 'string' || !['measured', 'estimated', 'missing'].includes(value.draftStatus)
    ) throw new Error('Invalid vessel profile.');
    return {
        length: dimension(value.length, AUTOROUTING_VESSEL_LIMITS_M.length),
        beam: dimension(value.beam, AUTOROUTING_VESSEL_LIMITS_M.beam),
        airDraft: dimension(value.airDraft, AUTOROUTING_VESSEL_LIMITS_M.airDraft),
        draftStatus: value.draftStatus as AutoroutingVesselProfile['draftStatus'],
    };
}

export function autoroutingVesselWarnings(profile?: AutoroutingVesselProfile): string[] {
    if (!profile) return [
        'Draft measurement status is unknown. Air draft, beam and vessel dimensions are unknown and have not been checked for this yacht.',
    ];
    const warnings: string[] = [];
    if (profile.draftStatus !== 'measured') warnings.push(
        profile.draftStatus === 'estimated'
            ? 'Vessel draft is estimated. Depth review is incomplete until the draft is measured and confirmed in Vessel settings.'
            : 'Vessel draft measurement status is missing. Depth clearance has not been established.',
    );
    for (const [key, label] of [['length', 'Length'], ['beam', 'Beam'], ['airDraft', 'Air draft']] as const) {
        const value = profile[key];
        if (value.status === 'missing') warnings.push(`${label} is missing and was not supplied to SevenCs.`);
        if (value.status === 'estimated') warnings.push(`${label} is estimated; the supplied value is not a confirmed measurement.`);
    }
    warnings.push('Supplying vessel dimensions does not establish bridge or overhead clearance. No vertical safety margin or tide credit has been added.');
    return warnings;
}
