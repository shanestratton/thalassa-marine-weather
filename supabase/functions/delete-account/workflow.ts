import { readJsonObject } from '../_shared/http-security.ts';
import { isMissingResource } from './storage-cleanup.ts';

export interface DeletionRequestReady {
    ok: true;
    authorization: string;
}

export interface DeletionRequestRejected {
    ok: false;
    status: 400 | 401;
    error: string;
}

export type DeletionRequestGate = DeletionRequestReady | DeletionRequestRejected;

/**
 * Validate the destructive request before constructing a service-role client.
 * The confirmation comparison is intentionally exact and the bearer syntax
 * rejects leading, trailing, or embedded whitespace.
 */
export async function requireExactDeletionRequest(
    req: Request,
    exactConfirmation: 'DELETE',
): Promise<DeletionRequestGate> {
    const authorization = req.headers.get('authorization');
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) {
        return { ok: false, status: 401, error: 'Authentication required' };
    }

    const body = await readJsonObject(req, 1_024);
    if (body?.confirmation !== exactConfirmation) {
        return {
            ok: false,
            status: 400,
            error: `Type ${exactConfirmation} to confirm permanent account deletion`,
        };
    }

    return { ok: true, authorization };
}

export interface AuthenticatedUserResult<User> {
    data: { user: User | null };
    error: unknown | null;
}

/** Return a caller only when the access token resolves without an auth error. */
export async function authenticateDeletionCaller<User>(
    getUser: () => Promise<AuthenticatedUserResult<User>>,
): Promise<User | null> {
    const { data, error } = await getUser();
    return error || !data.user ? null : data.user;
}

export async function requireDeletionMutation(
    operation: PromiseLike<{ error: { message: string } | null }>,
    label: string,
    options: { allowMissingRetiredResource?: boolean } = {},
): Promise<void> {
    const { error } = await operation;
    if (!error) return;
    if (options.allowMissingRetiredResource && isMissingResource(error.message)) return;
    throw new Error(`${label}: ${error.message}`);
}

export interface AccountDeletionResult {
    deleted: true;
    appleRevocationRequired: boolean;
    appleRevocation: 'manual_required' | 'complete_or_not_applicable';
}

export interface AccountDeletionWorkflowDependencies {
    revokeAppleCredential: () => Promise<boolean>;
    cleanupOperations: readonly (() => Promise<void>)[];
    deleteAuthUser: () => Promise<void>;
}

/**
 * The sole destructive sequencing authority for account deletion.
 *
 * Auth deletion is deliberately last. Promise rejection from Apple
 * revocation or any cleanup operation exits the workflow before it can run.
 * A success result is created only after auth deletion resolves.
 */
export async function runAccountDeletionWorkflow(
    dependencies: AccountDeletionWorkflowDependencies,
): Promise<AccountDeletionResult> {
    const appleRevocationRequired = await dependencies.revokeAppleCredential();
    for (const cleanup of dependencies.cleanupOperations) await cleanup();
    await dependencies.deleteAuthUser();

    return {
        deleted: true,
        appleRevocationRequired,
        appleRevocation: appleRevocationRequired ? 'manual_required' : 'complete_or_not_applicable',
    };
}
