const THALASSA_VERCEL_PREVIEW_HOST = /^thalassa-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-serene-summer\.vercel\.app$/;

/**
 * The automation bypass is a long-lived credential for every protected
 * deployment in the Vercel project. It may only be sent to Thalassa preview
 * hosts owned by the `serene-summer` Vercel account.
 */
export function isTrustedThalassaVercelPreviewOrigin(raw: string): boolean {
    try {
        const url = new URL(raw);
        return (
            url.protocol === 'https:' &&
            url.username === '' &&
            url.password === '' &&
            url.port === '' &&
            url.pathname === '/' &&
            url.search === '' &&
            url.hash === '' &&
            THALASSA_VERCEL_PREVIEW_HOST.test(url.hostname.toLowerCase())
        );
    } catch {
        return false;
    }
}
