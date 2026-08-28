import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { FEEDBACK_CONSENT_VERSION, validateProductFeedback } from './validation.ts';

function validBug(): Record<string, unknown> {
    return {
        clientSubmissionId: '0f28c24f-7e79-4ce3-a943-e1b77f4cf321',
        kind: 'bug',
        name: 'Shane Skipper',
        email: 'shane@example.com',
        area: 'weather',
        title: 'Wind card does not update',
        details: 'The wind card keeps showing the earlier observation after a refresh.',
        impact: 'annoying',
        stepsToReproduce: 'Open the Glass, wait for the next observation, then pull to refresh.',
        expectedResult: 'The observation time and wind value update together.',
        actualResult: 'The time updates but the wind value does not.',
        problemToSolve: null,
        idealOutcome: null,
        device: 'iPhone 17 Pro',
        appVersion: '1.2.0',
        appBuild: '42',
        appPlatform: 'iOS',
        diagnostics: {
            platform: 'iPhone',
            userAgent: 'Mozilla/5.0',
            screen: '402x874',
            viewport: '402x750',
            language: 'en-AU',
            online: true,
            currentPath: '/feedback',
        },
        source: 'direct',
        consent: true,
        consentVersion: FEEDBACK_CONSENT_VERSION,
        website: '',
    };
}

Deno.test('validates and normalizes a bug report', () => {
    const input = validBug();
    input.name = '  Shane   Skipper  ';
    input.email = 'SHANE@EXAMPLE.COM';
    input.details = 'The wind card keeps showing the earlier observation.\r\nIt remains stale after a refresh.';

    const result = validateProductFeedback(input);
    assertExists(result.value);
    assertEquals(result.fields, []);
    assertEquals(result.value.name, 'Shane Skipper');
    assertEquals(result.value.email, 'shane@example.com');
    assertEquals(result.value.details.includes('\r'), false);
    assertEquals(result.value.diagnostics?.currentPath, '/feedback');
});

Deno.test('validates a feature request without bug-only fields', () => {
    const input = validBug();
    Object.assign(input, {
        kind: 'feature',
        area: 'passage_planning',
        title: 'Let me compare two departure windows',
        details: 'I want to compare the weather and tide trade-offs for two possible departure times.',
        impact: 'important',
        stepsToReproduce: null,
        expectedResult: null,
        actualResult: null,
        problemToSolve: 'Choosing between an early tide and a better wind window currently takes several screens.',
        idealOutcome: 'Show two saved departure windows side by side.',
        diagnostics: null,
    });

    const result = validateProductFeedback(input);
    assertExists(result.value);
    assertEquals(result.value.kind, 'feature');
    assertEquals(result.value.problemToSolve?.startsWith('Choosing'), true);
    assertEquals(result.value.appVersion, '1.2.0');
    assertEquals(result.value.appBuild, '42');
    assertEquals(result.value.appPlatform, 'iOS');
});

Deno.test('enforces impact and detail pairing by feedback kind', () => {
    const badImpact = validBug();
    badImpact.impact = 'game_changer';
    assertEquals(validateProductFeedback(badImpact).fields.includes('impact'), true);

    const crossKind = validBug();
    crossKind.problemToSolve = 'A feature field on a bug';
    assertEquals(validateProductFeedback(crossKind).fields.includes('form'), true);

    const featureDiagnostics = validBug();
    Object.assign(featureDiagnostics, {
        kind: 'feature',
        impact: 'nice_to_have',
        stepsToReproduce: null,
        expectedResult: null,
        actualResult: null,
        problemToSolve: 'I want a simpler workflow.',
        idealOutcome: null,
    });
    assertEquals(validateProductFeedback(featureDiagnostics).fields.includes('diagnostics'), true);
});

Deno.test('rejects unknown fields and malformed identifiers or consent', () => {
    const input = validBug();
    input.admin = true;
    input.clientSubmissionId = 'not-a-uuid';
    input.consentVersion = 'future-contract';

    const result = validateProductFeedback(input);
    assertEquals(result.value, null);
    assertEquals(result.fields.includes('form'), true);
    assertEquals(result.fields.includes('consent'), true);
});

Deno.test('diagnostics are strict, bounded, and never accept a query or hash', () => {
    for (
        const badDiagnostics of [
            { ...(validBug().diagnostics as object), currentPath: '/plan?secret=value' },
            { ...(validBug().diagnostics as object), currentPath: '/plan#private' },
            { ...(validBug().diagnostics as object), accountId: 'private-account' },
            { ...(validBug().diagnostics as object), online: 'yes' },
            { ...(validBug().diagnostics as object), userAgent: 'x'.repeat(513) },
        ]
    ) {
        const input = validBug();
        input.diagnostics = badDiagnostics;
        assertEquals(validateProductFeedback(input).fields.includes('diagnostics'), true);
    }
});

Deno.test('rejects oversized content and control characters', () => {
    const input = validBug();
    input.details = 'x'.repeat(4_001);
    input.title = 'Unsafe\u0000title';
    input.device = 'Unsafe\nheader';
    input.appBuild = 'Unsafe\nheader';
    input.appPlatform = 'x'.repeat(41);

    const result = validateProductFeedback(input);
    assertEquals(result.fields.includes('details'), true);
    assertEquals(result.fields.includes('title'), true);
    assertEquals(result.fields.includes('device'), true);
    assertEquals(result.fields.includes('appBuild'), true);
    assertEquals(result.fields.includes('appPlatform'), true);
});

Deno.test('accepts the honeypot but marks it for a silent discard', () => {
    const input = validBug();
    input.website = 'https://spam.invalid';

    const result = validateProductFeedback(input);
    assertExists(result.value);
    assertEquals(result.value.honeypotTriggered, true);
});
