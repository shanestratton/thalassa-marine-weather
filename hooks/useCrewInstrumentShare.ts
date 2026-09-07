/**
 * useCrewInstrumentShare — does this account crew on a boat, and has the
 * skipper shared the Instrument Panel?
 *
 * Shane 2026-09-07: the panel is invite-only. The share is the 'instruments'
 * register on the crew row (vessel_crew.permissions.can_view_instruments),
 * ticked on the invite or under Crew afterwards, and the vessel_telemetry
 * read policy enforces it server-side. This hook only decides what the panel
 * SAYS when nothing arrives: "not shared" and "the boat is quiet" are
 * different sentences.
 */
import { useEffect, useState } from 'react';
import { getMyMemberships } from '../services/CrewService';

export type CrewInstrumentShare = 'none' | 'shared' | 'not-shared';

export function useCrewInstrumentShare(): CrewInstrumentShare {
    const [share, setShare] = useState<CrewInstrumentShare>('none');
    useEffect(() => {
        let live = true;
        getMyMemberships()
            .then((memberships) => {
                if (!live || memberships.length === 0) return;
                setShare(
                    memberships.some((m) => m.permissions?.can_view_instruments === true) ? 'shared' : 'not-shared',
                );
            })
            .catch(() => {
                /* offline or signed out: the panel keeps its ordinary wording */
            });
        return () => {
            live = false;
        };
    }, []);
    return share;
}
