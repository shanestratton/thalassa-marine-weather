/**
 * Who is logging and from which boat, for the Sightings screens: the signed-in
 * account (the auth identity fence, so a switch of account re-renders at
 * once), your own active vessel, the boat you crew on, and how many accepted
 * crew your own boat has (so a first sighting defaults to Crew only when
 * somebody would see it).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCrewingVessel } from '../useCrewingVessel';
import type { CrewVessel } from '../../services/vessel/sharedBinders';
import { getSightingMeta, putSightingMeta } from '../../services/sightings/sightingStore';

export interface SightingsSession {
    userId: string | null;
    ownBoatId: string | null;
    ownBoatName: string | null;
    crewing: CrewVessel | null;
    crewVessels: CrewVessel[];
    /** Accepted crew on your own boat; null until known. */
    ownCrewCount: number | null;
}

const userIdNow = () => getAuthIdentityScope().userId;

export function useSightingsUserId(): string | null {
    return useSyncExternalStore(subscribeAuthIdentityScope, userIdNow, userIdNow);
}

/** Accepted crew on your own boat (unique people). Offline: the last count this phone saw. */
async function loadOwnCrewCount(userId: string): Promise<number | null> {
    const cached = await getSightingMeta<number>(userId, 'own-crew-count');
    try {
        const { getMyCrew } = await import('../../services/CrewService');
        const crew = await getMyCrew();
        if (getAuthIdentityScope().userId !== userId) return cached;
        const people = new Set(crew.filter((c) => c.status === 'accepted').map((c) => c.crew_user_id));
        // getMyCrew answers [] offline as well as for a crewless boat; only a
        // non-empty answer can overrule what this phone saw before.
        const count = people.size > 0 || cached === null ? people.size : cached;
        await putSightingMeta(userId, 'own-crew-count', count);
        return count;
    } catch {
        return cached;
    }
}

export function useSightingsSession(): SightingsSession {
    const userId = useSightingsUserId();
    const ownBoatId = useSettingsStore((s) => s.activeVesselId);
    const ownBoatName = useSettingsStore((s) => s.settings.vessel?.name ?? null);
    const { vessel: crewing, vessels: crewVessels } = useCrewingVessel();
    const [ownCrewCount, setOwnCrewCount] = useState<number | null>(null);

    useEffect(() => {
        setOwnCrewCount(null);
        if (!userId || !ownBoatId) return;
        let live = true;
        void loadOwnCrewCount(userId).then((n) => {
            if (live) setOwnCrewCount(n);
        });
        return () => {
            live = false;
        };
    }, [userId, ownBoatId]);

    return {
        userId,
        ownBoatId: userId ? ownBoatId : null,
        ownBoatName: userId && ownBoatId ? ownBoatName?.trim() || null : null,
        crewing: userId ? crewing : null,
        crewVessels: userId ? crewVessels : [],
        ownCrewCount,
    };
}

/** The boat whose crew feed and life list the page shows. */
export interface FeedBoat {
    ownerId: string;
    name: string | null;
    own: boolean;
}

/**
 * The boats you can see a crew feed for: your own first, then the one you are
 * crewing on here, then any other you crew on.
 */
export function feedBoats(session: SightingsSession): FeedBoat[] {
    const boats: FeedBoat[] = [];
    if (session.userId && session.ownBoatId) {
        boats.push({ ownerId: session.userId, name: session.ownBoatName, own: true });
    }
    const selected = session.crewing?.ownerId;
    const crew = session.crewVessels
        .filter((v) => v.ownerId !== session.userId)
        .sort((a, b) => Number(b.ownerId === selected) - Number(a.ownerId === selected));
    for (const v of crew) boats.push({ ownerId: v.ownerId, name: v.vesselName, own: false });
    return boats;
}
