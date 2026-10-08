/**
 * Sign in with Apple refresh-token registration: the decisions, without HTTP
 * or Supabase clients, so they can be behaviour-tested (registration_test.ts).
 *
 * Why this file is so careful about revocation: Apple's /auth/revoke ends the
 * user's whole Sign in with Apple authorization for the app, not one token
 * ("Invalidate the tokens and associated user authorizations for a user",
 * https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens).
 * Until build 123 this function revoked the previously stored token on every
 * repeat sign-in, which killed the sign-in that had just happened: the native
 * credential monitor saw "revoked" and signed the sailor out, and Apple emailed
 * them that Thalassa "has revoked your Sign in with Apple" (2026-10-08).
 *
 * The rules now:
 * - A repeat sign-in keeps the NEWEST token: the stored ciphertext is rotated
 *   to it and the old token is never revoked. One stored token per user is
 *   enough for TN3194, because revoking it at account deletion ends all of the
 *   user's authorization, older tokens included.
 * - Compensating revocation runs only for a FIRST Sign in with Apple (the
 *   caller's Apple identity was linked moments ago) whose token could not be
 *   persisted, and only on positive proof that no stored row tracks that Apple
 *   subject. Revoking a stored row at deletion ends only its own subject's
 *   authorization, so "tracked" means a row for the same subject. A first
 *   sign-in revoked here asks for fresh consent (name and email) next time.
 *   An older Apple account with no stored token (nearly all of them predate
 *   token retention) is never revoked: its authorization is live on the
 *   sailor's other devices, and account deletion already handles an untracked
 *   authorization through TN3194's manual-removal path (manual_required).
 *   Once any lookup has seen a row for this subject, nothing in the request
 *   revokes, and an unknown state never revokes.
 * - The concurrency loser never revokes. If the winner's committed row holds
 *   the same Apple subject, the winner's token covers this authorization and
 *   the sign-in succeeds; otherwise the client is told to retry.
 *
 * Authorization codes and tokens are never logged or returned.
 */

/** The parts of a stored row these decisions need. Ciphertext never comes back out. */
export interface StoredAppleToken {
    appleSubjectSha256: string;
    updatedAt: string;
}

export interface AppleTokenRow {
    refresh_token_ciphertext: string;
    refresh_token_iv: string;
    encryption_version: number;
    apple_subject_sha256: string;
    updated_at: string;
}

export interface AppleTokenRegistrationDependencies {
    exchangeAuthorizationCode(authorizationCode: string): Promise<{ refreshToken: string; idToken: string }>;
    /** Verify Apple's signature and claims; resolve the signed subject. */
    verifyIdTokenSubject(idToken: string): Promise<string>;
    sha256Hex(value: string): Promise<string>;
    encryptRefreshToken(
        refreshToken: string,
        subjectSha256: string,
    ): Promise<{ ciphertext: string; iv: string; encryptionVersion: number }>;
    /** The caller's stored row, or null. Rejects when the lookup itself fails. */
    loadStoredTokenForUser(): Promise<StoredAppleToken | null>;
    /** The row any account holds for this Apple subject, or null. Rejects when the lookup fails. */
    loadStoredTokenForSubject(subjectSha256: string): Promise<StoredAppleToken | null>;
    /** Optimistic rotation. Resolves false when no row still has `expectedUpdatedAt`; rejects on a database error. */
    rotateStoredToken(expectedUpdatedAt: string, row: AppleTokenRow): Promise<boolean>;
    /** Insert-only first registration (never an upsert). Resolves false when the insert did not happen. */
    insertStoredToken(row: AppleTokenRow): Promise<boolean>;
    /** Apple /auth/revoke. Ends the user's whole Sign in with Apple authorization for the app. */
    revokeRefreshToken(refreshToken: string): Promise<void>;
    now(): Date;
    logError(message: string): void;
}

export type AppleTokenRegistrationResult =
    | { status: 200; body: { registered: true } }
    | { status: 403 | 502; body: { error: string } }
    | { status: 409; body: { error: string; retryable: true } };

const REGISTERED: AppleTokenRegistrationResult = { status: 200, body: { registered: true } };
const REGISTRATION_FAILED: AppleTokenRegistrationResult = {
    status: 502,
    body: { error: 'Apple token registration failed; start Sign in with Apple again' },
};
const LOST_RACE: AppleTokenRegistrationResult = {
    status: 409,
    body: {
        error: 'Another Apple sign-in for this account finished at the same moment; start Sign in with Apple again',
        retryable: true,
    },
};

// How long after Supabase links an Apple identity a registration still counts
// as that first sign-in. The app registers within seconds; the slack allows a
// slow network, and a little clock skew the other way.
const FIRST_SIGN_IN_WINDOW_MS = 15 * 60_000;
const LINK_CLOCK_SKEW_MS = 2 * 60_000;

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
}

/** True only when the Apple identity was readably linked within the first-sign-in window. */
function isFirstAppleSignIn(appleIdentityLinkedAt: string | null, now: Date): boolean {
    if (!appleIdentityLinkedAt) return false;
    const linkedMs = Date.parse(appleIdentityLinkedAt);
    if (!Number.isFinite(linkedMs)) return false;
    const ageMs = now.getTime() - linkedMs;
    return ageMs >= -LINK_CLOCK_SKEW_MS && ageMs <= FIRST_SIGN_IN_WINDOW_MS;
}

