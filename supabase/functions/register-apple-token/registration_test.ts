import {
    type AppleTokenRegistrationDependencies,
    type AppleTokenRegistrationResult,
    registerAppleRefreshToken,
    type StoredAppleToken,
} from './registration.ts';

// Fictional fixtures only: the repository is public.
const CALLER_SUBJECT = '000123.fictionalsailor0a.0042';
const OTHER_SUBJECT = '000456.fictionalskipper0b.0777';
const AUTHORIZATION_CODE = 'c.fictional-one-time-authorization-code';
const NEW_REFRESH_TOKEN = 'r.fictional-new-refresh-token';
const NOW = new Date('2026-10-08T01:00:00.000Z');
/** A first Sign in with Apple: Supabase linked the Apple identity seconds ago. */
const JUST_LINKED = '2026-10-08T00:59:40.000Z';
/** An Apple account that has been signing in for months (most have no stored token yet). */
const LONG_LINKED = '2025-11-02T09:00:00.000Z';

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

const fakeSha = (value: string): string => `sha256:${value}`;

/** Run a synchronous fake as an async dependency: a throw becomes a rejection. */
function settle<T>(run: () => T): Promise<T> {
    try {
        return Promise.resolve(run());
    } catch (error) {
        return Promise.reject(error);
    }
}

function storedFor(subject: string, updatedAt: string): StoredAppleToken {
    return { appleSubjectSha256: fakeSha(subject), updatedAt };
}

interface HarnessOptions {
    /** The user's row when the request starts. */
    stored?: StoredAppleToken | null;
    /** A concurrent sign-in commits (or a concurrent sign-out deletes) just before this request writes. */
    concurrentRow?: StoredAppleToken | null;
    /** The first-sign-in insert fails for a reason other than a conflict. */
    insertFails?: boolean;
    /** The optimistic rotation fails with a database error. */
    rotateThrows?: boolean;
    /** Every user lookup fails. */
    userLookupThrows?: boolean;
    /** Every Apple-subject lookup fails. */
    subjectLookupThrows?: boolean;
    /** The caller's Apple identity created_at; defaults to a first sign-in. */
    appleIdentityLinkedAt?: string | null;
    /** The row (if any) another account holds for the exchanged subject. */
    subjectRow?: StoredAppleToken | null;
    exchangedSubject?: string;
    exchangeThrows?: boolean;
    verifyThrows?: boolean;
    revokeThrows?: boolean;
}

interface Harness {
    deps: AppleTokenRegistrationDependencies;
    appleIdentityLinkedAt: string | null;
    revoked: string[];
    rotations: string[];
    inserts: number;
    logs: string[];
    row(): StoredAppleToken | null;
}

function harness(options: HarnessOptions = {}): Harness {
    let row: StoredAppleToken | null = options.stored ?? null;
    const revoked: string[] = [];
    const rotations: string[] = [];
    const logs: string[] = [];
    let inserts = 0;
    let concurrentApplied = false;
    const applyConcurrentWrite = () => {
        if (concurrentApplied || options.concurrentRow === undefined) return;
        concurrentApplied = true;
        row = options.concurrentRow;
    };

    const deps: AppleTokenRegistrationDependencies = {
        exchangeAuthorizationCode: (code) =>
            settle(() => {
                assertEquals(code, AUTHORIZATION_CODE);
                if (options.exchangeThrows) {
                    throw new Error('Apple authorization-code exchange failed (400:invalid_grant)');
                }
                return { refreshToken: NEW_REFRESH_TOKEN, idToken: 'fictional.id.token' };
            }),
        verifyIdTokenSubject: () =>
            settle(() => {
                if (options.verifyThrows) throw new Error('signature verification failed');
                return options.exchangedSubject ?? CALLER_SUBJECT;
            }),
        sha256Hex: (value) => Promise.resolve(fakeSha(value)),
        encryptRefreshToken: () =>
            Promise.resolve({ ciphertext: 'ciphertext-fixture', iv: 'iv-fixture', encryptionVersion: 1 }),
        loadStoredTokenForUser: () =>
            settle(() => {
                if (options.userLookupThrows) throw new Error('Existing Apple token lookup failed: database_error');
                return row;
            }),
        loadStoredTokenForSubject: (subjectSha256) =>
            settle(() => {
                if (options.subjectLookupThrows) throw new Error('Apple subject lookup failed: database_error');
                if (options.subjectRow !== undefined) return options.subjectRow;
                return row?.appleSubjectSha256 === subjectSha256 ? row : null;
            }),
        rotateStoredToken: (expectedUpdatedAt, replacement) =>
            settle(() => {
                rotations.push(expectedUpdatedAt);
                applyConcurrentWrite();
                if (options.rotateThrows) throw new Error('Apple token rotation failed: database_error');
                if (!row || row.updatedAt !== expectedUpdatedAt) return false;
                row = { appleSubjectSha256: replacement.apple_subject_sha256, updatedAt: replacement.updated_at };
                return true;
            }),
        insertStoredToken: (replacement) =>
            settle(() => {
                inserts += 1;
                applyConcurrentWrite();
                if (options.insertFails || row) return false;
                row = { appleSubjectSha256: replacement.apple_subject_sha256, updatedAt: replacement.updated_at };
                return true;
            }),
        revokeRefreshToken: (refreshToken) =>
            settle(() => {
                revoked.push(refreshToken);
                if (options.revokeThrows) throw new Error('Apple refresh-token revocation failed (503)');
            }),
        now: () => NOW,
        logError: (message) => logs.push(message),
    };

    return {
        deps,
        appleIdentityLinkedAt: options.appleIdentityLinkedAt === undefined
            ? JUST_LINKED
            : options.appleIdentityLinkedAt,
        revoked,
        rotations,
        get inserts() {
            return inserts;
        },
        logs,
        row: () => row,
    };
}

