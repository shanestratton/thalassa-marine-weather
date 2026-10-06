/**
 * useCrewChatGate — the Crew Chat card on the Scuttlebutt page: whether it
 * shows, which group it opens, and whose boat it names.
 *
 * Shane 2026-10-06: "the crew chat - private group takes about 5-10 seconds
 * to arrive in the scuttlebutt page ... they all need to come at the same
 * time. and fast". The page used to learn all this at the END of its serial
 * init (channels, crew repair, fresh channels, profile, crew rows, then up
 * to 2.5 s of vessel names), so the card landed seconds after the others.
 *
 * Now the card paints on the list's first frame from what this phone already
 * knows for THIS account: the last gate it verified (crewChatGate) and the
 * crewing snapshot the Vessel page reads (useCrewingVessel). The live reads
 * start at mount, alongside the channel load, and run in parallel; the vessel
 * name never holds the card. When a live answer differs (removed as crew,
 * the group no longer lists this account, passage chat unticked, signed out,
 * another account) the card follows it at once and the memory is rewritten.
 * A read that gets no answer changes nothing.
 *
 * With nothing remembered (a first visit) the card lands with the slowest of
 * those parallel reads, not after their sum. Opening the group is still
 * authorised by RLS, as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatChannel } from '../services/chat/types';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import {
    NO_PASSAGE_ACCESS,
    getActivePassageId,
    getPassageStatus,
    type PassageStatus,
} from '../services/PassagePlanService';
import {
    MAX_CREW_CHAT_OWNERS,
    isCrewChatGroup,
    readCrewChatChannelMemberships,
    readCrewChatGateMemory,
    readCrewChatRows,
    rememberCrewChatGate,
    type CrewChatChannelMemberships,
    type CrewChatGateMemory,
    type CrewChatRows,
} from '../services/crew/crewChatGate';
import { useCrewingVessel } from './useCrewingVessel';

export interface CrewChatGateInput {
    /** The page's channel list (the cached list first, then the fresh one). */
    channels: readonly ChatChannel[];
    /** Private channels the chat service has confirmed this account is in. */
    memberChannelIds: ReadonlySet<string>;
}

export interface CrewChatGate {
    /** The account has invited crew of its own: a skipper's card. */
    hasOwnedCrew: boolean;
    /** The account is accepted crew for at least one skipper. */
    hasCrewMembership: boolean;
    /** A skipper with crew, or crew who may chat on the selected passage. */
    canOpenCrewChat: boolean;
    /** The skipper's Crew Chat this crew member is in: the card opens it. */
    crewChatChannel: ChatChannel | null;
    /** The vessel whose group `crewChatChannel` is, when known. */
    crewChatVesselName: string | undefined;
}

/** What the live reads have answered for one identity generation. */
interface LiveAnswers {
    /** `${scope.key}#${scope.generation}`: answers for any other scope are never used. */
    tag: string;
    rows: CrewChatRows | null;
    members: CrewChatChannelMemberships | null;
    /** The selected passage, and its answer (null while the read is out). */
    passageVoyageId: string | null;
    passage: PassageStatus | null;
    /**
     * The last passage-chat grant answered this visit, kept while a re-check
     * is out; undefined until one answers (the memory stands in until then).
     */
    verifiedPassage?: CrewChatGateMemory['passage'];
    /** Vessel names read live this visit, by owner id. */
    names: ReadonlyMap<string, string>;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const tagOf = (scope: AuthIdentityScope) => `${scope.key}#${scope.generation}`;
const noAnswers = (tag: string): LiveAnswers => ({
    tag,
    rows: null,
    members: null,
    passageVoyageId: getActivePassageId(),
    passage: null,
    names: NO_NAMES,
});

export function useCrewChatGate({ channels, memberChannelIds }: CrewChatGateInput): CrewChatGate {
    const scope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope, getAuthIdentityScope);
    const tag = tagOf(scope);
    const viewerId = scope.userId;
    // A new scope object is minted on every identity change, so this re-reads
    // the memory for exactly the account now signed in, and only for it.
    const memory = useMemo(() => readCrewChatGateMemory(scope), [scope]);
    const { vessels } = useCrewingVessel();

