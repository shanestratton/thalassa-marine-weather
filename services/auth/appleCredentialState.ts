import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AppleCredentialState');

export interface AppleCredentialRevokedEvent {
    state: 'revoked' | 'not_found' | 'transferred' | 'unknown';
    reason: 'credential_revoked_notification' | 'cold_start' | 'explicit_check' | 'sign_in';
    /** Opaque Apple subject, used only to reject stale cross-account events. */
    userId: string;
}

interface AppleCredentialStatePlugin {
    bindCredential(options: { userId: string }): Promise<{ state: string }>;
    clearCredential(): Promise<void>;
    checkCredentialState(): Promise<{ state: string }>;
    addListener(
        eventName: 'credentialRevoked',
        listener: (event: AppleCredentialRevokedEvent) => void,
    ): Promise<PluginListenerHandle>;
}

const NativeAppleCredentialState = registerPlugin<AppleCredentialStatePlugin>('AppleCredentialState');

const REVOCATION_STATES = new Set(['revoked', 'not_found', 'transferred', 'unknown']);

/**
 * Report a handled revocation to Sentry by its reason and state alone, never
 * the Apple user id it carries. Until build 124 the sign-out it causes was
 * silent, so a kick straight after Sign in with Apple left no trace.
 */
function reportRevocation(event: AppleCredentialRevokedEvent): void {
    const reason =
        String(event.reason ?? '')
            .replace(/[^a-z_]/g, '')
            .slice(0, 40) || 'none';
    const state = REVOCATION_STATES.has(event.state) ? event.state : 'other';
    const report = `apple_credential_revoked reason=${reason} state=${state}`;
    log.error(report, new Error(report));
}

export async function bindAppleCredentialUser(userId: string): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return;
    const result = await NativeAppleCredentialState.bindCredential({ userId });
    if (result.state !== 'authorized') throw new Error('Apple credential is not authorized');
}

export async function clearBoundAppleCredential(): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return;
    await NativeAppleCredentialState.clearCredential();
}

/**
 * Attach before asking for an explicit state check so both a retained
 * cold-start event and a newly-discovered revoked state are observed. Native
 * events may be delivered more than once; serialize handling in this module.
 */
export async function startAppleCredentialRevocationMonitoring(
    onRevoked: (event: AppleCredentialRevokedEvent) => Promise<void>,
): Promise<() => Promise<void>> {
    if (Capacitor.getPlatform() !== 'ios') return async () => undefined;

    let disposed = false;
    let revocationInFlight: Promise<void> | null = null;
    const handle = await NativeAppleCredentialState.addListener('credentialRevoked', (event) => {
        if (disposed || revocationInFlight) return;
        reportRevocation(event);
        revocationInFlight = onRevoked(event).finally(() => {
            revocationInFlight = null;
        });
    });
    await NativeAppleCredentialState.checkCredentialState().catch(() => {
        // A transient state-query failure is not proof of revocation. The
        // native notification listener stays active and the next cold start
        // checks again.
    });

    return async () => {
        disposed = true;
        await handle.remove();
    };
}
