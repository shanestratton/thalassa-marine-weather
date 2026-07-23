/** RSS is untrusted XML. Only credential-free HTTPS URLs leave the function. */
export function safeRssHttpsUrl(value: unknown): string | null {
    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 4096 ||
        [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
    ) {
        return null;
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
        return parsed.href;
    } catch {
        return null;
    }
}
