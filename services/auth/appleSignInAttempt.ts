/**
 * The one Sign in with Apple attempt in flight, app-wide (build 124).
 *
 * Supabase reports SIGNED_IN before Apple Sign-In's last two steps (the
 * device's credential binding and register-apple-token) have run. Several
 * callers render the sign-in sheet only while signed out, so SIGNED_IN
 * unmounts their sheet mid-attempt, and a failure in those steps (after which
 * the session is discarded and the caller shows the sheet again) used to land
 * on no screen at all. Holding the attempt here, outside any one sheet, lets
 * whichever sheet is showing stay busy until the chain settles and then show
 * its failure. It also keeps a second sheet from starting a second attempt:
 * the native plugin holds one pending call.
 *
 * Only the user-facing message is kept. It never contains a token, code,
 * nonce, email or Apple user id (SocialAuthService builds it from fixed text).
 */

export interface AppleSignInAttempt {
    running: boolean;
    /** The failed attempt's message for the sheet, or null. */
    failure: string | null;
    /** When the failure landed (ms since epoch), 0 when there is none. */
    failedAt: number;
}

const IDLE: AppleSignInAttempt = { running: false, failure: null, failedAt: 0 };
let attempt: AppleSignInAttempt = IDLE;
/** The sailor closed the sheet (its close button or Escape) while this attempt ran. */
let leftBySailor = false;
const listeners = new Set<() => void>();

function publish(next: AppleSignInAttempt): void {
    attempt = next;
    for (const listener of listeners) listener();
}

export function getAppleSignInAttempt(): AppleSignInAttempt {
    return attempt;
}

export function subscribeAppleSignInAttempt(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Starts an attempt, clearing any earlier failure. */
export function beginAppleSignInAttempt(): void {
    leftBySailor = false;
    publish({ running: true, failure: null, failedAt: 0 });
}

/**
 * Ends the attempt: null on success. A failure is kept for the sheet unless
 * the sailor closed the sheet while the attempt ran: they walked away from it.
 * A sheet a caller closed or unmounted (not the sailor) still gets it.
 */
export function endAppleSignInAttempt(failure: string | null): void {
    const keep = failure !== null && !leftBySailor;
    leftBySailor = false;
    publish(keep ? { running: false, failure, failedAt: Date.now() } : IDLE);
}

/** Forgets a failure the sailor has seen or moved past; a running attempt is untouched. */
export function clearAppleSignInFailure(): void {
    if (attempt.failure !== null) publish({ ...attempt, failure: null, failedAt: 0 });
}

/**
 * The sailor closed the sign-in sheet themselves (its close button or
 * Escape). A failure they were shown is done with, and one still to come from
 * a running attempt is dropped. Only the sheet's own close calls this: a
 * caller closing or unmounting the sheet is not the sailor walking away.
 */
export function leaveAppleSignIn(): void {
    if (attempt.running) leftBySailor = true;
    clearAppleSignInFailure();
}

/**
 * True while an Apple attempt is running or its failure is waiting to be
 * read. A caller that closes its sign-in sheet when the signed-in account
 * changes skips that close then: Supabase reports SIGNED_IN (and SIGNED_OUT,
 * if a later step fails and the session is discarded) mid-attempt, and the
 * sheet closes itself once every step has finished, or shows the failed step.
 */
export function appleSignInHoldsSheet(): boolean {
    return attempt.running || attempt.failure !== null;
}
