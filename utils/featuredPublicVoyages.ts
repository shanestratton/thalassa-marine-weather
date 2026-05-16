// Featured Public Voyages — curated handles surfaced in the Log
// tab's "Discover" section.
//
// Why curated, not query-everything
// ---------------------------------
// The `voyage_log_configs` table has RLS that only allows owners
// to SELECT their own row. There's no public-list policy and no
// `voyage-log/discover` edge endpoint (yet). Rather than ship a
// migration + new RLS policy + new endpoint for a v1, we curate
// the discover list in this file.
//
// Trade-offs of curation
// ----------------------
//   + Zero backend changes — ships today.
//   + Editorial control — Shane picks which voyages get featured,
//     so the gallery has signal not noise.
//   + Each card opens the live thalassawx.app/logs/<handle>
//     page, which fetches its own fresh data via the existing
//     voyage-log edge function — the in-app card metadata is
//     just a teaser, the real content stays fresh.
//   − Doesn't auto-update when new users enable their logs. To
//     feature a new voyage, edit this file.
//   − Stale teaser metadata if a featured voyage's route /
//     vessel name changes (the live page updates; the card
//     teaser doesn't). For a v1, that's acceptable.
//
// Future
// ------
// When the curated list outgrows ~10 voyages, ship a Supabase
// RPC `list_public_voyages()` (security definer, returns only
// public fields, no owner_id) + a paginated client fetch. The
// `<DiscoverVoyagesSection>` component already renders from a
// list, so the swap will be transparent — just change the data
// source from this file to an async fetch.

export interface FeaturedPublicVoyage {
    /** Public handle — the slug at thalassawx.app/logs/<handle> */
    handle: string;
    /** Vessel display name as it appears on the public page. */
    vesselName: string;
    /** Optional vessel type — drives the icon (⛵ sail / 🛥️ power). */
    vesselType?: 'sail' | 'power';
    /** Optional one-line route description. "Brisbane → Nouméa".
     *  Falls back to a generic "Live voyage log" if omitted. */
    route?: string;
    /** Optional short pitch — 1-2 sentences max. */
    description?: string;
    /** Optional badge text. e.g. "Active passage" / "Cruising the Pacific". */
    badge?: string;
}

/**
 * The featured list. Order matters — items render top-to-bottom
 * in the Discover section. Keep it tight (3-6 voyages) so the
 * section reads as editorial picks, not a directory dump.
 */
export const FEATURED_PUBLIC_VOYAGES: FeaturedPublicVoyage[] = [
    {
        handle: 'serene-summer',
        vesselName: 'Serene Summer',
        vesselType: 'sail',
        route: 'East Coast Australia',
        description: 'Live voyage log from a 55-foot Tayana cruising the Coral Sea.',
        badge: 'Featured',
    },
    // Add more entries by editing this file. Each entry needs a
    // matching `voyage_log_configs.enabled = true` row in Supabase
    // — the public page at thalassawx.app/logs/<handle> must
    // already resolve before you list it here.
];
