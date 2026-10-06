/**
 * useCrewCardNames — the names on the skipper's crew cards (Crew & Float Plan,
 * 2026-10-06), by crew_user_id: this device's last answer at once, then the
 * live read (services/crew/crewCardNames). Only accepted crew have a name to
 * read; a pending invite keeps its email. Names only, never a phone or an age.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CrewMember } from '../services/CrewService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../services/authIdentityScope';
import { loadCrewCardNames, readCrewCardNames, type CrewCardNames } from '../services/crew/crewCardNames';

export function useCrewCardNames(members: readonly CrewMember[], enabled: boolean): CrewCardNames {
    const scopeKey = getAuthIdentityScope().key;
    const idsKey = useMemo(
        () =>
            [
                ...new Set(
                    members
                        .filter((member) => member.status === 'accepted' && member.crew_user_id)
                        .map((member) => member.crew_user_id),
                ),
            ]
                .sort()
                .join(','),
        [members],
    );
    const [state, setState] = useState<{ scopeKey: string; names: CrewCardNames }>(() => ({
        scopeKey,
        names: readCrewCardNames(getAuthIdentityScope()),
    }));

    useEffect(() => {
        const scope = getAuthIdentityScope();
        if (!enabled || !scope.userId) return undefined;
        // Another account's names never paint: re-read under this scope first.
        setState((previous) =>
            previous.scopeKey === scope.key ? previous : { scopeKey: scope.key, names: readCrewCardNames(scope) },
        );
        if (!idsKey) return undefined;
        let active = true;
        void loadCrewCardNames(scope, idsKey.split(',')).then((names) => {
            if (!active || !names || !isAuthIdentityScopeCurrent(scope)) return;
            setState({ scopeKey: scope.key, names });
        });
        return () => {
            active = false;
        };
    }, [enabled, idsKey, scopeKey]);

    return enabled && state.scopeKey === scopeKey ? state.names : {};
}
