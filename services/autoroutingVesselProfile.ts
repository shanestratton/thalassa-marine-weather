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
