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
    /** Peer-to-peer Chandlery / Marketplace (buy/sell/trade gear + boats). */
    marketplace: false,
    /** The Crew List — discreet skipper / crew introductions. */
    crewFinder: true,
    /**
     * Paid Spoonacular catalogue, generated meal plans, and provider images.
     * Personal, community, and offline galley features remain available.
     */
    spoonacular: false,
} as const;
