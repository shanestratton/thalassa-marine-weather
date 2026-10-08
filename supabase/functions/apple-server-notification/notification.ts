/**
 * What Thalassa does with a verified Sign in with Apple server-to-server event.
 * No HTTP or Supabase clients here, so the decisions are behaviour-tested
 * (notification_test.ts); index.ts verifies Apple's JWS and wires the effects.
 *
 * Apple's event semantics, from "Processing changes for Sign in with Apple
 * accounts" (https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts,
 * read 2026-10-08):
 * - consent-revoked: "The user revokes consent for your app to use their Apple
 *   Account and their credentials become invalid." That is a SIGN-OUT: end the
 *   user's sessions and drop the now-dead stored Apple token. The Thalassa
 *   account and its data stay; the sailor can sign in again (with fresh Apple
 *   consent) or by email. Until build 123 this event went to full account
 *   deletion.
 *   TN3194 ("Respond to credential revoked notifications",
 *   https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
 *   says Apple broadcasts consent-revoked after the app's OWN /auth/revoke too.
 *   In-app deletion revokes as its first step, before storage, scrub and the
 *   auth delete, so this event normally lands while that deletion is still
 *   running. Then nothing is touched: a deletion resumed in
 *   apple_revocation_state 'revoking' fails closed if the token row has gone,
 *   and ending the sessions would stop the app retrying its own deletion. The
 *   deletion removes the row and every session when it completes.
 * - account-deleted: "The user requests that Apple permanently delete their
 *   Apple Account." Apple invalidates every token itself; the account goes
 *   through the same durable, resumable deletion processor as in-app deletion.
 * - email-enabled / email-disabled: Hide My Email forwarding; nothing to do.
 *
 * Every actionable event older than the user's latest Apple sign-in (the
 * stored token row's updated_at, bumped by every sign-in) is acknowledged and
 * ignored: it describes an authorization the sailor has since replaced.
 */
import type { VerifiedAppleServerNotification } from '../_shared/apple-auth.ts';

/** The stored-token row an Apple subject resolves to. */
export interface AppleTokenOwner {
    userId: string;
    /** The row's updated_at: the user's latest successful Apple sign-in. */
    updatedAt: string;
}

/** A verified account-deleted event as written to apple_server_notification_queue. */
export interface AppleAccountDeletionQueueRow {
    jti: string;
    event_type: 'account-deleted';
    apple_subject_sha256: string;
    user_id: string;
    event_time: string;
    issued_at: string;
}

export interface AppleNotificationDependencies {
    sha256Hex(value: string): Promise<string>;
    /** Resolve the subject's stored-token row, or null. Rejects when the lookup fails. */
    loadTokenOwner(subjectSha256: string): Promise<AppleTokenOwner | null>;
    /**
     * Whether an account deletion job exists for the user (the same test the
     * deletion write fence uses). Rejects when the lookup fails.
     */
    accountDeletionInProgress(userId: string): Promise<boolean>;
    /** End every Supabase session the user started at or before this instant. Rejects on failure. */
    signOutUserSessions(userId: string, startedAtOrBefore: Date): Promise<void>;
    /** Delete the stored Apple token, but only while it still has `expectedUpdatedAt`. Rejects on failure. */
    deleteStoredAppleToken(userId: string, subjectSha256: string, expectedUpdatedAt: string): Promise<void>;
    /** Durably record the event (idempotent on jti). Rejects on failure. */
    queueAccountDeletion(row: AppleAccountDeletionQueueRow): Promise<void>;
    /** Ask delete-account to process the queued event. Rejects when the request cannot be made. */
    runAccountDeletion(jti: string): Promise<{ ok: boolean; status: number; deleted: boolean }>;
    markQueueFailed(jti: string, code: string): Promise<void>;
    logError(message: string): void;
}

export interface AppleNotificationResult {
    status: 200 | 503;
    body: Record<string, unknown>;
}

const retry = (error: string): AppleNotificationResult => ({ status: 503, body: { error } });

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
}

