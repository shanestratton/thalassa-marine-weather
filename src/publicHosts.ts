/**
 * publicHosts — which <label>.thalassawx.{app,com} names belong to boats, and
 * which belong to Thalassa itself.
 *
 * Every one-label subdomain used to be a boat's voyage log (middleware.ts), so
 * a boat named "Ocean" would have owned ocean.thalassawx.app, and the public
 * Thalassa Ocean page (Shane 2026-10-05: "call it ocean.thalassawx.app") would
 * have served a stranger's empty voyage log instead. These names are reserved
 * for Thalassa: no boat can claim one (the voyage_log_configs CHECK in
 * supabase/migrations/20261006120000_ocean_public_read.sql uses the same list,
 * and tests/ocean/ReservedHandles.test.ts keeps the two equal), the app skips
 * them when it derives a handle, and the renderer never reads one as a boat.
 *
 * ZERO imports on purpose: the edge middleware bundles this file, and so does
 * the app.
 */

/** Names no boat may hold. Lowercase slugs; keep equal to the SQL ARRAY. */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
    'ocean',
    'watch',
    'tiles',
    'api',
    'sightings',
    'seabed',
    'www',
    'app',
    'mail',
    'admin',
    'status',
    'docs',
    'help',
    'support',
    'cdn',
    'static',
    'assets',
    'auth',
    'login',
    'dev',
    'staging',
    'preview',
    'embed',
    'data',
    'map',
    'maps',
]);

const RESERVED = new Set(RESERVED_HANDLES);

/** True when no boat may hold this handle (compared lowercase and trimmed). */
export function isReservedHandle(handle: string | null | undefined): boolean {
    return RESERVED.has(
        String(handle ?? '')
            .trim()
            .toLowerCase(),
    );
}

/** The server's name for its reserved-handle CHECK on voyage_log_configs. */
export const RESERVED_HANDLE_CONSTRAINT = 'voyage_log_configs_handle_not_reserved';

/** True when a PostgREST error is that CHECK refusing a reserved handle (23514). */
export function isReservedHandleRefusal(error: { code?: string; message?: string } | null | undefined): boolean {
    return error?.code === '23514' && String(error?.message ?? '').includes(RESERVED_HANDLE_CONSTRAINT);
}

/** The public fleet page's own label, and its canonical origin. */
export const OCEAN_LABEL = 'ocean';
export const OCEAN_CANONICAL = 'https://ocean.thalassawx.app';
/** Labels that are simply other doors to the ocean page: they redirect to it. */
export const OCEAN_ALIASES: readonly string[] = Object.freeze(['watch', 'sightings', 'seabed']);

export type PublicHostKind = 'ocean' | 'ocean-redirect' | 'reserved' | 'boat';

export interface PublicHost {
    kind: PublicHostKind;
    /** The single label before the apex, lowercased. */
    label: string;
    tld: 'app' | 'com';
}

/**
 * Classify a request's Host header. null: not a one-label thalassawx host at
 * all (the apex, a lookalike, two labels deep), so normal routing applies.
 *  - ocean on .app: the ocean page itself;
 *  - ocean on .com, and watch/sightings/seabed on either: a 308 to the
 *    canonical ocean origin (one address to share, index and cache);
 *  - any other reserved label (www, api, tiles, …): passes through to the app;
 *  - everything else: a boat's public pages, exactly as before.
 */
export function classifyPublicHost(host: string | null | undefined): PublicHost | null {
    const match = String(host ?? '').match(/^([a-z0-9-]+)\.thalassawx\.(app|com)(?::\d+)?$/i);
    if (!match) return null;
    const label = match[1].toLowerCase();
    const tld = match[2].toLowerCase() as 'app' | 'com';
    if (label === OCEAN_LABEL) return { kind: tld === 'app' ? 'ocean' : 'ocean-redirect', label, tld };
    if (OCEAN_ALIASES.includes(label)) return { kind: 'ocean-redirect', label, tld };
    if (RESERVED.has(label)) return { kind: 'reserved', label, tld };
    return { kind: 'boat', label, tld };
}

/**
 * The apex and www (either TLD) also answer /ocean and /ocean/<path>, since
 * vercel.json rewrites those paths on every host for local previews. On a
 * Thalassa host they redirect to the one canonical page instead, because the
 * page's data (/api/ocean/*) answers only on ocean.thalassawx.app: one host
 * means one CDN cache key. null when this request is not one of those.
 */
export function oceanPathRedirect(host: string | null | undefined, url: URL): string | null {
    if (!/^(?:www\.)?thalassawx\.(?:app|com)(?::\d+)?$/i.test(String(host ?? ''))) return null;
    const m = url.pathname.match(/^\/ocean(\/.*)?$/);
    if (!m) return null;
    return `${OCEAN_CANONICAL}${m[1] || '/'}${url.search}`;
}
