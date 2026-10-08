import {
    appleIdentityLinkedAt,
    appleServerEventType,
    parseAppleEventsClaim,
    readAppleServerNotificationClaims,
} from './apple-auth.ts';

// Fictional fixtures only: the repository is public.
const SUBJECT = '000789.fictionalnavigator.0310';
const NOW_MS = Date.parse('2026-10-08T03:00:00.000Z');
const EVENT_SECONDS = Date.parse('2026-10-08T02:30:00.000Z') / 1000;

function assertEquals(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function assertThrows(run: () => unknown, message: string): void {
    try {
        run();
    } catch {
        return;
    }
    throw new Error(message);
}

function claims(events: unknown): Record<string, unknown> {
    return {
        iss: 'https://appleid.apple.com',
        aud: 'com.example.fictional',
        iat: EVENT_SECONDS,
        jti: 'fictional-jti-0100',
        events,
    };
}

Deno.test('Apple server event types are the four documented names', () => {
    for (const type of ['consent-revoked', 'account-deleted', 'email-enabled', 'email-disabled']) {
        assertEquals(appleServerEventType(type), type);
    }
});

Deno.test('the older account-delete spelling is the same account-deleted event', () => {
    assertEquals(appleServerEventType('account-delete'), 'account-deleted');
});

Deno.test('unknown or malformed Apple server event types are rejected', () => {
    for (const type of ['consent-revoke', 'ACCOUNT-DELETED', '', null, undefined, 7, { type: 'consent-revoked' }]) {
        assertEquals(appleServerEventType(type), null);
    }
});

Deno.test('the events claim is read when Apple sends it as a JSON-encoded string', () => {
    // What Apple's servers actually send (developer forums thread 655485):
    // `events` is a string holding JSON, with a millisecond event_time.
    const wire = claims(JSON.stringify({ type: 'consent-revoked', sub: SUBJECT, event_time: EVENT_SECONDS * 1000 }));

    const event = readAppleServerNotificationClaims(wire, NOW_MS);

    assertEquals(event.eventType, 'consent-revoked');
    assertEquals(event.subject, SUBJECT);
    assertEquals(event.jti, 'fictional-jti-0100');
    assertEquals(event.eventTime.toISOString(), '2026-10-08T02:30:00.000Z');
    assertEquals(event.issuedAt.toISOString(), '2026-10-08T02:30:00.000Z');
});

Deno.test('the events claim is read in the object form shown in Apple documentation', () => {
    const documented = claims({ type: 'account-deleted', sub: SUBJECT, event_time: EVENT_SECONDS });

    const event = readAppleServerNotificationClaims(documented, NOW_MS);

    assertEquals(event.eventType, 'account-deleted');
    assertEquals(event.subject, SUBJECT);
    assertEquals(event.eventTime.toISOString(), '2026-10-08T02:30:00.000Z');
});

Deno.test('a 13-digit millisecond event_time is the same instant as its seconds form', () => {
    const seconds = readAppleServerNotificationClaims(
        claims(JSON.stringify({ type: 'account-delete', sub: SUBJECT, event_time: EVENT_SECONDS })),
        NOW_MS,
    );
    const milliseconds = readAppleServerNotificationClaims(
        claims(JSON.stringify({ type: 'account-delete', sub: SUBJECT, event_time: String(EVENT_SECONDS * 1000) })),
        NOW_MS,
    );

    assertEquals(String(EVENT_SECONDS * 1000).length, 13);
    assertEquals(milliseconds.eventTime.getTime(), seconds.eventTime.getTime());
    assertEquals(milliseconds.eventType, 'account-deleted');
});

Deno.test('a malformed, oversized, or non-object events claim is rejected', () => {
    for (
        const events of [
            '',
            'not json',
            '{"type":"consent-revoked"',
            '["consent-revoked"]',
            'null',
            '"consent-revoked"',
            JSON.stringify({
                type: 'consent-revoked',
                sub: SUBJECT,
                event_time: EVENT_SECONDS,
                pad: 'x'.repeat(5_000),
            }),
            null,
            [],
            42,
        ]
    ) {
        assertEquals(parseAppleEventsClaim(events), null);
        assertThrows(() => readAppleServerNotificationClaims(claims(events), NOW_MS), 'malformed events accepted');
    }
});

Deno.test('a string events claim still needs a known type, a subject, and a past event time', () => {
    for (
        const events of [
            { type: 'consent-revoke', sub: SUBJECT, event_time: EVENT_SECONDS },
            { type: 'consent-revoked', event_time: EVENT_SECONDS },
            { type: 'consent-revoked', sub: SUBJECT },
            { type: 'consent-revoked', sub: SUBJECT, event_time: NOW_MS / 1000 + 3_600 },
        ]
    ) {
        assertThrows(
            () => readAppleServerNotificationClaims(claims(JSON.stringify(events)), NOW_MS),
            `accepted ${JSON.stringify(events)}`,
        );
    }
});

Deno.test('the Apple identity link time comes from the Apple identity only', () => {
    const user = {
        identities: [
            { provider: 'email', created_at: '2024-02-01T00:00:00Z' },
            { provider: 'apple', identity_id: SUBJECT, created_at: '2026-10-08T00:59:40Z' },
        ],
    };
    assertEquals(appleIdentityLinkedAt(user), '2026-10-08T00:59:40Z');
    assertEquals(appleIdentityLinkedAt({ identities: [{ provider: 'apple', identity_id: SUBJECT }] }), null);
    assertEquals(
        appleIdentityLinkedAt({ identities: [{ provider: 'email', created_at: '2024-02-01T00:00:00Z' }] }),
        null,
    );
    assertEquals(appleIdentityLinkedAt({ identities: null }), null);
});