export async function handleVerifiedAppleNotification(
    event: VerifiedAppleServerNotification,
    deps: AppleNotificationDependencies,
): Promise<AppleNotificationResult> {
    if (event.eventType === 'email-enabled' || event.eventType === 'email-disabled') {
        return { status: 200, body: { accepted: true, action: 'not_required' } };
    }

    const subjectSha256 = await deps.sha256Hex(event.subject);
    let owner: AppleTokenOwner | null;
    try {
        owner = await deps.loadTokenOwner(subjectSha256);
    } catch (error) {
        deps.logError(`[apple-server-notification] subject resolution failed: ${describeError(error)}`);
        return retry('Apple notification could not be processed');
    }
    // A subject with no retained token has no live Thalassa account action:
    // the account is already deleted, or a previous consent-revoked already
    // signed it out. Do not create an ownerless queue row containing a
    // provider identifier; acknowledge so Apple need not retry indefinitely.
    if (!owner) return { status: 200, body: { accepted: true, action: 'already_unlinked' } };

    const latestSignInMs = Date.parse(owner.updatedAt);
    if (!Number.isFinite(latestSignInMs)) {
        deps.logError('[apple-server-notification] stored Apple sign-in time is unreadable');
        return retry('Apple notification could not be processed');
    }
    // Apple documents event_time in whole seconds (its servers send
    // milliseconds), so an event stamped in the same second as a later sign-in
    // may read as older and is ignored: acting on it could end the sign-in
    // that just happened.
    if (event.eventTime.getTime() < latestSignInMs) {
        return { status: 200, body: { accepted: true, action: 'stale_event_ignored' } };
    }

    if (event.eventType === 'consent-revoked') {
        // An account deletion already owns this user's token row and sessions
        // (see the file header). An unknown state touches nothing either.
        let deletionInProgress: boolean;
        try {
            deletionInProgress = await deps.accountDeletionInProgress(owner.userId);
        } catch (error) {
            deps.logError(`[apple-server-notification] deletion state lookup failed: ${describeError(error)}`);
            return retry('Apple sign-out is pending retry');
        }
        if (deletionInProgress) return { status: 200, body: { accepted: true, action: 'deletion_in_progress' } };

        // Sessions first, token row second: if either step fails the row is
        // still there for Apple's retry to find. Sessions started after the
        // revocation (a later email sign-in) are not touched.
        try {
            await deps.signOutUserSessions(owner.userId, event.eventTime);
        } catch (error) {
            deps.logError(`[apple-server-notification] consent-revoked sign-out failed: ${describeError(error)}`);
            return retry('Apple sign-out is pending retry');
        }
        try {
            await deps.deleteStoredAppleToken(owner.userId, subjectSha256, owner.updatedAt);
        } catch (error) {
            deps.logError(`[apple-server-notification] stored Apple token removal failed: ${describeError(error)}`);
            return retry('Apple sign-out is pending retry');
        }
        return { status: 200, body: { accepted: true, action: 'signed_out' } };
    }

    // account-deleted: queue durably, then run the same resumable deletion
    // workflow the app uses. Apple receives success only after it completes.
    try {
        await deps.queueAccountDeletion({
            jti: event.jti,
            event_type: 'account-deleted',
            apple_subject_sha256: subjectSha256,
            user_id: owner.userId,
            event_time: event.eventTime.toISOString(),
            issued_at: event.issuedAt.toISOString(),
        });
    } catch (error) {
        deps.logError(`[apple-server-notification] durable queue write failed: ${describeError(error)}`);
        return retry('Apple notification could not be queued');
    }

    let processor: { ok: boolean; status: number; deleted: boolean };
    try {
        processor = await deps.runAccountDeletion(event.jti);
    } catch (error) {
        deps.logError(`[apple-server-notification] account processor request failed: ${describeError(error)}`);
        await deps.markQueueFailed(event.jti, 'processor_request_failed');
        return retry('Apple notification account action is pending retry');
    }
    if (!processor.ok || !processor.deleted) {
        const failureCode = `processor_http_${processor.status}`;
        deps.logError(`[apple-server-notification] account processor did not complete: ${failureCode}`);
        await deps.markQueueFailed(event.jti, failureCode);
        return retry('Apple notification account action is pending retry');
    }

    return { status: 200, body: { accepted: true, action: 'account_deleted' } };
}
