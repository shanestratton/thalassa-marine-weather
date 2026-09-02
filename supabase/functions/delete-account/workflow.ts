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

export interface AppleNotificationDeletionRequestReady {
    ok: true;
    mode: 'apple-notification';
    jti: string;
}

export interface UserDeletionRequestReady extends DeletionRequestReady {
    mode: 'user';
}

export type AccountDeletionRequestGate =
    | AppleNotificationDeletionRequestReady
    | UserDeletionRequestReady
    | DeletionRequestRejected;

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

/**
 * Accept either the public typed-confirmation flow or the narrowly-scoped
 * server-to-server Apple processor flow. The latter requires the dedicated
 * server-only processor secret and an already queued, verified Apple JTI; the
 * caller never supplies a user id.
 */
export async function requireAccountDeletionRequest(
    req: Request,
    exactConfirmation: 'DELETE',
    appleNotificationProcessorSecret: string,
): Promise<AccountDeletionRequestGate> {
    const authorization = req.headers.get('authorization');
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) {
        return { ok: false, status: 401, error: 'Authentication required' };
    }

    const body = await readJsonObject(req, 1_024);
    const appleNotificationJti = body?.appleNotificationJti;
    if (appleNotificationJti !== undefined) {
        if (req.headers.get('x-thalassa-apple-processor') !== appleNotificationProcessorSecret) {
            return { ok: false, status: 401, error: 'Processor authorization required' };
        }
        if (
            typeof appleNotificationJti !== 'string' ||
            appleNotificationJti.length < 1 ||
            appleNotificationJti.length > 512 ||
            Object.keys(body ?? {}).length !== 1
        ) {
            return { ok: false, status: 400, error: 'A verified Apple notification JTI is required' };
        }
        return { ok: true, mode: 'apple-notification', jti: appleNotificationJti };
    }

    if (body?.confirmation !== exactConfirmation) {
        return {
            ok: false,
            status: 400,
            error: `Type ${exactConfirmation} to confirm permanent account deletion`,
        };
    }
    return { ok: true, mode: 'user', authorization };
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
    serverFinalizationPending?: boolean;
}

export interface AccountDeletionInProgressResult {
    deleted: false;
    deletionInProgress: true;
    phase: 'storage_cleanup';
    processedStorageObjects: number;
}

export type AccountDeletionWorkflowResult = AccountDeletionResult | AccountDeletionInProgressResult;

export interface AccountDeletionWorkflowDependencies {
    revokeAppleCredential: () => Promise<boolean>;
    drainStorage: () => Promise<{ complete: boolean; processed: number }>;
    scrubSurvivors: () => Promise<void>;
    markAuthDeleting: () => Promise<void>;
    deleteAuthUser: () => Promise<void>;
    completeDeletion: () => Promise<void>;
}

/**
 * The sole destructive sequencing authority for account deletion.
 *
 * Auth deletion is deliberately last. A bounded Storage pass can return an
 * explicit in-progress result; every failure before auth deletion leaves the
 * durable tombstone in place for a retry. Final tombstone checkpoint failure
 * is reported separately because the auth user is already irreversibly gone.
 */
export async function runAccountDeletionWorkflow(
    dependencies: AccountDeletionWorkflowDependencies,
): Promise<AccountDeletionWorkflowResult> {
    const appleRevocationRequired = await dependencies.revokeAppleCredential();
    const storage = await dependencies.drainStorage();
    if (!storage.complete) {
        return {
            deleted: false,
            deletionInProgress: true,
            phase: 'storage_cleanup',
            processedStorageObjects: storage.processed,
        };
    }
    await dependencies.scrubSurvivors();
    await dependencies.markAuthDeleting();
    await dependencies.deleteAuthUser();

    let serverFinalizationPending = false;
    try {
        await dependencies.completeDeletion();
    } catch {
        serverFinalizationPending = true;
    }

    return {
        deleted: true,
        appleRevocationRequired,
        appleRevocation: appleRevocationRequired ? 'manual_required' : 'complete_or_not_applicable',
        ...(serverFinalizationPending ? { serverFinalizationPending: true } : {}),
    };
}
