/**
 * CrewManagement — resolving the boat a crew edit belongs to.
 *
 * Moved verbatim out of components/CrewManagement.tsx.
 */
import { supabase } from '../../services/supabase';
import { loadOwnedVesselFleet } from '../../services/VesselFleetService';
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../../services/authIdentityScope';

/** Crew edits belong to the vessel currently selected by the skipper, not an arbitrary owned boat. */
export async function activeOwnedBoatId(scope: AuthIdentityScope): Promise<string | null> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const fleet = await loadOwnedVesselFleet(scope);
        const active = fleet.vessels.find((vessel) => vessel.id === fleet.activeBoatId);
        if (active) return active.id;
    } catch {
        // Staged rollout fallback for environments whose fleet migration is
        // not yet applied; limiting avoids the old multi-row `maybeSingle`.
    }
    if (!supabase || !isAuthIdentityScopeCurrent(scope)) return null;
    const { data } = await supabase
        .from('boats')
        .select('id')
        .eq('owner_id', scope.userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return typeof data?.id === 'string' ? data.id : null;
}
