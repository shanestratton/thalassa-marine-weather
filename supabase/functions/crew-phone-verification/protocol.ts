export const PHONE_HMAC_VERSION = 1;
export const VERIFICATION_TTL_SECONDS = 600;

const ISO_COUNTRY = /^[A-Z]{2}$/;
const PHONE_INPUT = /^[+0-9().\s-]{5,32}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const OTP = /^[0-9]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CrewPhoneAction = 'status' | 'start' | 'check';

export function parseAction(value: unknown): CrewPhoneAction | null {
    return value === 'status' || value === 'start' || value === 'check' ? value : null;
}

export function parsePhoneStart(
    phone: unknown,
    countryCode: unknown,
): { phone: string; countryCode: string } | null {
    if (typeof phone !== 'string' || typeof countryCode !== 'string') return null;
    const trimmedPhone = phone.trim();
    const normalisedCountry = countryCode.trim().toUpperCase();
    if (!PHONE_INPUT.test(trimmedPhone) || !ISO_COUNTRY.test(normalisedCountry)) return null;
    // Some valid national formats are short (for example, Vanuatu mobiles
    // have seven local digits). Lookup, then strict E.164, is authoritative.
    if ((trimmedPhone.match(/[0-9]/g) ?? []).length < 5) return null;
    return { phone: trimmedPhone, countryCode: normalisedCountry };
}

export function parseVerificationCode(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return OTP.test(trimmed) ? trimmed : null;
}

export function isE164(value: unknown): value is string {
    return typeof value === 'string' && E164.test(value);
}

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

export function lastFour(e164: string): string {
    return e164.slice(-4);
}

export function clientAddress(req: Request): string | null {
    const cloudflare = req.headers.get('cf-connecting-ip')?.trim();
    if (cloudflare && cloudflare.length <= 64) return cloudflare;

    const realIp = req.headers.get('x-real-ip')?.trim();
    if (realIp && realIp.length <= 64) return realIp;
    return null;
}

export async function keyedFingerprint(secret: string, domain: string, value: string): Promise<string> {
    if (secret.length < 32 || secret.length > 512) throw new Error('Invalid HMAC configuration');
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`thalassa:${domain}:v1:${value}`)),
    );
    return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
