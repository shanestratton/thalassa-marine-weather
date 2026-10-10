/**
 * The iPhone build on a GitHub-hosted Mac (.github/workflows/ios-testflight.yml).
 *
 * It holds Apple signing material, so its safety rules are pinned here, not
 * left to review: Apple secrets reach only the signing steps of an owner-run
 * build, never a pull request and never a VITE_* name (every VITE_* value is
 * inlined into the app bundle); an uploaded build number is never reused; no
 * app, archive or key is kept as an artifact; the keychain and key are removed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('.github/workflows/ios-testflight.yml', 'utf8');
const code = source.replace(/^\s*#.*$/gm, '');

/** The job's steps, split at the step list's own indentation. */
const steps = code
    .slice(code.indexOf('        steps:'))
    .split(/\n {12}- /)
    .slice(1)
    .map((text) => ({ text, name: /(?:^|\n)\s*name:\s*(.+)/.exec(text)?.[1]?.trim() ?? text.split('\n')[0].trim() }));
const step = (name: string) => {
    const found = steps.find((s) => s.name === name);
    if (!found) throw new Error(`no step "${name}"`);
    return found.text;
};
const APPLE_SECRETS = ['IOS_DEV_CERT_P12_BASE64', 'IOS_DEV_CERT_PASSWORD', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8'];

describe('the iOS TestFlight workflow', () => {
    it('runs on the one reviewed macOS image with the Xcode the uploads were made with', () => {
        expect(code).toMatch(/^\s*runs-on: macos-26\s*$/m);
        expect(code).toContain('DEVELOPER_DIR: /Applications/Xcode_26.6.app/Contents/Developer');
        expect(step('Toolchain')).toContain("'Xcode 26.6'*");
    });

    it('signs only for an owner-run build, never for a pull request', () => {
        expect(code).toContain("if: github.event_name == 'pull_request' || github.actor == 'shanestratton'");
        expect(code).toContain("SIGN: ${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}");
        expect(code).not.toMatch(/pull_request_target|workflow_run/);
    });

    it('reads Apple secrets only in the signing steps, and never under a VITE_ name', () => {
        const withSecrets = steps.filter((s) => /secrets\./.test(s.text));
        expect(withSecrets.map((s) => s.name)).toEqual([
            'Signing keychain and App Store Connect key',
            'Archive (Apple Development, automatic signing)',
            'Export (cloud-managed Apple Distribution)',
            'Upload to TestFlight (once)',
        ]);
        for (const s of withSecrets) expect(s.text, s.name).toContain("if: env.SIGN == 'true'");
        // Nothing secret at job level, where every step (npm scripts included) would see it.
        const jobEnv = code.slice(code.indexOf('        env:'), code.indexOf('        steps:'));
        expect(jobEnv).not.toContain('secrets.');
        expect(code).not.toMatch(/VITE_[A-Z0-9_]*:\s*\$\{\{\s*secrets\./);
        for (const name of APPLE_SECRETS) expect(name.startsWith('VITE_')).toBe(false);
        // The npm build runs before any secret is written to the runner.
        const order = steps.map((s) => s.name);
        expect(order.indexOf('npm run ship:beta')).toBeLessThan(
            order.indexOf('Signing keychain and App Store Connect key'),
        );
    });

    it('builds only the committed build number, and uploads once only when asked', () => {
        const numbers = step('Build number and versions');
        expect(numbers).toContain('"$INPUT_BUILD" != "$committed"');
        expect(numbers).toContain('never reuse an uploaded number');
        expect(step('Upload to TestFlight (once)')).toContain("if: env.SIGN == 'true' && inputs.upload");
        expect(code).toContain('<key>manageAppVersionAndBuildNumber</key><false/>');
        expect(code).toMatch(/upload:\s*\n\s*description:[^\n]*\n\s*type: boolean\n\s*default: false/);
    });

    it('verifies the signed app as the release docs do before any upload', () => {
        const verify = step('Verify the signed app');
        for (const check of [
            "fail 'not signed Apple Distribution'",
            "fail 'aps-environment'",
            "fail 'get-task-allow'",
            "fail 'beta-reports-active'",
            "fail 'Sign in with Apple'",
            "fail 'associated domains'",
            "fail 'WeatherKit'",
            "fail 'a Watch app or extension is embedded'",
            'differs from dist',
            "fail 'source maps in the app'",
        ])
            expect(verify).toContain(check);
        const order = steps.map((s) => s.name);
        expect(order.indexOf('Verify the signed app')).toBeLessThan(order.indexOf('Upload to TestFlight (once)'));
    });

    it('keeps no app, archive or key as an artifact, and cleans up after itself', () => {
        expect(code).not.toMatch(/upload-artifact|actions\/cache/);
        expect(code).toContain('persist-credentials: false');
        const cleanup = step('Remove the keychain and key');
        expect(cleanup).toContain("if: always() && env.SIGN == 'true'");
        expect(cleanup).toContain('security delete-keychain');
        expect(cleanup).toContain('"$RUNNER_TEMP/asc"');
        expect(step('Signing keychain and App Store Connect key')).toContain('::add-mask::$password');
    });

    it("checks the Google sign-in client against the app's URL scheme before building", () => {
        expect(step("Google sign-in client matches the app's URL scheme")).toContain('ios/App/App/Info.plist');
    });
});
