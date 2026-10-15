import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AppleCredentialState');

export interface AppleCredentialRevokedEvent {
    state: 'revoked' | 'not_found' | 'transferred' | 'unknown';
    reason: 'credential_revoked_notification' | 'cold_start' | 'explicit_check' | 'sign_in';
    /** Opaque Apple subject, used only to reject stale cross-account events. */
    userId: string;
}

/**
 * The signed-in account, for the native check (build 131, 131-01). Each
 * account's binding is its own Keychain item, keyed by its Supabase user id,
 * so signing one account out never clears another's on the same phone.
 */
export interface AppleCredentialAccount {
    /** The Supabase user id the account's Keychain item is keyed by. */
    accountId: string;
    /** Its Apple subjects: the one binding older builds kept moves to it only when it holds one of these. */
    appleUserIds: readonly string[];
}

interface AppleCredentialStatePlugin {
    bindCredential(options: { userId: string; accountId: string }): Promise<{ state: string }>;
    clearCredential(options: { accountId: string }): Promise<void>;
    checkCredentialState(options: { accountId?: string; userIds?: string[] }): Promise<{ state: string }>;
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

/** Bind this Apple user to this account's own Keychain item (accountId: its Supabase user id). */
export async function bindAppleCredentialUser(userId: string, accountId: string): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return;
    const result = await NativeAppleCredentialState.bindCredential({ userId, accountId });
    if (result.state !== 'authorized') throw new Error('Apple credential is not authorized');
}

/** Clear this account's binding, and no other account's. No account, nothing to clear. */
export async function clearBoundAppleCredential(accountId: string | null | undefined): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios' || !accountId) return;
    await NativeAppleCredentialState.clearCredential({ accountId });
}

/**
 * Attach before asking for an explicit state check so both a retained
 * cold-start event and a newly-discovered revoked state are observed. Native
 * events may be delivered more than once; serialize handling in this module:
 * a repeat of the event being handled is dropped, and an event for another
 * Apple user waits its turn instead (131-01: two bindings can report together,
 * an older build's and the signed-in account's).
 *
 * The check is of `account`'s own binding, the signed-in account's; with
 * none, of the one binding an older build kept, as before.
 */
export async function startAppleCredentialRevocationMonitoring(
    onRevoked: (event: AppleCredentialRevokedEvent) => Promise<void>,
    account: AppleCredentialAccount | null = null,
): Promise<() => Promise<void>> {
    if (Capacitor.getPlatform() !== 'ios') return async () => undefined;

    let disposed = false;
    let queue: Promise<void> | null = null;
    const handling = new Set<string>();
    const handle = await NativeAppleCredentialState.addListener('credentialRevoked', (event) => {
        if (disposed || handling.has(event.userId)) return;
        handling.add(event.userId);
        reportRevocation(event);
        const run = () => onRevoked(event).finally(() => handling.delete(event.userId));
        const next: Promise<void> = queue ? queue.then(run, run) : run();
        queue = next;
        void next
            .catch(() => undefined)
            .finally(() => {
                if (queue === next) queue = null;
            });
    });
    await NativeAppleCredentialState.checkCredentialState(
        account ? { accountId: account.accountId, userIds: [...account.appleUserIds] } : {},
    ).catch(() => {
        // A transient state-query failure is not proof of revocation. The
        // native notification listener stays active and the next cold start
        // checks again.
    });

    return async () => {
        disposed = true;
        await handle.remove();
    };
}
