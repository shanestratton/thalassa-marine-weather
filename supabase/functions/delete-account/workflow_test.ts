import {
    type AccountDeletionWorkflowDependencies,
    authenticateDeletionCaller,
    requireAccountDeletionRequest,
    requireDeletionMutation,
    requireExactDeletionRequest,
    runAccountDeletionWorkflow,
} from './workflow.ts';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function appleNotificationRequest(
    authorization: string,
    appleNotificationJti: unknown,
    extra: Record<string, unknown> = {},
): Request {
    return new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: {
            authorization,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ appleNotificationJti, ...extra }),
    });
}

function assertEquals(actual: unknown, expected: unknown): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
    }
}

async function assertRejects(operation: () => Promise<unknown>, expectedMessage: string): Promise<void> {
    try {
        await operation();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert(
            message.includes(expectedMessage),
            `Expected rejection containing "${expectedMessage}", received "${message}"`,
        );
        return;
    }
    throw new Error(`Expected rejection containing "${expectedMessage}"`);
}

function deletionRequest(authorization: string | null, confirmation: unknown = 'DELETE'): Request {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (authorization !== null) headers.set('authorization', authorization);
    return new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers,
        body: JSON.stringify({ confirmation }),
    });
}

Deno.test('delete-account request gate requires an exact bearer header and exact DELETE confirmation', async () => {
    const ready = await requireExactDeletionRequest(deletionRequest('Bearer real-access-token'), 'DELETE');
    assertEquals(ready, { ok: true, authorization: 'Bearer real-access-token' });

    for (
        const authorization of [
            null,
            '',
            'bearer real-access-token',
            'Bearer',
            'Bearer ',
            'Bearer real access token',
            'Basic real-access-token',
        ]
    ) {
        const rejected = await requireExactDeletionRequest(deletionRequest(authorization), 'DELETE');
        assertEquals(rejected, { ok: false, status: 401, error: 'Authentication required' });
    }

    for (const confirmation of ['delete', ' DELETE', 'DELETE ', '', null, true, 1, ['DELETE']]) {
        const rejected = await requireExactDeletionRequest(
            deletionRequest('Bearer real-access-token', confirmation),
            'DELETE',
        );
        assertEquals(rejected, {
            ok: false,
            status: 400,
            error: 'Type DELETE to confirm permanent account deletion',
        });
    }
});

Deno.test('delete-account request gate rejects malformed and oversized JSON', async () => {
    const malformed = new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: { authorization: 'Bearer real-access-token' },
        body: '{"confirmation":',
    });
    const oversized = new Request('https://example.test/functions/v1/delete-account', {
        method: 'POST',
        headers: {
            authorization: 'Bearer real-access-token',
            'content-length': '2048',
        },
        body: JSON.stringify({ confirmation: 'DELETE' }),
    });

    for (const request of [malformed, oversized]) {
        const rejected = await requireExactDeletionRequest(request, 'DELETE');
        assertEquals(rejected, {
            ok: false,
            status: 400,
            error: 'Type DELETE to confirm permanent account deletion',
        });
    }
});

