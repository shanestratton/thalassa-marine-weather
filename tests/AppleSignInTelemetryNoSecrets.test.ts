import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Sign in with Apple's failure reports (build 124, package AC) go to the
 * device console and, through log.error, to Sentry. None of them may carry
 * Apple's identity token, the one-time authorization code, either nonce, a
 * Supabase access or refresh token, the sailor's email, name or Apple user id.
 * The behaviour test in SocialAuthService.test.ts runs every failure with
 * sentinel values; this scan catches a new log line before it ever runs.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const SOURCES = [
    'services/auth/SocialAuthService.ts',
    'services/auth/appleCredentialState.ts',
    'services/auth/appleSignInAttempt.ts',
    'components/SignInScreen.tsx',
    'stores/authStore.ts',
];

/** Identifiers that hold, or are named for, a credential or personal datum. */
const FORBIDDEN =
    /\b(idToken|identityToken|authorizationCode|rawNonce|hashedNonce|nonce|refresh_token|refreshToken|access_token|accessToken|email|appleUserId|userId|appleResponse|givenName|familyName|session|registration|data)\b/;

/** Every `log.x(...)`, `console.x(...)` and `captureException(...)` call's argument text. */
function reportingCalls(source: string): string[] {
    const calls: string[] = [];
    const opener = /\b(?:log\.(?:debug|info|warn|error)|console\.(?:debug|info|log|warn|error)|captureException)\s*\(/g;
    for (let match = opener.exec(source); match; match = opener.exec(source)) {
        let depth = 1;
        let index = match.index + match[0].length;
        let quote: string | null = null;
        for (; index < source.length && depth > 0; index += 1) {
            const char = source[index];
            if (quote) {
                if (char === '\\') index += 1;
                else if (char === quote) quote = null;
                continue;
            }
            if (char === "'" || char === '"' || char === '`') quote = char;
            else if (char === '(') depth += 1;
            else if (char === ')') depth -= 1;
        }
        calls.push(source.slice(match.index, index));
    }
    return calls;
}

/** The code half of a call: string literals blanked, so prose like "Sign in with email" is not code. */
function codeOnly(call: string): string {
    return call.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''").replace(/`(?:\\.|[^`\\])*`/g, (template) =>
        // Keep template interpolations: they are code.
        [...template.matchAll(/\$\{([^}]*)\}/g)].map((part) => part[1]).join(' '),
    );
}

describe('Sign in with Apple telemetry carries no secrets', () => {
    it('finds the reporting calls it is meant to guard', () => {
        const social = reportingCalls(read('services/auth/SocialAuthService.ts'));
        expect(social.some((call) => call.startsWith('log.error'))).toBe(true);
        const monitor = reportingCalls(read('services/auth/appleCredentialState.ts'));
        expect(monitor.some((call) => call.startsWith('log.error'))).toBe(true);
    });

    it.each(SOURCES)('no log, console or Sentry call in %s names a token, code, nonce, email or user id', (path) => {
        const offenders = reportingCalls(read(path))
            .map((call) => ({ call, match: FORBIDDEN.exec(codeOnly(call)) }))
            .filter(({ match }) => match)
            .map(({ call, match }) => `${match![0]} in ${call.replace(/\s+/g, ' ').slice(0, 140)}`);
        expect(offenders).toEqual([]);
    });

    it('the Apple failure reports are built from fixed step, code and reason fields only', () => {
        const social = read('services/auth/SocialAuthService.ts');
        expect(social).toContain('apple_signin_failed step=${step} code=${code} reason=${reason}');
        const monitor = read('services/auth/appleCredentialState.ts');
        expect(monitor).toContain('apple_credential_revoked reason=');
        expect(monitor).not.toMatch(/apple_credential_revoked[^\n]*event\.userId/);
    });

    it('the plugin patch adds no native logging at all', () => {
        const patchPath = 'patches/@capacitor-community+apple-sign-in+7.1.0.patch';
        expect(existsSync(join(root, patchPath))).toBe(true);
        const added = read(patchPath)
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
        expect(added.filter((line) => /\b(print|NSLog|os_log|CAPLog|debugPrint|Logger)\s*[.(]/.test(line))).toEqual([]);
    });
});
