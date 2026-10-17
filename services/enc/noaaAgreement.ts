import { Preferences } from '@capacitor/preferences';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';

import { NOAA_AGREEMENT_SHA256, NOAA_ENC_ORIGIN } from './noaaAgreementIdentity';
export { NOAA_AGREEMENT_URL, NOAA_ENC_ORIGIN, NOAA_AGREEMENT_SHA256 } from './noaaAgreementIdentity';
const KEY = 'thalassa_noaa_enc_agreement_v1';
const MAX_TEXT_BYTES = 8192;

async function textHash(text: string): Promise<string> {
    // Git/native packaging can change line endings. The government text's
    // canonical LF hash is stable across those platforms; content still has
    // to match exactly after that one normalization.
    const bytes = new TextEncoder().encode(text.replace(/\r\n?/g, '\n'));
    if (!bytes.length || bytes.length > MAX_TEXT_BYTES) throw Error('NOAA agreement text is unavailable.');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Always show the bundled, byte-verified government text. An offline web
 * cache miss must not be interpreted as acceptance or silently omit terms. */
export async function loadNoaaAgreementText(signal?: AbortSignal): Promise<string> {
    const response = await fetch(`${import.meta.env.BASE_URL || '/'}data/noaa-enc-user-agreement.txt`, {
        credentials: 'omit',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (!response.ok || !response.body) throw Error('NOAA agreement text is unavailable.');
    const advertised = response.headers.get('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_TEXT_BYTES))
        throw Error('NOAA agreement text is unavailable.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > MAX_TEXT_BYTES) throw Error('NOAA agreement text is unavailable.');
            chunks.push(part.value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if ((await textHash(text)) !== NOAA_AGREEMENT_SHA256)
        throw Error('NOAA agreement text has changed. Check for an app update.');
    return text;
}

/** A consent is bound to the account and exact agreement version. Neither
 * legacy imported cells nor another account's record imply acceptance. */
export async function noaaAgreementAccepted(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<boolean> {
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const { value } = await Preferences.get({ key: authScopedStorageKey(KEY, scope) });
        if (!isAuthIdentityScopeCurrent(scope) || !value || value.length > 1024) return false;
        const record: unknown = JSON.parse(value);
        if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
        const item = record as Record<string, unknown>;
        return (
            item.schema === 1 &&
            item.hash === NOAA_AGREEMENT_SHA256 &&
            item.scope === scope.key &&
            item.origin === NOAA_ENC_ORIGIN &&
            typeof item.acceptedAt === 'number' &&
            Number.isFinite(item.acceptedAt) &&
            item.acceptedAt > 0 &&
            item.acceptedAt <= Date.now() + 300_000
        );
    } catch {
        return false;
    }
}

export async function acceptNoaaAgreement(
    text: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    if (
        !isAuthIdentityScopeCurrent(scope) ||
        (await textHash(text)) !== NOAA_AGREEMENT_SHA256 ||
        !isAuthIdentityScopeCurrent(scope)
    )
        return false;
    await Preferences.set({
        key: authScopedStorageKey(KEY, scope),
        value: JSON.stringify({
            schema: 1,
            hash: NOAA_AGREEMENT_SHA256,
            scope: scope.key,
            origin: NOAA_ENC_ORIGIN,
            acceptedAt: Date.now(),
        }),
    });
    return isAuthIdentityScopeCurrent(scope) && noaaAgreementAccepted(scope);
}
