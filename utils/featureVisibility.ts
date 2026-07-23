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
 * Hidden 2026-05-20 (Shane): hold Marketplace + Crew Finder until we
 * have more punters. Music + Diary stay (watch/passage essentials);
 * Scuttlebutt unchanged.
 */
export const FEATURE_VISIBILITY = {
    /** Peer-to-peer Chandlery / Marketplace (buy/sell/trade gear + boats). */
    marketplace: false,
    /** Crew Finder / Lonely Hearts (crew + berth connections). */
    crewFinder: false,
    /**
     * Paid Spoonacular catalogue, generated meal plans, and provider images.
     * Personal, community, and offline galley features remain available.
     */
    spoonacular: false,
} as const;
