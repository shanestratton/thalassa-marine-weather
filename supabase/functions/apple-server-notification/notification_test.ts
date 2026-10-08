import type { VerifiedAppleServerNotification } from '../_shared/apple-auth.ts';
import {
    type AppleAccountDeletionQueueRow,
    type AppleNotificationDependencies,
    type AppleTokenOwner,
    handleVerifiedAppleNotification,
} from './notification.ts';

// Fictional fixtures only: the repository is public.
const SUBJECT = '000789.fictionalnavigator.0310';
const USER_ID = '00000000-0000-4000-8000-00000000c0de';
const LATEST_SIGN_IN = '2026-10-08T01:00:00.000Z';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
    }
}

/** Run a synchronous fake as an async dependency: a throw becomes a rejection. */
function settle<T>(run: () => T): Promise<T> {
    try {
        return Promise.resolve(run());
    } catch (error) {
        return Promise.reject(error);
    }
}

function appleEvent(
    eventType: VerifiedAppleServerNotification['eventType'],
    eventTime: string,
    jti = 'fictional-jti-0001',
): VerifiedAppleServerNotification {
    return { jti, eventType, subject: SUBJECT, eventTime: new Date(eventTime), issuedAt: new Date(eventTime) };
}

interface HarnessOptions {
    owner?: AppleTokenOwner | null;
    ownerLookupThrows?: boolean;
    /** An account deletion job exists for the user. */
    deletionInProgress?: boolean;
    deletionLookupThrows?: boolean;
    signOutThrows?: boolean;
    tokenDeleteThrows?: boolean;
    queueThrows?: boolean;
    processor?: { ok: boolean; status: number; deleted: boolean } | 'throws';
}

interface Harness {
    deps: AppleNotificationDependencies;
    lookups: string[];
    deletionLookups: string[];
    signOuts: Array<{ userId: string; startedAtOrBefore: string }>;
    tokenDeletes: Array<{ userId: string; subjectSha256: string; expectedUpdatedAt: string }>;
    queued: AppleAccountDeletionQueueRow[];
    processorCalls: string[];
    failedJtis: Array<{ jti: string; code: string }>;
    logs: string[];
}

function harness(options: HarnessOptions = {}): Harness {
    const h: Omit<Harness, 'deps'> = {
        lookups: [],
        deletionLookups: [],
        signOuts: [],
        tokenDeletes: [],
        queued: [],
        processorCalls: [],
        failedJtis: [],
        logs: [],
    };
    const owner = options.owner === undefined ? { userId: USER_ID, updatedAt: LATEST_SIGN_IN } : options.owner;
    const deps: AppleNotificationDependencies = {
        sha256Hex: (value) => Promise.resolve(`sha256:${value}`),
        loadTokenOwner: (subjectSha256) =>
            settle(() => {
                h.lookups.push(subjectSha256);
                if (options.ownerLookupThrows) throw new Error('subject resolution failed: database_error');
                return owner;
            }),
        accountDeletionInProgress: (userId) =>
            settle(() => {
                h.deletionLookups.push(userId);
                if (options.deletionLookupThrows) throw new Error('deletion job lookup failed: database_error');
                return options.deletionInProgress === true;
            }),
        signOutUserSessions: (userId, startedAtOrBefore) =>
            settle(() => {
                h.signOuts.push({ userId, startedAtOrBefore: startedAtOrBefore.toISOString() });
                if (options.signOutThrows) throw new Error('session_sign_out_failed');
            }),
        deleteStoredAppleToken: (userId, subjectSha256, expectedUpdatedAt) =>
            settle(() => {
                h.tokenDeletes.push({ userId, subjectSha256, expectedUpdatedAt });
                if (options.tokenDeleteThrows) throw new Error('apple_token_delete_failed');
            }),
        queueAccountDeletion: (row) =>
            settle(() => {
                if (options.queueThrows) throw new Error('durable queue write failed');
                h.queued.push(row);
            }),
        runAccountDeletion: (jti) =>
            settle(() => {
                h.processorCalls.push(jti);
                if (options.processor === 'throws') throw new Error('processor request failed');
                return options.processor ?? { ok: true, status: 200, deleted: true };
            }),
        markQueueFailed: (jti, code) =>
            settle(() => {
                h.failedJtis.push({ jti, code });
            }),
        logError: (message) => h.logs.push(message),
    };
    return { ...h, deps };
}

Deno.test('consent-revoked signs the user out and drops the stored Apple token without deleting the account', async () => {
    const h = harness();
    const event = appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z');

    const result = await handleVerifiedAppleNotification(event, h.deps);

    assertEquals(result, { status: 200, body: { accepted: true, action: 'signed_out' } });
    assertEquals(h.deletionLookups, [USER_ID]);
    assertEquals(h.signOuts, [{ userId: USER_ID, startedAtOrBefore: '2026-10-08T02:30:00.000Z' }]);
    assertEquals(h.tokenDeletes, [{
        userId: USER_ID,
        subjectSha256: `sha256:${SUBJECT}`,
        expectedUpdatedAt: LATEST_SIGN_IN,
    }]);
    assertEquals(h.queued, []);
    assertEquals(h.processorCalls, []);
});

