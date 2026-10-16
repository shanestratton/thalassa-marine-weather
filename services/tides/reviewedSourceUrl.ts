/** Reviewed public endpoints use one canonical spelling. Encoded paths are
 * deliberately unsupported until their decoding rules are explicitly reviewed. */
export function canonicalReviewedSourceUrl(value: unknown): URL | null {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\p{Cc}\\?#]/u.test(value)) return null;
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname.includes('%') ||
            (value !== url.href && !(url.pathname === '/' && value === url.origin))
        )
            return null;
        return url;
    } catch {
        return null;
    }
}

/** Same canonical origin and a whole path segment, never a textual host or
 * sibling-path prefix. Both the request and final response are checked. */
export function reviewedSourceUrlMatches(value: unknown, reviewedPrefix: unknown): boolean {
    const url = canonicalReviewedSourceUrl(value),
        prefix = canonicalReviewedSourceUrl(reviewedPrefix);
    if (!url || !prefix || url.origin !== prefix.origin) return false;
    const path = prefix.pathname;
    return path === '/' || url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
}
