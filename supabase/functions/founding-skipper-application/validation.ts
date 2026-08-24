export const BOAT_TYPES = ['sail_monohull', 'sail_multihull', 'power', 'trailer_boat', 'other'] as const;
export const APPLE_DEVICES = ['iphone', 'ipad', 'iphone_and_ipad'] as const;
export const BOATING_FREQUENCIES = ['weekly_plus', 'fortnightly', 'monthly', 'less_often'] as const;
export const INTERESTS = [
    'marine_weather',
    'passage_planning',
    'float_plans',
    'anchor_watch',
    'voyage_logging',
    'onboard_data',
] as const;

const ALLOWED_KEYS = new Set([
    'name',
    'email',
    'boatType',
    'homeWaters',
    'appleDevice',
    'boatingFrequency',
    'interests',
    'notes',
    'consent',
    'source',
    'website',
]);
const INLINE_CONTROL = /[\u0000-\u001f\u007f]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SOURCE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;

export interface ValidatedFoundingSkipperApplication {
    name: string;
    email: string;
    boatType: (typeof BOAT_TYPES)[number];
    homeWaters: string;
    appleDevice: (typeof APPLE_DEVICES)[number];
    boatingFrequency: (typeof BOATING_FREQUENCIES)[number];
    interests: Array<(typeof INTERESTS)[number]>;
    notes: string | null;
    source: string;
    honeypotTriggered: boolean;
}

export interface ValidationResult {
    value: ValidatedFoundingSkipperApplication | null;
    fields: string[];
}

function inline(value: unknown, min: number, max: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    return normalized.length >= min && normalized.length <= max && !INLINE_CONTROL.test(normalized) ? normalized : null;
}

function multiline(value: unknown, max: number): string | null {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') return null;
    const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
    return normalized.length <= max && !MULTILINE_CONTROL.test(normalized) ? normalized : null;
}

function member<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
    return typeof value === 'string' && allowed.includes(value as T[number]) ? (value as T[number]) : null;
}

export function validateFoundingSkipperApplication(body: Record<string, unknown>): ValidationResult {
    const fields: string[] = [];
    for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) fields.push('form');

    const name = inline(body.name, 2, 80);
    if (!name) fields.push('name');

    const rawEmail = inline(body.email, 3, 254);
    const email = rawEmail?.toLowerCase() ?? null;
    if (!email || !EMAIL.test(email)) fields.push('email');

    const boatType = member(body.boatType, BOAT_TYPES);
    if (!boatType) fields.push('boatType');

    const homeWaters = inline(body.homeWaters, 2, 120);
    if (!homeWaters) fields.push('homeWaters');

    const appleDevice = member(body.appleDevice, APPLE_DEVICES);
    if (!appleDevice) fields.push('appleDevice');

    const boatingFrequency = member(body.boatingFrequency, BOATING_FREQUENCIES);
    if (!boatingFrequency) fields.push('boatingFrequency');

    const rawInterests = Array.isArray(body.interests) ? body.interests : [];
    const interests = [
        ...new Set(rawInterests.map((interest) => member(interest, INTERESTS)).filter(Boolean)),
    ] as Array<(typeof INTERESTS)[number]>;
    if (rawInterests.length < 1 || rawInterests.length > INTERESTS.length || interests.length !== rawInterests.length) {
        fields.push('interests');
    }

    const notes = multiline(body.notes, 800);
    if (notes === null) fields.push('notes');

    const sourceCandidate = typeof body.source === 'string' ? body.source.trim().toLowerCase() : 'direct';
    const source = SOURCE.test(sourceCandidate) ? sourceCandidate : null;
    if (!source) fields.push('source');

    if (body.consent !== true) fields.push('consent');

    const website = typeof body.website === 'string' ? body.website.trim() : '';
    const uniqueFields = [...new Set(fields)];
    if (
        uniqueFields.length > 0 ||
        !name ||
        !email ||
        !boatType ||
        !homeWaters ||
        !appleDevice ||
        !boatingFrequency ||
        notes === null ||
        !source
    ) {
        return { value: null, fields: uniqueFields };
    }

    return {
        value: {
            name,
            email,
            boatType,
            homeWaters,
            appleDevice,
            boatingFrequency,
            interests,
            notes: notes || null,
            source,
            honeypotTriggered: website.length > 0,
        },
        fields: [],
    };
}
