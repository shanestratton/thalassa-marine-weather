/**
 * trackSourcePlan — which receiver feeds a voyage's track, decided once at
 * Start. Pure: facts in, plan out. The facts are gathered by
 * trackSourceInputs.ts (live link state, the Pi's recorder, the phone).
 *
 * Shane 2026-10-07, with a red "needs Always Location" toast and the phone's
 * "GPS Accuracy Notice" on screen while the app knew exactly where the boat
 * was: "we need it to use the vessel gps if and when available".
 *
 * The boat owns the track. The phone is a viewer and a controller: it records
 * her lanes while it is awake, and it stands in for her only when the skipper
 * said so, every point tagged. Thalassa is a global app: most boats have no
 * Pi, many have only a gateway (YDWG-02, W2K-1, iKommunicate, a Signal K
 * server, an NMEA 0183 multiplexer), and many have nothing at all.
 *
 *   source         keep-alive (iOS)                   phone notice  stand-in
 *   vessel         nothing from ashore; While Using    never         aboard/unknown: allowed
 *                  aboard (this phone records her                    ashore: never
 *                  lanes for the voyage)
 *   vessel-silent  as vessel                           never         aboard/unknown: ask
 *                                                                    ashore: never
 *   phone          Always ADVISED, never required      once          allowed
 *   phone-accessory as phone                          never         allowed
 *
 * Decisions taken on our recommendation (Shane's standing instruction,
 * 2026-10-07, voyagelog.md): no Always demand when the boat feeds the log;
 * Always is an advisory for a phone-only log (cautions, not blocks —
 * 2026-08-26); a Start from ashore is a boat-only voyage and asks this phone
 * for nothing; the stand-in is asked only when her GPS is silent at Start.
 */
import type { DataState, Lane, LinkKind, Where } from '../boatLink/boatLinkModel';
import type { PositionSource } from '../../types/navigation';

/** A boat fix older than this at Start is where she WAS (boatPositionChain's CLOUD_FIX_MAX_AGE_MS). */
export const BOAT_POSITION_MAX_AGE_MS = 60_000;

export type PlanSource = 'vessel' | 'vessel-silent' | 'phone' | 'phone-accessory';

/**
 * What the phone must hold for the voyage to keep recording with the screen
 * locked.
 *   none-needed     — a Start from ashore: ask for nothing; any existing
 *                     grant keeps the phone awake, none records while open.
 *   when-in-use     — her GPS feeds the log through this phone (her bus, her
 *                     Pi, her cloud row): While Using keeps it recording.
 *   always-advised  — the phone is the receiver; While Using works while the
 *                     app lives, Always adds a restart after iOS ends it.
 *   always-required — kept for completeness; voyage logging never uses it now.
 */
export type KeepAlive = 'none-needed' | 'when-in-use' | 'always-advised' | 'always-required';

/** May this phone's GPS stand in for hers when she goes silent? */
export type StandIn = 'allowed' | 'ask' | 'never';

/**
 * Which receiver produced one logged position. Also the vocabulary of
 * ship_logs.position_source (migration 20261007183000) — keep the two in step.
 *   vessel          — her bus (a gateway socket, or her Pi on her own Wi-Fi)
 *   vessel-relay    — her receivers, relayed: the Pi direct, her cloud row, or
 *                     her LAN reached over a private network from elsewhere
 *   vessel-pi-log   — her Pi's own recorded track (backfill; phase 2)
 *   phone           — this phone's GPS
 *   phone-accessory — a Bad Elf / MFi receiver feeding this phone's Core Location
 */
export type FixSource = PositionSource;
export const FIX_SOURCES: readonly FixSource[] = [
    'vessel',
    'vessel-relay',
    'vessel-pi-log',
    'phone',
    'phone-accessory',
] as const;

export function isFixSource(value: unknown): value is FixSource {
    return typeof value === 'string' && (FIX_SOURCES as readonly string[]).includes(value);
}

/** A phone receiver (the phone's own chip, or an accessory feeding it). */
export function isPhoneFixSource(source: FixSource | null | undefined): boolean {
    return source === 'phone' || source === 'phone-accessory';
}

