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
export const FEATURE_VISIBILITY = {
    /** The Crew List — discreet skipper / crew introductions. */
    crewFinder: true,
    /**
     * Paid Spoonacular catalogue, generated meal plans, and provider images.
     * Personal, community, and offline galley features remain available.
     */
    spoonacular: false,
    /**
     * Apple Music needs the production MusicKit capability, matching
     * distribution profile, and a physical-device authorization smoke.
     * Keep every route/tool hidden until that external release boundary is
     * complete; Calypso voice itself remains available.
     */
    appleMusic: false,
    /**
     * Calypso's proactive NMEA threshold monitor is foreground JavaScript:
     * iOS may suspend it in the background or terminate it, HTML audio/TTS is
     * not a Critical Alert, and no native watchdog currently owns its rules.
     * Keep it fail-closed for public beta so it cannot be mistaken for an
     * independent vessel alarm. Calypso's on-demand voice console remains on.
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