    const [answers, setAnswers] = useState<LiveAnswers>(() => noAnswers(tag));
    const live = answers.tag === tag ? answers : noAnswers(tag);
    const answer = useCallback((forTag: string, patch: (base: LiveAnswers) => Partial<LiveAnswers>) => {
        setAnswers((previous) => {
            if (forTag !== tagOf(getAuthIdentityScope())) return previous;
            const base = previous.tag === forTag ? previous : noAnswers(forTag);
            const change = patch(base);
            if (base === previous && Object.keys(change).length === 0) return previous;
            return { ...base, ...change };
        });
    }, []);

    // ── Live reads: all at once, at mount, alongside the channel load ──
    useEffect(() => {
        if (!scope.userId) return;
        const forTag = tagOf(scope);
        void readCrewChatRows(scope).then((rows) => {
            if (rows && isAuthIdentityScopeCurrent(scope)) answer(forTag, () => ({ rows }));
        });
        void readCrewChatChannelMemberships(scope).then((members) => {
            if (members && isAuthIdentityScopeCurrent(scope)) answer(forTag, () => ({ members }));
        });
    }, [scope, answer]);

    useEffect(() => {
        const forTag = tagOf(scope);
        let active = true;
        let asked = 0;
        const refresh = () => {
            // A selection on this phone is not proof of a grant: until the
            // service answers, only a grant verified for this same passage
            // and account stands in: the last answer this visit, else the
            // memory. A re-check never brings back a grant already refused.
            const voyageId = getActivePassageId();
            const request = ++asked;
            answer(forTag, (base) =>
                base.passageVoyageId === voyageId && base.passage === null
                    ? {}
                    : { passageVoyageId: voyageId, passage: null },
            );
            void getPassageStatus(voyageId)
                .catch(() => NO_PASSAGE_ACCESS)
                .then((status) => {
                    if (active && request === asked && isAuthIdentityScopeCurrent(scope)) {
                        const verifiedPassage = voyageId
                            ? { voyageId, canViewChat: status.visible && status.canViewChat }
                            : null;
                        answer(forTag, () => ({ passageVoyageId: voyageId, passage: status, verifiedPassage }));
                    }
                });
        };
        refresh();
        // Re-check when passage selection changes (from the VesselHub dropdown).
        window.addEventListener('thalassa:passage-changed', refresh);
        return () => {
            active = false;
            window.removeEventListener('thalassa:passage-changed', refresh);
        };
    }, [scope, answer]);

    // ── The gate: live answers first, then what this phone knows ──
    const rows = live.rows;
    const hasOwnedCrew = !!viewerId && (rows ? rows.hasOwnedCrew : memory?.hasOwnedCrew === true);
    const memberOwnerIds = useMemo(() => {
        if (!viewerId) return [];
        if (rows) return rows.memberOwnerIds;
        const known = new Set(memory?.memberOwnerIds ?? []);
        for (const vessel of vessels) if (vessel.ownerId && vessel.ownerId !== viewerId) known.add(vessel.ownerId);
        return [...known].slice(0, MAX_CREW_CHAT_OWNERS);
    }, [viewerId, rows, memory, vessels]);
    const hasCrewMembership = memberOwnerIds.length > 0;

    // The page resets its memberChannelIds on an identity change with its own
    // setState, a render after this hook's scope moves: a set carried across
    // the change is the last account's, so it counts only once it changes.
    const [carried, setCarried] = useState({ tag, ids: null as ReadonlySet<string> | null });
    if (carried.tag !== tag) setCarried({ tag, ids: memberChannelIds });
    const pageMemberIds = carried.tag !== tag || carried.ids === memberChannelIds ? NO_IDS : memberChannelIds;

    // Crew reach the skipper's Crew Chat through the channel they are already
    // a member of (Shane 2026-10-02: Crew Chat is every crew member's by
    // default, no tick box). The group the memory names keeps the card until
    // an answer says this account is no longer in it.
    const members = live.members;
    const crewChatChannel = useMemo(() => {
        if (!hasCrewMembership) return null;
        const owners = new Set(memberOwnerIds);
        const isGroup = (channel: ChatChannel | null | undefined): channel is ChatChannel =>
            isCrewChatGroup(channel, viewerId) && owners.has(channel?.owner_id as string);
        const confirmed = (id: string) => pageMemberIds.has(id) || members?.ids.has(id) === true;
        const refused = (id: string) => !pageMemberIds.has(id) && !!members?.complete && !members.ids.has(id);
        const remembered = memory?.channel;
        if (isGroup(remembered) && !refused(remembered.id)) {
            const listed = channels.find((channel) => channel.id === remembered.id);
            if (!listed) return remembered;
            if (isGroup(listed)) return listed;
        }
        return channels.find((channel) => isGroup(channel) && confirmed(channel.id)) ?? null;
    }, [hasCrewMembership, memberOwnerIds, viewerId, pageMemberIds, members, memory, channels]);