/** Revoke a credential that no stored row tracks. A failure is logged; the caller's outcome stands. */
async function revokeUntrackedToken(refreshToken: string, deps: AppleTokenRegistrationDependencies): Promise<void> {
    try {
        await deps.revokeRefreshToken(refreshToken);
    } catch (error) {
        deps.logError(`[register-apple-token] compensating revocation failed: ${describeError(error)}`);
    }
}

/**
 * Another request wrote this user's row between our read and our write. Never
 * revoke here: whatever the winner stored is what account deletion will revoke.
 * When the winner's row holds the same Apple subject, its token belongs to the
 * same authorization, so revoking it at deletion also ends this sign-in's
 * token and nothing is orphaned: the sign-in succeeds. Otherwise retry.
 */
function settleLostRace(
    committed: StoredAppleToken | null,
    subjectSha256: string,
): AppleTokenRegistrationResult {
    return committed?.appleSubjectSha256 === subjectSha256 ? REGISTERED : LOST_RACE;
}

export async function registerAppleRefreshToken(
    authorizationCode: string,
    callerAppleSubject: string,
    /** When the caller's Apple identity was linked (its created_at), or null when unreadable. */
    appleIdentityLinkedAt: string | null,
    deps: AppleTokenRegistrationDependencies,
): Promise<AppleTokenRegistrationResult> {
    let refreshToken: string | null = null;
    let subjectSha256: string | null = null;
    // Set as soon as any lookup sees a stored row for this Apple subject. From
    // then on nothing in this request may revoke.
    let authorizationTracked = false;
    try {
        const tokenExchange = await deps.exchangeAuthorizationCode(authorizationCode);
        refreshToken = tokenExchange.refreshToken;
        const exchangedSubject = await deps.verifyIdTokenSubject(tokenExchange.idToken);
        subjectSha256 = await deps.sha256Hex(exchangedSubject);
        if (exchangedSubject !== callerAppleSubject) {
            // The code belongs to a different Apple subject. Revoke its token
            // only when no account tracks that subject: a tracked one is
            // revoked at that account's deletion, and revoking now would end
            // its live authorization.
            let subjectTracked = true;
            try {
                subjectTracked = (await deps.loadStoredTokenForSubject(subjectSha256)) !== null;
            } catch (error) {
                deps.logError(`[register-apple-token] subject lookup failed: ${describeError(error)}`);
            }
            if (!subjectTracked) await revokeUntrackedToken(refreshToken, deps);
            return { status: 403, body: { error: 'Apple credential does not belong to the authenticated account' } };
        }

        const encrypted = await deps.encryptRefreshToken(refreshToken, subjectSha256);
        const replacement: AppleTokenRow = {
            refresh_token_ciphertext: encrypted.ciphertext,
            refresh_token_iv: encrypted.iv,
            encryption_version: encrypted.encryptionVersion,
            apple_subject_sha256: subjectSha256,
            updated_at: deps.now().toISOString(),
        };

        const stored = await deps.loadStoredTokenForUser();
        if (stored) {
            if (stored.appleSubjectSha256 !== subjectSha256) {
                // That row tracks another subject's authorization, not this one.
                throw new Error('Existing Apple credential belongs to a different provider subject');
            }
            authorizationTracked = true;
            // Repeat sign-in: keep the newest token and never revoke the old
            // one (see the file header). Optimistic concurrency on updated_at
            // stops two simultaneous sign-ins overwriting each other blindly.
            if (await deps.rotateStoredToken(stored.updatedAt, replacement)) return REGISTERED;
            return settleLostRace(await deps.loadStoredTokenForUser(), subjectSha256);
        }

        if (await deps.insertStoredToken(replacement)) return REGISTERED;
        // The insert did not land. A concurrent first sign-in may have won.
        const committed = await deps.loadStoredTokenForUser();
        if (committed) return settleLostRace(committed, subjectSha256);
        throw new Error('Encrypted token persistence failed');
    } catch (error) {
        // Never include an authorization code, ID token, or refresh token in
        // logs or responses. The client signs its new local session out and
        // asks the sailor to start a fresh Apple authorization.
        deps.logError(`[register-apple-token] registration failed: ${describeError(error)}`);
        if (refreshToken && !authorizationTracked && isFirstAppleSignIn(appleIdentityLinkedAt, deps.now())) {
            // Compensate only on positive proof that no row tracks this
            // subject: an unknown state (a lookup failing) never revokes. When
            // the ID token could not be verified, the code came from the
            // caller's own Apple sign-in, so the caller's subject is checked.
            let untracked = false;
            try {
                const trackedSubject = subjectSha256 ?? await deps.sha256Hex(callerAppleSubject);
                untracked = (await deps.loadStoredTokenForSubject(trackedSubject)) === null;
            } catch {
                untracked = false;
            }
            if (untracked) await revokeUntrackedToken(refreshToken, deps);
        }
        return REGISTRATION_FAILED;
    }
}
