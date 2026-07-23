const MAX_NAVIGATION_URL_LENGTH = 4096;
const MAX_INLINE_IMAGE_URL_LENGTH = 20 * 1024 * 1024;
const MAX_INLINE_DOCUMENT_URL_LENGTH = 64 * 1024 * 1024;

function isCleanUrlText(value: unknown, maxLength = MAX_NAVIGATION_URL_LENGTH): value is string {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127) return false;
    }
    return true;
}

/**
 * Validate an absolute web URL before putting network/user supplied data into
 * href, src, or a new browsing context. Credentials are deliberately rejected:
 * `https://trusted.example@evil.test/` is visually deceptive even though the
 * URL parser correctly treats evil.test as the host.
 */
export function safeExternalHttpUrl(value: unknown, httpsOnly = false): string | null {
    if (!isCleanUrlText(value)) return null;
    try {
        const parsed = new URL(value);
        if (parsed.username || parsed.password) return null;
        if (parsed.protocol !== 'https:' && (httpsOnly || parsed.protocol !== 'http:')) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

const SAFE_INLINE_DOCUMENT =
    /^data:(?:application\/pdf|text\/plain|image\/(?:png|jpeg|gif|webp|heic|heif))(?:;charset=[a-z0-9._-]+)?;base64,/i;
const SAFE_INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|heic|heif);base64,/i;
const SAFE_LOCAL_IMAGE_PATH = /^(?:\/(?!\/)|\.{1,2}\/)[^\\]*$/;

function securityOriginKey(value: string): string | null {
    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'blob:') return securityOriginKey(parsed.pathname);
        if (parsed.origin !== 'null') return parsed.origin.toLowerCase();
        if (parsed.host) return `${parsed.protocol}//${parsed.host}`.toLowerCase();
        return null;
    } catch {
        return null;
    }
}

export interface SafeUrlOptions {
    /**
     * Permit cleartext image/document access only to loopback, RFC1918,
     * link-local, and mDNS `.local` hosts. Boat LAN appliances cannot
     * generally obtain public TLS certificates, so callers must opt in.
     */
    allowLocalNetworkHttp?: boolean;
}

function isLocalNetworkHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)) return true;

    const octets = host.split('.');
    if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
    const nums = octets.map(Number);
    if (nums.some((part) => part > 255)) return false;
    return (
        nums[0] === 10 ||
        nums[0] === 127 ||
        (nums[0] === 169 && nums[1] === 254) ||
        (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) ||
        (nums[0] === 192 && nums[1] === 168)
    );
}

function isAllowedLocalNetworkHttp(parsed: URL, options?: SafeUrlOptions): boolean {
    return (
        options?.allowLocalNetworkHttp === true &&
        parsed.protocol === 'http:' &&
        isLocalNetworkHostname(parsed.hostname)
    );
}

export function safeImageUrl(value: unknown, currentOrigin?: string, options?: SafeUrlOptions): string | null {
    if (isCleanUrlText(value, MAX_INLINE_IMAGE_URL_LENGTH) && SAFE_INLINE_IMAGE.test(value)) return value;
    if (!isCleanUrlText(value)) return null;

    // Vite/public assets remain relative so they work under HTTPS, localhost,
    // and Capacitor's custom origin without broadening the protocol allowlist.
    if (SAFE_LOCAL_IMAGE_PATH.test(value)) return value;

    const webUrl = safeExternalHttpUrl(value, true);
    if (webUrl) return webUrl;

    try {
        const parsed = new URL(value);
        if (!currentOrigin || parsed.username || parsed.password) return null;
        const currentKey = securityOriginKey(currentOrigin);
        if (!currentKey) return null;

        // Local development can legitimately serve object storage or previews
        // over HTTP, but never allow a cross-origin insecure image.
        if (
            parsed.protocol === 'http:' &&
            (securityOriginKey(parsed.href) === currentKey || isAllowedLocalNetworkHttp(parsed, options))
        ) {
            return parsed.href;
        }
        if (parsed.protocol !== 'blob:') return null;
        return securityOriginKey(parsed.href) === currentKey ? parsed.href : null;
    } catch {
        return null;
    }
}

/**
 * Browser-viewable document URLs. HTML, SVG, scriptable data URLs, foreign
 * blob origins, credentials, and non-web schemes all fail closed.
 */
export function safeDocumentNavigationUrl(
    value: unknown,
    currentOrigin?: string,
    options?: SafeUrlOptions,
): string | null {
    if (isCleanUrlText(value, MAX_INLINE_DOCUMENT_URL_LENGTH) && SAFE_INLINE_DOCUMENT.test(value)) return value;
    if (!isCleanUrlText(value)) return null;

    const webUrl = safeExternalHttpUrl(value, true);
    if (webUrl) return webUrl;

    try {
        const parsed = new URL(value);
        if (!currentOrigin || parsed.username || parsed.password) return null;
        const currentKey = securityOriginKey(currentOrigin);
        if (!currentKey) return null;
        if (
            parsed.protocol === 'http:' &&
            (securityOriginKey(parsed.href) === currentKey || isAllowedLocalNetworkHttp(parsed, options))
        ) {
            return parsed.href;
        }
        if (parsed.protocol !== 'blob:') return null;
        return securityOriginKey(parsed.href) === currentKey ? parsed.href : null;
    } catch {
        return null;
    }
}
