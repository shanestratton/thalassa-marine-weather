import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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
