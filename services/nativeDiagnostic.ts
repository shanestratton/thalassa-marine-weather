import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import { redactSensitiveDiagnostic } from '../utils/redactSensitiveDiagnostic';

export interface NativeDiagnosticWriter {
    set(options: { key: string; value: string }): Promise<unknown>;
}

/**
 * Persist one diagnostic without putting credentials in durable storage or
 * allowing an account-A callback to write into account B's namespace.
 */
export async function writeScopedNativeDiagnostic(
    preferences: NativeDiagnosticWriter,
    baseKey: string,
    value: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    await preferences.set({
        key: authScopedStorageKey(baseKey, scope),
        value: redactSensitiveDiagnostic(value),
    });
    return isAuthIdentityScopeCurrent(scope);
}