Deno.test('delete-account accepts only an exact processor-authorized Apple notification JTI', async () => {
    const processorSecret = 'processor-secret';
    const ready = await requireAccountDeletionRequest(
        new Request(appleNotificationRequest('Bearer service-role-jwt', 'verified-jti'), {
            headers: {
                authorization: 'Bearer service-role-jwt',
                'content-type': 'application/json',
                'x-thalassa-apple-processor': processorSecret,
            },
        }),
        'DELETE',
        processorSecret,
    );
    assertEquals(ready, { ok: true, mode: 'apple-notification', jti: 'verified-jti' });

    const wrongRole = await requireAccountDeletionRequest(
        appleNotificationRequest('Bearer user-access-token', 'verified-jti'),
        'DELETE',
        processorSecret,
    );
    assertEquals(wrongRole, { ok: false, status: 401, error: 'Processor authorization required' });

    for (const jti of ['', 'x'.repeat(513), null, true, ['verified-jti']]) {
        const rejected = await requireAccountDeletionRequest(
            new Request(appleNotificationRequest('Bearer service-role-jwt', jti), {
                headers: {
                    authorization: 'Bearer service-role-jwt',
                    'content-type': 'application/json',
                    'x-thalassa-apple-processor': processorSecret,
                },
            }),
            'DELETE',
            processorSecret,
        );
        assertEquals(rejected, {
            ok: false,
            status: 400,
            error: 'A verified Apple notification JTI is required',
        });
    }

    const mixedRequest = await requireAccountDeletionRequest(
        new Request(
            appleNotificationRequest('Bearer service-role-jwt', 'verified-jti', { confirmation: 'DELETE' }),
            {
                headers: {
                    authorization: 'Bearer service-role-jwt',
                    'content-type': 'application/json',
                    'x-thalassa-apple-processor': processorSecret,
                },
            },
        ),
        'DELETE',
        processorSecret,
    );
    assertEquals(mixedRequest, {
        ok: false,
        status: 400,
        error: 'A verified Apple notification JTI is required',
    });
});

Deno.test('delete-account keeps the user confirmation path separate from Apple processing', async () => {
    const ready = await requireAccountDeletionRequest(
        deletionRequest('Bearer real-access-token'),
        'DELETE',
        'server-secret',
    );
    assertEquals(ready, { ok: true, mode: 'user', authorization: 'Bearer real-access-token' });
});

Deno.test('delete-account caller authentication requires a real user and no auth error', async () => {
    const user = { id: 'user-123' };
    assertEquals(
        await authenticateDeletionCaller(() => Promise.resolve({ data: { user }, error: null })),
        user,
    );
    assertEquals(
        await authenticateDeletionCaller(() => Promise.resolve({ data: { user: null }, error: null })),
        null,
    );
    assertEquals(
        await authenticateDeletionCaller(() => Promise.resolve({ data: { user }, error: new Error('invalid token') })),
        null,
    );
});

Deno.test('required cleanup mutations fail closed on missing-table and schema-cache errors', async () => {
    for (
        const message of [
            "Could not find the table 'manifest_invites' in the schema cache",
            'PGRST205: relation public.chat_channels was not found in the schema cache',
            '42P01: relation "public.admin_audit_log" does not exist',
        ]
    ) {
        let authDeletionRan = false;
        await assertRejects(
            () =>
                runAccountDeletionWorkflow({
                    revokeAppleCredential: () => Promise.resolve(false),
                    drainStorage: () => Promise.resolve({ complete: true, processed: 0 }),
                    scrubSurvivors: () =>
                        requireDeletionMutation(
                            Promise.resolve({ error: { message } }),
                            'Required survivor cleanup failed',
                        ),
                    markAuthDeleting: () => Promise.resolve(),
                    deleteAuthUser: () => {
                        authDeletionRan = true;
                        return Promise.resolve();
                    },
                    completeDeletion: () => Promise.resolve(),
                }),
            'Required survivor cleanup failed',
        );
        assert(!authDeletionRan, `Auth deletion ran after required cleanup error: ${message}`);
    }
});

Deno.test('only an explicitly retired optional resource may tolerate missing-resource wording', async () => {
    await requireDeletionMutation(
        Promise.resolve({ error: { message: "Could not find the table 'enc_cell_submissions'" } }),
        'Optional retired cleanup failed',
        { allowMissingRetiredResource: true },
    );
    await assertRejects(
        () =>
            requireDeletionMutation(
                Promise.resolve({ error: { message: 'backend timeout' } }),
                'Optional retired cleanup failed',
                { allowMissingRetiredResource: true },
            ),
        'backend timeout',
    );
});

