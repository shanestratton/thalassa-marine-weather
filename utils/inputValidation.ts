/**
 * Input Validation — Centralized validation for all user-facing forms.
 *
 * Used by onboarding, vessel details, crew finder, marketplace, and diary forms
 * to normalize markup and keep invalid data from reaching the backend.
 */

// ── Plain-text normalization ────────────────────────────────────

function isAsciiWordCharacter(character: string | undefined): boolean {
    if (!character) return false;
    const code = character.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);
}

function startsWithAsciiCaseInsensitive(value: string, index: number, expected: string): boolean {
    if (index + expected.length > value.length) return false;
    for (let offset = 0; offset < expected.length; offset += 1) {
        if (value[index + offset].toLowerCase() !== expected[offset]) return false;
    }
    return true;
}

function normalizeLegacyPlainText(value: string): string {
    let normalized = '';

    for (let index = 0; index < value.length; ) {
        const character = value[index];

        // DOM textContent can legitimately contain encoded angle brackets. Drop
        // them so this function's result remains plain text if it is stored and
        // later passed through an HTML-oriented transport.
        if (character === '<' || character === '>') {
            index += 1;
            continue;
        }

        if (startsWithAsciiCaseInsensitive(value, index, 'javascript')) {
            let end = index + 'javascript'.length;
            while (end < value.length && value[end].trim() === '') end += 1;
            if (value[end] === ':') {
                index = end + 1;
                continue;
            }
        }

        const startsAtWordBoundary = index === 0 || !isAsciiWordCharacter(value[index - 1]);
        if (startsAtWordBoundary && character.toLowerCase() === 'o' && value[index + 1]?.toLowerCase() === 'n') {
            let end = index + 2;
            const handlerNameStart = end;
            while (end < value.length && isAsciiWordCharacter(value[end])) end += 1;
            if (end > handlerNameStart) {
                while (end < value.length && value[end].trim() === '') end += 1;
                if (value[end] === '=') {
                    index = end + 1;
                    continue;
                }
            }
        }

        normalized += character;
        index += 1;
    }

    return normalized.trim();
}

/**
 * Convert user input into inert plain text for names, descriptions, and search
 * fields. This is not contextual HTML escaping: callers must still render the
 * result through text APIs/JSX rather than assigning it to innerHTML.
 */
export function sanitizeText(input: string): string {
    if (!input || typeof input !== 'string') return '';
    const parsed = new DOMParser().parseFromString(input, 'text/html');
    parsed.querySelectorAll('script, style, template, noscript').forEach((element) => element.remove());

    return normalizeLegacyPlainText(parsed.body?.textContent ?? '');
}

// ── Field Validators ────────────────────────────────────────────

export interface ValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validate a display name (chat profile, crew listing, etc.)
 * Rules: 2-40 chars, no HTML, no slurs (delegated to content moderation)
 */
export function validateDisplayName(name: string): ValidationResult {
    const clean = sanitizeText(name);
    if (clean.length < 2) return { valid: false, error: 'Name must be at least 2 characters' };
    if (clean.length > 40) return { valid: false, error: 'Name must be 40 characters or less' };
    if (clean !== name.trim()) return { valid: false, error: 'Name contains invalid characters' };
    return { valid: true };
}

/**
 * Validate a vessel name.
 * Rules: 1-60 chars, no HTML
 */
export function validateVesselName(name: string): ValidationResult {
    const clean = sanitizeText(name);
    if (clean.length < 1) return { valid: false, error: 'Vessel name is required' };
    if (clean.length > 60) return { valid: false, error: 'Vessel name must be 60 characters or less' };
    return { valid: true };
}

/**
 * Validate a marketplace listing title.
 * Rules: 3-120 chars, no HTML
 */
export function validateListingTitle(title: string): ValidationResult {
    const clean = sanitizeText(title);
    if (clean.length < 3) return { valid: false, error: 'Title must be at least 3 characters' };
    if (clean.length > 120) return { valid: false, error: 'Title must be 120 characters or less' };
    return { valid: true };
}

/**
 * Validate a price field.
 * Rules: positive number, max 10M, no NaN
 */
export function validatePrice(value: string | number): ValidationResult {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return { valid: false, error: 'Price must be a valid number' };
    if (num < 0) return { valid: false, error: 'Price cannot be negative' };
    if (num > 10_000_000) return { valid: false, error: 'Price exceeds maximum allowed' };
    return { valid: true };
}

/**
 * Validate a description/bio field.
 * Rules: max 2000 chars, no script tags
 */
export function validateDescription(text: string): ValidationResult {
    const clean = sanitizeText(text);
    if (clean.length > 2000) return { valid: false, error: 'Description must be 2000 characters or less' };
    return { valid: true };
}

/**
 * Validate latitude coordinate.
 */
export function validateLatitude(lat: number): ValidationResult {
    if (isNaN(lat)) return { valid: false, error: 'Invalid latitude' };
    if (lat < -90 || lat > 90) return { valid: false, error: 'Latitude must be between -90 and 90' };
    return { valid: true };
}

/**
 * Validate longitude coordinate.
 */
export function validateLongitude(lon: number): ValidationResult {
    if (isNaN(lon)) return { valid: false, error: 'Invalid longitude' };
    if (lon < -180 || lon > 180) return { valid: false, error: 'Longitude must be between -180 and 180' };
    return { valid: true };
}

/**
 * Validate email address.
 * Simple regex — not RFC-perfect but catches 99% of bad input.
 */
export function validateEmail(email: string): ValidationResult {
    if (!email || typeof email !== 'string') return { valid: false, error: 'Email is required' };
    const trimmed = email.trim();
    if (trimmed.length > 254) return { valid: false, error: 'Email is too long' };
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(trimmed)) return { valid: false, error: 'Please enter a valid email address' };
    return { valid: true };
}

/**
 * Validate a search/location query.
 * Prevents overly long or potentially dangerous queries.
 */
export function validateSearchQuery(query: string): ValidationResult {
    if (!query || typeof query !== 'string') return { valid: false, error: 'Search query is required' };
    const clean = sanitizeText(query);
    if (clean.length > 200) return { valid: false, error: 'Search query is too long' };
    return { valid: true };
}