async function register(h: Harness): Promise<AppleTokenRegistrationResult> {
    return await registerAppleRefreshToken(AUTHORIZATION_CODE, CALLER_SUBJECT, h.appleIdentityLinkedAt, h.deps);
}

Deno.test('a repeat sign-in rotates the stored token and never revokes', async () => {
    const h = harness({ stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z') });

    const result = await register(h);

    assertEquals(result, { status: 200, body: { registered: true } });
    assertEquals(h.revoked, []);
    assertEquals(h.rotations, ['2026-10-07T22:00:00.000Z']);
    assertEquals(h.row(), storedFor(CALLER_SUBJECT, NOW.toISOString()));
});

Deno.test('a first sign-in inserts the token and never revokes', async () => {
    const h = harness();

    const result = await register(h);

    assertEquals(result, { status: 200, body: { registered: true } });
    assertEquals(h.revoked, []);
    assertEquals(h.inserts, 1);
    assertEquals(h.row(), storedFor(CALLER_SUBJECT, NOW.toISOString()));
});

Deno.test('the concurrency loser never revokes and succeeds when the winner holds the same Apple authorization', async () => {
    const winner = storedFor(CALLER_SUBJECT, '2026-10-08T00:59:59.900Z');
    const h = harness({ stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z'), concurrentRow: winner });

    const result = await register(h);

    assertEquals(result, { status: 200, body: { registered: true } });
    assertEquals(h.revoked, []);
    assertEquals(h.row(), winner);
});

Deno.test('the concurrency loser returns a retryable error without revoking when the winning row is gone', async () => {
    const h = harness({ stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z'), concurrentRow: null });

    const result = await register(h);

    assertEquals(result.status, 409);
    assert('retryable' in result.body && result.body.retryable === true, 'loser must be told to retry');
    assertEquals(h.revoked, []);
});

Deno.test('the concurrency loser never revokes when the winner holds a different Apple subject', async () => {
    const h = harness({
        stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z'),
        concurrentRow: storedFor(OTHER_SUBJECT, '2026-10-08T00:59:59.900Z'),
    });

    const result = await register(h);

    assertEquals(result.status, 409);
    assertEquals(h.revoked, []);
});

Deno.test('a lost first-insert race never revokes the winner authorization', async () => {
    const winner = storedFor(CALLER_SUBJECT, '2026-10-08T00:59:59.900Z');
    const h = harness({ concurrentRow: winner });

    const result = await register(h);

    assertEquals(result, { status: 200, body: { registered: true } });
    assertEquals(h.revoked, []);
    assertEquals(h.row(), winner);
});

Deno.test('compensating revocation runs only for a first Apple sign-in whose token nothing tracks', async () => {
    const h = harness({ insertFails: true });

    const result = await register(h);

    assertEquals(result.status, 502);
    assertEquals(h.revoked, [NEW_REFRESH_TOKEN]);
    assertEquals(h.row(), null);
});

Deno.test('an existing Apple account with no stored token is never revoked when registration fails', async () => {
    // Almost every Apple account predates token retention, so its first
    // registration after the fix takes the no-row path while the same Apple
    // authorization is live on the sailor's other devices. Revoking would end
    // it there too; account deletion's manual_required path already covers an
    // authorization with no stored token (TN3194).
    for (
        const options of [
            { insertFails: true },
            { verifyThrows: true },
            { insertFails: true, stored: storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z') },
        ] satisfies HarnessOptions[]
    ) {
        const h = harness({ ...options, appleIdentityLinkedAt: LONG_LINKED });
        assertEquals((await register(h)).status, 502);
        assertEquals(h.revoked, []);
    }
});

Deno.test('an unreadable or future Apple identity link time never revokes', async () => {
    for (const appleIdentityLinkedAt of [null, 'not-a-timestamp', '2026-10-08T01:30:00.000Z']) {
        const h = harness({ insertFails: true, appleIdentityLinkedAt });
        assertEquals((await register(h)).status, 502);
        assertEquals(h.revoked, []);
    }
});

Deno.test('a persistence failure never revokes while a token is stored for the user', async () => {
    const h = harness({ stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z'), rotateThrows: true });

    const result = await register(h);

    assertEquals(result.status, 502);
    assertEquals(h.revoked, []);
});

Deno.test('a stored row for a different Apple subject revokes the new token only on a first sign-in nothing tracks', async () => {
    // Revoking the stored row at deletion ends only ITS subject's
    // authorization, so the caller's new one is covered only by a row for the
    // caller's own subject.
    const untracked = harness({ stored: storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z') });
    assertEquals((await register(untracked)).status, 502);
    assertEquals(untracked.revoked, [NEW_REFRESH_TOKEN]);
    assertEquals(untracked.rotations, []);
    assertEquals(untracked.row(), storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z'));

    const trackedElsewhere = harness({
        stored: storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z'),
        subjectRow: storedFor(CALLER_SUBJECT, '2026-10-07T21:00:00.000Z'),
    });
    assertEquals((await register(trackedElsewhere)).status, 502);
    assertEquals(trackedElsewhere.revoked, []);

    const existingAccount = harness({
        stored: storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z'),
        appleIdentityLinkedAt: LONG_LINKED,
    });
    assertEquals((await register(existingAccount)).status, 502);
    assertEquals(existingAccount.revoked, []);
});

Deno.test('an unverifiable identity token revokes only on a first sign-in that nothing tracks', async () => {
    const firstSignIn = harness({ verifyThrows: true });
    assertEquals((await register(firstSignIn)).status, 502);
    assertEquals(firstSignIn.revoked, [NEW_REFRESH_TOKEN]);

    const repeatSignIn = harness({ verifyThrows: true, stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z') });
    assertEquals((await register(repeatSignIn)).status, 502);
    assertEquals(repeatSignIn.revoked, []);
});

Deno.test('an unknown stored state never revokes', async () => {
    const h = harness({ userLookupThrows: true, subjectLookupThrows: true });

    const result = await register(h);

    assertEquals(result.status, 502);
    assertEquals(h.revoked, []);

    // The compensation check itself failing is unknown too.
    const uncheckable = harness({ insertFails: true, subjectLookupThrows: true });
    assertEquals((await register(uncheckable)).status, 502);
    assertEquals(uncheckable.revoked, []);
});

Deno.test('a subject mismatch revokes only a credential that nothing else tracks', async () => {
    const untracked = harness({ exchangedSubject: OTHER_SUBJECT, subjectRow: null });
    assertEquals((await register(untracked)).status, 403);
    assertEquals(untracked.revoked, [NEW_REFRESH_TOKEN]);

    const tracked = harness({
        exchangedSubject: OTHER_SUBJECT,
        subjectRow: storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z'),
    });
    assertEquals((await register(tracked)).status, 403);
    assertEquals(tracked.revoked, []);
});

Deno.test('a failed code exchange has nothing to revoke', async () => {
    const h = harness({ exchangeThrows: true });

    const result = await register(h);

    assertEquals(result.status, 502);
    assertEquals(h.revoked, []);
});

Deno.test('a failed compensating revocation is logged and the sign-in still fails closed', async () => {
    const h = harness({ insertFails: true, revokeThrows: true });

    const result = await register(h);

    assertEquals(result.status, 502);
    assert(h.logs.some((line) => line.includes('compensating revocation failed')), 'revocation failure is logged');
});

Deno.test('logs never carry the authorization code or a refresh token', async () => {
    const scenarios: HarnessOptions[] = [
        { insertFails: true, revokeThrows: true },
        { verifyThrows: true },
        { exchangeThrows: true },
        { userLookupThrows: true },
        { stored: storedFor(OTHER_SUBJECT, '2026-10-07T22:00:00.000Z') },
        { stored: storedFor(CALLER_SUBJECT, '2026-10-07T22:00:00.000Z'), rotateThrows: true },
    ];
    for (const options of scenarios) {
        const h = harness(options);
        const result = await register(h);
        const output = JSON.stringify({ logs: h.logs, body: result.body });
        assert(h.logs.length > 0, 'every failure is logged');
        assert(!output.includes(AUTHORIZATION_CODE), 'authorization code leaked');
        assert(!output.includes(NEW_REFRESH_TOKEN), 'refresh token leaked');
    }
});