function workflowHarness(failAt: string | null = null): {
    events: string[];
    dependencies: AccountDeletionWorkflowDependencies;
} {
    const events: string[] = [];
    const record = (name: string): void => {
        events.push(name);
        if (failAt === name) throw new Error(`${name} failed`);
    };
    const operation = (name: string) => (): Promise<void> => {
        record(name);
        return Promise.resolve();
    };

    return {
        events,
        dependencies: {
            revokeAppleCredential: () => {
                record('apple-revocation');
                return Promise.resolve(false);
            },
            drainStorage: () => {
                record('storage-cleanup');
                return Promise.resolve({ complete: true, processed: 3 });
            },
            scrubSurvivors: operation('survivor-scrub'),
            markAuthDeleting: operation('auth-deleting-checkpoint'),
            deleteAuthUser: operation('auth-deletion'),
            completeDeletion: operation('tombstone-complete'),
        },
    };
}

Deno.test('delete-account runs Apple revocation and every cleanup before deleting auth', async () => {
    const { events, dependencies } = workflowHarness();
    const result = await runAccountDeletionWorkflow(dependencies);

    assertEquals(events, [
        'apple-revocation',
        'storage-cleanup',
        'survivor-scrub',
        'auth-deleting-checkpoint',
        'auth-deletion',
        'tombstone-complete',
    ]);
    assertEquals(result, {
        deleted: true,
        appleRevocationRequired: false,
        appleRevocation: 'complete_or_not_applicable',
    });
});

for (
    const failingOperation of [
        'apple-revocation',
        'storage-cleanup',
        'survivor-scrub',
        'auth-deleting-checkpoint',
    ]
) {
    Deno.test(`delete-account ${failingOperation} failure prevents auth deletion`, async () => {
        const { events, dependencies } = workflowHarness(failingOperation);
        await assertRejects(() => runAccountDeletionWorkflow(dependencies), `${failingOperation} failed`);
        assert(!events.includes('auth-deletion'), `Auth deletion ran after ${failingOperation} failed`);
    });
}

Deno.test('delete-account does not report success until auth deletion succeeds', async () => {
    const { events, dependencies } = workflowHarness('auth-deletion');
    await assertRejects(() => runAccountDeletionWorkflow(dependencies), 'auth-deletion failed');
    assertEquals(events.at(-1), 'auth-deletion');
});

Deno.test('delete-account returns explicit progress without scrubbing or deleting auth at a Storage budget', async () => {
    const { events, dependencies } = workflowHarness();
    dependencies.drainStorage = () => {
        events.push('storage-cleanup');
        return Promise.resolve({ complete: false, processed: 3200 });
    };

    assertEquals(await runAccountDeletionWorkflow(dependencies), {
        deleted: false,
        deletionInProgress: true,
        phase: 'storage_cleanup',
        processedStorageObjects: 3200,
    });
    assertEquals(events, ['apple-revocation', 'storage-cleanup']);
});

Deno.test('delete-account reports a finalization checkpoint failure only after auth is gone', async () => {
    const { events, dependencies } = workflowHarness('tombstone-complete');

    assertEquals(await runAccountDeletionWorkflow(dependencies), {
        deleted: true,
        appleRevocationRequired: false,
        appleRevocation: 'complete_or_not_applicable',
        serverFinalizationPending: true,
    });
    assertEquals(events.at(-2), 'auth-deletion');
    assertEquals(events.at(-1), 'tombstone-complete');
});

Deno.test('delete-account reports manual Apple revocation only after a successful deletion', async () => {
    const { events, dependencies } = workflowHarness();
    dependencies.revokeAppleCredential = () => {
        events.push('apple-revocation');
        return Promise.resolve(true);
    };

    assertEquals(await runAccountDeletionWorkflow(dependencies), {
        deleted: true,
        appleRevocationRequired: true,
        appleRevocation: 'manual_required',
    });
    assertEquals(events.at(-2), 'auth-deletion');
    assertEquals(events.at(-1), 'tombstone-complete');
});
