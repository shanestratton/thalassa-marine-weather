/**
 * CI supplies the real public build configuration; isolated local runners may
 * use a fictional origin. Intercept the exact configured origin in either
 * case. Tests still fulfill only their named operations and abort every other
 * off-origin request; no backend/provider request is allowed to leave the test.
 */
export function fixtureBackendOrigin(fallback: string): string {
    const url = new URL(process.env.VITE_SUPABASE_URL || fallback);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Expected a public HTTPS backend origin for the intercepted fixture');
    }
    return url.origin;
}