Deno.test('consent-revoked during an account deletion leaves the token row and sessions to the deletion', async () => {
    // TN3194: Apple broadcasts consent-revoked after the app's own /auth/revoke,
    // and in-app deletion revokes first, so this event normally lands while the
    // deletion is still running. A resumed deletion in apple_revocation_state
    // 'revoking' needs that token row, and the app needs its session to retry.
    const h = harness({ deletionInProgress: true });
    const event = appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z');

    const result = await handleVerifiedAppleNotification(event, h.deps);

    assertEquals(result, { status: 200, body: { accepted: true, action: 'deletion_in_progress' } });
    assertEquals(h.deletionLookups, [USER_ID]);
    assertEquals(h.signOuts, []);
    assertEquals(h.tokenDeletes, []);
    assertEquals(h.queued, []);
    assertEquals(h.processorCalls, []);
});

Deno.test('an unknown deletion state asks Apple to retry without signing out or dropping the token', async () => {
    const h = harness({ deletionLookupThrows: true });

    const result = await handleVerifiedAppleNotification(
        appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.signOuts, []);
    assertEquals(h.tokenDeletes, []);
    assert(h.logs.some((line) => line.includes('deletion state lookup failed')), 'lookup failure is logged');
});

Deno.test('account-deleted is queued and processed through account deletion as before', async () => {
    const h = harness();
    const event = appleEvent('account-deleted', '2026-10-08T02:30:00.000Z', 'fictional-jti-0002');

    const result = await handleVerifiedAppleNotification(event, h.deps);

    assertEquals(result, { status: 200, body: { accepted: true, action: 'account_deleted' } });
    assertEquals(h.queued, [
        {
            jti: 'fictional-jti-0002',
            event_type: 'account-deleted',
            apple_subject_sha256: `sha256:${SUBJECT}`,
            user_id: USER_ID,
            event_time: '2026-10-08T02:30:00.000Z',
            issued_at: '2026-10-08T02:30:00.000Z',
        },
    ]);
    assertEquals(h.processorCalls, ['fictional-jti-0002']);
    assertEquals(h.signOuts, []);
    assertEquals(h.tokenDeletes, []);
});

Deno.test('an event older than the latest sign-in is acknowledged and ignored', async () => {
    for (const eventType of ['consent-revoked', 'account-deleted'] as const) {
        const h = harness();
        const event = appleEvent(eventType, '2026-10-08T00:59:59.000Z');

        const result = await handleVerifiedAppleNotification(event, h.deps);

        assertEquals(result, { status: 200, body: { accepted: true, action: 'stale_event_ignored' } });
        assertEquals(h.signOuts, []);
        assertEquals(h.tokenDeletes, []);
        assertEquals(h.queued, []);
        assertEquals(h.processorCalls, []);
    }
});

Deno.test('email forwarding events need no account action', async () => {
    for (const eventType of ['email-enabled', 'email-disabled'] as const) {
        const h = harness();
        const result = await handleVerifiedAppleNotification(appleEvent(eventType, '2026-10-08T02:30:00.000Z'), h.deps);
        assertEquals(result, { status: 200, body: { accepted: true, action: 'not_required' } });
        assertEquals(h.lookups, []);
    }
});

Deno.test('a subject with no retained token is acknowledged as already unlinked', async () => {
    const h = harness({ owner: null });

    const result = await handleVerifiedAppleNotification(
        appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result, { status: 200, body: { accepted: true, action: 'already_unlinked' } });
    assertEquals(h.signOuts, []);
    assertEquals(h.queued, []);
});

Deno.test('a failed owner lookup asks Apple to retry without acting', async () => {
    const h = harness({ ownerLookupThrows: true });

    const result = await handleVerifiedAppleNotification(
        appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.signOuts, []);
    assertEquals(h.tokenDeletes, []);
});

Deno.test('a failed sign-out keeps the stored token so Apple can retry', async () => {
    const h = harness({ signOutThrows: true });

    const result = await handleVerifiedAppleNotification(
        appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.tokenDeletes, []);
    assertEquals(h.processorCalls, []);
    assert(h.logs.some((line) => line.includes('sign-out failed')), 'sign-out failure is logged');
});

Deno.test('a failed token delete after sign-out asks Apple to retry', async () => {
    const h = harness({ tokenDeleteThrows: true });

    const result = await handleVerifiedAppleNotification(
        appleEvent('consent-revoked', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.processorCalls, []);
});

Deno.test('an unreadable sign-in time is not treated as fresh', async () => {
    const h = harness({ owner: { userId: USER_ID, updatedAt: 'not-a-timestamp' } });

    const result = await handleVerifiedAppleNotification(
        appleEvent('account-deleted', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.queued, []);
    assertEquals(h.processorCalls, []);
});

Deno.test('an account-deletion processor failure stays queued for retry', async () => {
    const h = harness({ processor: { ok: false, status: 500, deleted: false } });

    const result = await handleVerifiedAppleNotification(
        appleEvent('account-deleted', '2026-10-08T02:30:00.000Z', 'fictional-jti-0003'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.failedJtis, [{ jti: 'fictional-jti-0003', code: 'processor_http_500' }]);

    const unreachable = harness({ processor: 'throws' });
    const retry = await handleVerifiedAppleNotification(
        appleEvent('account-deleted', '2026-10-08T02:30:00.000Z', 'fictional-jti-0004'),
        unreachable.deps,
    );
    assertEquals(retry.status, 503);
    assertEquals(unreachable.failedJtis, [{ jti: 'fictional-jti-0004', code: 'processor_request_failed' }]);
});

Deno.test('a queue write failure never reaches the account-deletion processor', async () => {
    const h = harness({ queueThrows: true });

    const result = await handleVerifiedAppleNotification(
        appleEvent('account-deleted', '2026-10-08T02:30:00.000Z'),
        h.deps,
    );

    assertEquals(result.status, 503);
    assertEquals(h.processorCalls, []);
});