    const knownPassage = live.verifiedPassage !== undefined ? live.verifiedPassage : (memory?.passage ?? null);
    const passageChat = live.passage
        ? live.passage.visible && live.passage.canViewChat
        : !!knownPassage && knownPassage.voyageId === live.passageVoyageId && knownPassage.canViewChat;
    const canOpenCrewChat = hasOwnedCrew || (hasCrewMembership && passageChat);

    // The card names the skipper's vessel (Shane 2026-10-02: "it is the
    // correct group, but it is just saying the wrong vessel"): this visit's
    // read, else the name it showed last time, else the crewing snapshot's.
    // All three are vessel_identity, so a re-read never flips the wording.
    const nameFor = useCallback(
        (ownerId: string): string | undefined =>
            live.names.get(ownerId) ??
            memory?.vesselNames[ownerId] ??
            vessels.find((vessel) => vessel.ownerId === ownerId)?.vesselName ??
            undefined,
        [live.names, memory, vessels],
    );
    const crewChatOwnerId = crewChatChannel?.owner_id ?? null;
    const crewChatVesselName = crewChatOwnerId ? nameFor(crewChatOwnerId) : undefined;

    // Read the names as soon as the owners are known; never wait on them.
    const nameOwners = [...new Set([...(crewChatOwnerId ? [crewChatOwnerId] : []), ...memberOwnerIds])]
        .slice(0, MAX_CREW_CHAT_OWNERS)
        .join('|');
    const askedNames = useRef<{ tag: string; owners: Set<string> }>({ tag: '', owners: new Set() });
    useEffect(() => {
        if (!scope.userId || !nameOwners) return;
        const forTag = tagOf(scope);
        if (askedNames.current.tag !== forTag) askedNames.current = { tag: forTag, owners: new Set() };
        const asked = askedNames.current.owners;
        const owners = nameOwners.split('|').filter((ownerId) => ownerId && !asked.has(ownerId));
        if (owners.length === 0) return;
        for (const ownerId of owners) asked.add(ownerId);
        void import('../services/VesselIdentityService')
            .then(({ fetchVesselNameForOwner }) => {
                for (const ownerId of owners) {
                    void fetchVesselNameForOwner(ownerId)
                        .then((name) => {
                            // No answer keeps the name the card has.
                            if (!name || !isAuthIdentityScopeCurrent(scope)) return;
                            answer(forTag, (base) => {
                                if (base.names.get(ownerId) === name) return {};
                                const names = new Map(base.names);
                                names.set(ownerId, name);
                                return { names };
                            });
                        })
                        .catch(() => {
                            /* non-critical: the card keeps the name it has */
                        });
                }
            })
            .catch(() => {
                /* non-critical: the card keeps the name it has */
            });
    }, [scope, nameOwners, answer]);

    // ── Remember what was verified, for the next visit's first paint ──
    // Only this hook's own reads, fenced to this scope, count as an answer.
    const anyAnswer = !!live.rows || !!live.members || live.verifiedPassage !== undefined || live.names.size > 0;
    useEffect(() => {
        if (!scope.userId || !anyAnswer || !isAuthIdentityScopeCurrent(scope)) return;
        const vesselNames: Record<string, string> = {};
        for (const ownerId of nameOwners.split('|')) {
            const name = ownerId ? nameFor(ownerId) : undefined;
            if (name) vesselNames[ownerId] = name;
        }
        rememberCrewChatGate(scope, {
            version: 1,
            userId: scope.userId,
            hasOwnedCrew,
            memberOwnerIds: [...memberOwnerIds],
            channel: crewChatChannel,
            passage: knownPassage,
            vesselNames,
        });
    }, [scope, anyAnswer, hasOwnedCrew, memberOwnerIds, crewChatChannel, knownPassage, nameOwners, nameFor]);

    return { hasOwnedCrew, hasCrewMembership, canOpenCrewChat, crewChatChannel, crewChatVesselName };
}