export interface TrackSourceInput {
    /** A gateway saved or a Pi paired: there is a boat GPS to wait for. */
    boatConfigured: boolean;
    /**
     * Her Pi says its always-on track recorder is enabled. Not yet a reason
     * to ask the phone for less: nothing merges the Pi's own track into a
     * voyage until the backfill (phase 2) ships, so this phone's keep-alive is
     * what records her lanes with the screen locked. Kept for that phase and
     * for the plan's log line.
     */
    piRecorderOn: boolean;
    /** gwstate's WHERE / LINK / DATA (services/boatLink). */
    link: { where: Where; lane: Lane; kind: LinkKind; data: DataState };
    /** Her freshest position at Start: the bus, then the Pi direct, then her cloud row. */
    boatPosition: { lane: 'bus' | 'pi' | 'cloud'; ageMs: number } | null;
    /** A Bad Elf / MFi accessory is what Core Location is reading. */
    phoneAccessory: boolean;
}

export interface TrackSourcePlan {
    source: PlanSource;
    /** The boat lane that answered at Start. */
    lane: 'bus' | 'pi' | 'cloud' | 'none';
    where: Where;
    keepAlive: KeepAlive;
    showPhoneNotice: boolean;
    standIn: StandIn;
    /** The skipper said "Log from this phone" with her GPS silent at Start. */
    standInOptIn: boolean;
    /** Kept so the answer to the stand-in question can tag the phone honestly. */
    phoneAccessory: boolean;
}

function phonePlan(input: Pick<TrackSourceInput, 'link' | 'phoneAccessory'>, optIn: boolean): TrackSourcePlan {
    return {
        source: input.phoneAccessory ? 'phone-accessory' : 'phone',
        lane: 'none',
        where: input.link.where,
        keepAlive: 'always-advised',
        // The notice is about the phone's own chip on the water. A Bad Elf is
        // a dedicated receiver: it gets no warning about phone GPS.
        showPhoneNotice: !input.phoneAccessory,
        standIn: 'allowed',
        standInOptIn: optIn,
        phoneAccessory: input.phoneAccessory,
    };
}

export function planTrackSource(input: TrackSourceInput): TrackSourcePlan {
    if (!input.boatConfigured) return phonePlan(input, false);

    const { where, data, lane } = input.link;
    const position =
        input.boatPosition && input.boatPosition.ageMs >= 0 && input.boatPosition.ageMs <= BOAT_POSITION_MAX_AGE_MS
            ? input.boatPosition
            : null;
    // A lane that has just gone stale, or a socket still connecting, is
    // patience, not silence (dependsOnGatewayState: stale → vessel, the 180 s
    // dwell handles the rest). A crew phone's shared row is never her GPS.
    const patience = lane !== 'shared' && (data === 'stale' || data === 'connecting');
    const ashore = where === 'ashore';
    // From ashore the phone's position is irrelevant to her track, so nothing
    // is asked of it. Aboard (or not known), this phone is what records her
    // lanes into the voyage while the screen is locked: While Using, taken in
    // the foreground, is enough (build 123 review: a Pi recorder does not
    // change that until its track can backfill a voyage — phase 2).
    const keepAlive: KeepAlive = ashore ? 'none-needed' : 'when-in-use';
    const base = {
        where,
        keepAlive,
        showPhoneNotice: false,
        standInOptIn: false,
        phoneAccessory: input.phoneAccessory,
    };

    if (position || patience) {
        return {
            ...base,
            source: 'vessel',
            lane: position?.lane ?? 'none',
            // WHERE comes from position, never from which address answered
            // (gwstate). A misread "ashore" while aboard costs only the phone
            // backup, never her track.
            standIn: ashore ? 'never' : 'allowed',
        };
    }
    return { ...base, source: 'vessel-silent', lane: 'none', standIn: ashore ? 'never' : 'ask' };
}

/**
 * The skipper's answer to "her GPS isn't answering": wait for her (a
 * boat-only voyage — the phone never stands in, her Pi fills the track), or
 * log from this phone (opted in; the phone notice applies).
 */
export function applyStandInAnswer(plan: TrackSourcePlan, answer: 'phone' | 'wait'): TrackSourcePlan {
    if (answer === 'wait') return { ...plan, standIn: 'never', standInOptIn: false, showPhoneNotice: false };
    return phonePlan(
        { link: { where: plan.where, lane: 'none', kind: 'none', data: 'none' }, phoneAccessory: plan.phoneAccessory },
        true,
    );
}

/** The policy the track's GPS manager applies to the phone, from a plan. */
export interface StandInPolicy {
    standIn: StandIn;
    optedIn: boolean;
}

export function standInPolicyOf(
    plan: Pick<TrackSourcePlan, 'standIn' | 'standInOptIn'> | null | undefined,
): StandInPolicy {
    return plan ? { standIn: plan.standIn, optedIn: plan.standInOptIn } : { standIn: 'allowed', optedIn: false };
}
