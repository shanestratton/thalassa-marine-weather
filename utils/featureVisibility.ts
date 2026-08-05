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
     * Guardian proximity/broadcast is held for public beta. Its current
     * server contract cannot yet prevent a hostile authenticated client from
     * spoofing movement and scanning for nearby vessels. Keep every entry
     * point and background heartbeat off until the redesigned, integration-
     * tested privacy boundary is deployed.
     */
    guardian: false,
} as const;
