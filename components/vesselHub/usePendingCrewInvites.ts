/**
 * Count of crew invitations awaiting this account's answer, for the Passage
 * Planning badge.
 */
import { useEffect, useState } from 'react';
import { getPendingInviteCount } from '../../services/CrewService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { supabase } from '../../services/supabase';

// ── Crew invite badge ──
export function usePendingCrewInvites(authenticatedUserId: string | null): number {
    const [pendingCrewInvites, setPendingCrewInvites] = useState(0);
    useEffect(() => {
        // Account A's count must disappear in the render cycle immediately
        // after authStore switches to B; the async refresh may take a network
        // round-trip.
        setPendingCrewInvites(0);
        if (!supabase || !authenticatedUserId) return;

        let cancelled = false;
        const scope = getAuthIdentityScope();
        if (scope.userId !== authenticatedUserId) return;

        void (async () => {
            const { data } = await supabase.auth.getUser();
            if (data.user?.id !== authenticatedUserId) return;
            const count = await getPendingInviteCount();
            if (!cancelled && isAuthIdentityScopeCurrent(scope)) {
                setPendingCrewInvites(count);
            }
        })().catch(() => {
            // Offline or temporarily unavailable: retain the safe empty badge.
        });

        return () => {
            cancelled = true;
        };
    }, [authenticatedUserId]);

    return pendingCrewInvites;
}
