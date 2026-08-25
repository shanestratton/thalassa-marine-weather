import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

/**
 * Comments in these files explain at length what they deliberately do NOT do
 * ("no client secret", "not Apple's hashed nonce", "not gmail.ts's storage").
 * Asserting absence against the raw text would match that prose and pass — or
 * fail — for the wrong reason, so strip comments and assert against code.
 */
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

/**
 * Google sign-in ships behind a flag that is off until the Supabase provider
 * and the Google Cloud client exist. These are the properties that must hold
 * whichever way the flag is set — the ones a future edit could quietly break.
 */
describe('Google sign-in boundary', () => {
    const service = codeOf('services/auth/googleSignIn.ts');
    const signInUi = codeOf('components/SignInScreen.tsx');

    it('is off unless BOTH the flag and a client ID are present', () => {
        // Either alone produces a button that dies at Google, which is worse
        // than no button — the whole reason the default is off.
        expect(service).toContain("import.meta.env.VITE_GOOGLE_SIGN_IN_ENABLED === 'true'");
        expect(service).toContain("GOOGLE_OAUTH_CLIENT_ID !== ''");
        // ON since 2026-08-25 (Shane: "put it back") — flipped only after the
        // Supabase provider, Google Cloud redirect and both build
        // environments were verified configured, honouring the rule above.
        expect(JSON.parse(read('config/public-beta-features.json')).featureFlags.VITE_GOOGLE_SIGN_IN_ENABLED).toBe(
            true,
        );
        expect(signInUi).toContain('{googleEnabled && (');
    });

    it('asks for identity scopes only — never mailbox access', () => {
        // Signing in must not quietly acquire Gmail. That is a separate
        // integration with its own consent, and bundling it into a sign-in
        // would be a consent violation dressed as convenience.
        expect(service).toContain("const SCOPES = 'openid email profile'");
        expect(service).not.toMatch(/gmail\.(readonly|compose|send|modify)/);
        expect(service).not.toMatch(/drive|calendar|contacts/i);
    });

    it('uses PKCE with no client secret', () => {
        // An iOS bundle is a public client; a secret shipped in it is not a
        // secret. PKCE is the correct primitive.
        expect(service).toContain('code_challenge_method');
        expect(service).toContain('code_verifier');
        expect(service).not.toMatch(/client_secret/);
    });

    it('passes Google the RAW nonce, not Apple’s hashed one', () => {
        // Google echoes the nonce verbatim; Apple echoes its SHA-256. Hashing
        // for Google would make every token fail Supabase validation, and the
        // failure would look like a provider misconfiguration.
        expect(service).toMatch(/nonce,\s*\}\);/);
        expect(service).not.toMatch(/sha256Hex\(nonce\)|hashedNonce/);
    });

    it('binds the redirect to this flow and drops anything else', () => {
        // CSRF, plus not eating unrelated deep links.
        expect(service).toContain("params.get('state') !== expectedState");
        expect(service).toContain('!event.url?.startsWith(redirectPrefix)');
    });

    it('always tears its listeners down, including on cancel and timeout', () => {
        // A leaked appUrlOpen listener from an abandoned sign-in would hijack
        // a later, unrelated deep link.
        expect(service).toContain('urlHandle?.remove()');
        expect(service).toContain('closeHandle?.remove()');
        expect(service).toContain('clearTimeout(timer)');
        expect(service).toContain("Browser.addListener('browserFinished'");
    });

    it('keeps sign-in storage separate from the Gmail integration', () => {
        // gmail.ts is account-scoped through a userId that does not exist yet
        // at sign-in; sharing its storage would mean weakening that scoping.
        expect(service).not.toContain('Preferences');
        expect(service).not.toContain('getAuthIdentityScope');
        expect(service).not.toMatch(/from '.*integrations\/gmail'/);
    });
});
