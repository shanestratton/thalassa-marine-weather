import type { VesselProfile } from '../types/vessel';
import type { AutoroutingDimension, AutoroutingVesselProfile } from '../types/autorouting';
import { AUTOROUTING_VESSEL_LIMITS_M } from '../supabase/functions/_shared/autorouting-vessel';
import { FEET_PER_METRE, vesselAirDraftMetres, vesselDraftIsAssumed } from './units';

/** Opening snapshot of stored feet values, without defaults or inferred dimensions. */
export function snapshotAutoroutingVesselProfile(
    vessel: Partial<VesselProfile> | undefined | null,
): AutoroutingVesselProfile {
    const dimension = (key: 'length' | 'beam' | 'airDraft'): AutoroutingDimension => {
        const value = vessel?.[key];
        const valueM =
            key === 'airDraft'
                ? vesselAirDraftMetres(vessel)
                : typeof value === 'number'
                  ? value / FEET_PER_METRE
                  : null;
        if (valueM === null || !Number.isFinite(valueM) || valueM <= 0 || valueM > AUTOROUTING_VESSEL_LIMITS_M[key]) {
            return { status: 'missing' };
        }
        return { valueM, status: vessel?.estimatedFields?.includes(key) ? 'estimated' : 'measured' };
    };
    return {
        length: dimension('length'),
        beam: dimension('beam'),
        airDraft: dimension('airDraft'),
        draftStatus:
            typeof vessel?.draft !== 'number' || !Number.isFinite(vessel.draft) || vessel.draft <= 0
                ? 'missing'
                : vesselDraftIsAssumed(vessel)
                  ? 'estimated'
                  : 'measured',
    };
}

/**
 * What Auto must say about the boat it routed for (2026-10-01): Thalassa's
 * router reads the draft and the air draft, nothing else. An air draft that
 * is not set blocks every bridge and overhead line (owner decision 5); an
 * estimated one is used as given and said so.
 */
export function thalassaVesselWarnings(profile?: AutoroutingVesselProfile): string[] {
    const warnings: string[] = [];
    if (!profile || profile.draftStatus !== 'measured') {
        warnings.push(
            profile?.draftStatus === 'estimated'
                ? 'Vessel draft is estimated. Depth review is incomplete until the draft is measured and confirmed in Vessel settings.'
                : 'Vessel draft measurement status is missing. Depth clearance has not been established.',
        );
    }
    if (!profile || profile.airDraft.status === 'missing')
        warnings.push('Air draft not set: every bridge and power line blocks the route.');
    else if (profile.airDraft.status === 'estimated') warnings.push('Air draft is estimated.');
    warnings.push('Beam and length are not used by the router yet.');
    return warnings;
}
