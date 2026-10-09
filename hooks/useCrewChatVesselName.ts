/**
 * useCrewChatVesselName — the boat a crew room belongs to, for the header
 * under "Crew Chat" (build 125, Shane 2026-10-09: "it say mackay -
 * whitsundays at the top").
 *
 * The room's owner is the skipper, so the name is always the skipper's boat,
 * never the viewer's own when they are crew (Shane 2026-10-02: "it is the
 * correct group, but it is just saying the wrong vessel"):
 *
 * 1. the viewer owns the room: their own selected vessel (settings);
 * 2. else the name this phone last verified for that skipper (the Crew Chat
 *    gate memory, what the card already shows);
 * 3. else read live (fetchVesselNameForOwner, RLS: accepted crew only).
 *
 * Undefined when the channel is not a crew room or no name is known.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ChatChannel } from '../services/chat/types';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';
import { readCrewChatGateMemory } from '../services/crew/crewChatGate';
import { useSettingsStore } from '../stores/settingsStore';
import { isCrewRoom } from '../components/chat/channelIcons';

export function useCrewChatVesselName(channel: ChatChannel | null | undefined): string | undefined {
    const scope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope, getAuthIdentityScope);
    const ownVessel = useSettingsStore((state) => state.settings?.vessel?.name);
    const ownerId = isCrewRoom(channel) ? channel?.owner_id || null : null;
    const own = !!ownerId && ownerId === scope.userId;
    const remembered = useMemo(
        () => (ownerId && !own ? readCrewChatGateMemory(scope)?.vesselNames[ownerId] : undefined),
        [scope, ownerId, own],
    );

    // A live read answers for one account and one owner only.
    const key = `${scope.key}#${scope.generation}|${ownerId}`;
    const [read, setRead] = useState<{ key: string; name: string } | null>(null);
    useEffect(() => {
        if (!ownerId || own || remembered || !scope.userId) return;
        let active = true;
        void import('../services/VesselIdentityService')
            .then(({ fetchVesselNameForOwner }) => fetchVesselNameForOwner(ownerId))
            .then((name) => {
                if (active && name && isAuthIdentityScopeCurrent(scope)) setRead({ key, name });
            })
            .catch(() => {
                /* non-critical: the header reads "Private group" */
            });
        return () => {
            active = false;
        };
    }, [scope, key, ownerId, own, remembered]);

    if (!ownerId) return undefined;
    if (own) return ownVessel?.trim() || undefined;
    return remembered ?? (read?.key === key ? read.name : undefined);
}
