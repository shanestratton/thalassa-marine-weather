/**
 * featureVisibility — launch-visibility flags for features that need a
 * critical mass of users or a production-ready third-party integration
 * before they're worth surfacing.
 *
 * Distinct from managers/FeatureGate (that's paywall TIERS — free vs
 * premium). These flags are "the code exists and works, but we're not
 * showing it yet." An empty Marketplace or Crew-Finder reads as a dead
 * app — worse than not having the feature at all — so they stay hidden
 * pre-launch and get flipped on once there's a user base to populate
 * them.
 *
 * Flip a flag to `true` to surface the feature everywhere it's gated.
 * Grep `FEATURE_VISIBILITY` to find every gated entry point.
 *
 * The Crew List is deliberately a quiet beta: it is opt-in, lives one
 * level inside Scuttlebutt, and is framed around safe sailing introductions
 * rather than social discovery. Marketplace remains held until it has the
 * inventory to feel useful.
 */
/**
 * Apple Music is the one entry here that is NOT a hand-edited boolean.
 *
 * Every other flag in this file is a product decision ("is there enough
 * inventory to show a Marketplace?"), which a human flips in a commit. Apple
 * Music is different: it is gated on an EXTERNAL fact — whether this build's
 * App ID actually carries the MusicKit capability and a matching distribution
 * profile. That fact lives in the Apple Developer portal, changes without any
 * code changing, and must be able to differ between a local build and a
 * release. So it reads a flag, defaulting off, exactly like
 * VITE_APPLE_SIGN_IN_ENABLED does for Sign in with Apple.
 *
 * The corresponding server gate is separate and does NOT trust this value —
 * see supabase/functions/musickit-token. A VITE_ value is user-readable and
 * user-settable, so it may hide a UI but must never authorize token minting.
 */
const APPLE_MUSIC_ENABLED = import.meta.env.VITE_APPLE_MUSIC_ENABLED === 'true';

export const FEATURE_VISIBILITY = {
    /** The Crew List — discreet skipper / crew introductions. */
    crewFinder: true,
    /**
     * Paid Spoonacular catalogue, generated meal plans, and provider images.
     * Personal, community, and offline galley features remain available.
     */
    spoonacular: false,
    /**
     * Apple Music needs the production MusicKit capability, a matching
     * distribution profile, and a physical-device authorization smoke. Until
     * those exist, showing the controls gives a music page that fails at
     * Apple — worse than not offering it. Calypso voice is unaffected either
     * way. Set VITE_APPLE_MUSIC_ENABLED=true once the capability is live; see
     * APPLE_MUSIC_ENABLED above for why this one is a flag and not a literal.
     */
    appleMusic: APPLE_MUSIC_ENABLED,
    /**
     * Calypso's conversational voice console. PARKED 2026-08-09.
     *
     * Not a latency hold — that was fixable and partly fixed. The blocker is
     * that a skipper cannot tell a misheard question from a heard one. The
     * reply arrives spoken, fluent and confident either way, so a wrong answer
     * and a right answer are indistinguishable at the moment of use. On a boat
     * that is a hazard, and no amount of streaming or prompt work addresses
     * it: the failure is in the ear, not the mouth.
     *
     * Shipping it flaky also cost more than itself. A skipper who learns the
     * voice assistant is unreliable has no way to know the anchor watch and
     * the MOB button are not — and those work.
     *
     * WHAT STAYS ON, deliberately: services/voice/safetyTts.ts. MAYDAY, DSC
     * and radio position reports are not Calypso. They are scripted text the
     * skipper has already read on screen, spoken through a path that races
     * ElevenLabs against a budget and falls back to the OS voice — designed
     * from the start to survive exactly the failures that parked the console.
     * Nothing in that path routes through here.
     *
     * Also still on: ttsClient (safetyTts depends on it) and every alarm chime.
     *
     * TO BRING HIM BACK the ear has to be fixed first — on-device recognition
     * with a confidence floor, and a spoken read-back of what was heard before
     * anything is answered. The offline helm grammar
     * (services/voice/helmGrammar.ts) is the shape the return should take: it
     * refuses rather than guesses. It currently has no entry point of its own,
     * so it is dark while this flag is false.
     */
    calypsoConsole: false,
    /**
     * Calypso's proactive NMEA threshold monitor is foreground JavaScript:
     * iOS may suspend it in the background or terminate it, HTML audio/TTS is
     * not a Critical Alert, and no native watchdog currently owns its rules.
     * Keep it fail-closed for public beta so it cannot be mistaken for an
     * independent vessel alarm. The on-demand console is parked too — see
     * calypsoConsole above.
     */
    calypsoAlerts: false,
    /**
     * The retired UDP bridge only supports Capacitor 3. Native AIS reception
     * remains available, but public-beta builds must not offer an uplink that
     * cannot run on the Capacitor 8 shell.
     */
    aisHub: false,
    /**
     * Precise voyage-track publishing and community browsing are held for the
     * public beta. The legacy data model has no explicit audience boundary and
     * stores complete recorded geometry, so every UI and service path must stay
     * fail-closed until an audience-safe replacement ships.
     */
    communityTrackSharing: false,
    /**
     * Guardian proximity/broadcast. HELD until 2026-08-06, when the hold's
     * stated blocker — "a hostile authenticated client can spoof movement and
     * scan for nearby vessels" — was closed by migration
     * 20260804191000_guardian_presence_privacy.sql (Shane 2026-08-06: "i am
     * unsure why we cannot have that in the beta"). That migration:
     *   · DROPs thalassa_users_nearby, the arbitrary-coordinate scan. Its
     *     replacement, nearby_guardians(radius_nm), takes NO query point — it
     *     searches from the caller's own stored presence only.
     *   · Restricts guardian_heartbeat to `WHERE user_id = auth.uid() AND
     *     armed IS TRUE`, so a client can only move ITSELF, never another
     *     vessel, and only while it is itself discoverable.
     *   · NULLs last_known_lat/at on disarm, so leaving the watch removes you
     *     from the index rather than freezing a last position in it.
     *   · Returns armed profiles seen inside 5 minutes only, minimal columns,
     *     behind consume_edge_quota(..., 180, 3600) on both RPCs.
     *   · Adds BEFORE INSERT triggers that reject broadcasts from disarmed
     *     profiles and keep mmsi_verified server-owned.
     * Residual risk, stated plainly: a client can still lie about its OWN
     * position. It cannot scan from that lie beyond its own radius, cannot
     * exceed the quota, and is visible only to other armed vessels — the same
     * exposure the skipper opts into by arming. That is a tolerable beta
     * posture; arbitrary scanning was not.
     * Requires the migration to be deployed to the live project.
     */
    guardian: true,
} as const;
