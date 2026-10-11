/**
 * The iPhone build on a GitHub-hosted Mac (.github/workflows/ios-testflight.yml).
 *
 * It holds Apple signing material, so its rules are pinned here, not left to
 * review: this file names Apple secrets only in the signing steps of an
 * owner-run build, never for a pull request and never under a VITE_* name
 * (every VITE_* value is inlined into the app bundle); an uploaded build number
 * is never reused; no app, archive or key is kept as an artifact; the
 * certificate is imported non-extractable; the keychain and key are removed.
 *
 * What these tests cannot promise: anyone who can push a workflow to this repo
 * can read repository secrets, and dependency code runs on the same machine as
 * the keys. docs/IOS_TESTFLIGHT_CI.md says so and how to revoke the key.
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
    });

    it('checks every Apple secret is present, and keeps the certificate non-extractable', () => {
        const signing = step('Signing keychain and App Store Connect key');
        const loop = /for name in ([^;]+);/.exec(signing)?.[1].split(/\s+/) ?? [];
        expect([...loop].sort()).toEqual([...APPLE_SECRETS].sort());
        for (const name of APPLE_SECRETS) expect(signing).toContain(`${name}: \${{ secrets.${name} }}`);
        expect(signing).toContain('-----BEGIN PRIVATE KEY-----');
        const importLine = signing.split('\n').find((line) => line.includes('security import')) ?? '';
        expect(importLine).toContain(' -x ');
        expect(importLine).not.toContain('/usr/bin/security');
    });

    it('builds only the committed build number, and uploads once only when asked', () => {
        const numbers = step('Build number and versions');
        expect(numbers).toContain('"$INPUT_BUILD" != "$committed"');
        expect(numbers).toContain('never reuse an uploaded number');
        // No default ref: master's committed number may already be uploaded.
        expect(code).toMatch(/ref:\s*\n\s*description:[^\n]*\n\s*required: true\n(?!\s*default:)/);
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
            "fail 'commit stamp differs from HEAD'",
        ])
            expect(verify).toContain(check);
        // `find | grep -q` fails open under pipefail when find is killed by SIGPIPE.
        expect(verify).not.toMatch(/find [^\n]*\|\s*grep/);
        // On a dispatch GITHUB_SHA names "Use workflow from", not the commit built.
        expect(step('npm run ship:beta')).toContain('GITHUB_SHA="$(git rev-parse HEAD)" npm run ship:beta');
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

    it('does not download browsers nothing in the build uses', () => {
        const jobEnv = code.slice(code.indexOf('        env:'), code.indexOf('        steps:'));
        expect(jobEnv).toContain("PUPPETEER_SKIP_DOWNLOAD: 'true'");
    });

    it("checks the Google sign-in client against the app's URL scheme before building", () => {
        expect(step("Google sign-in client matches the app's URL scheme")).toContain('ios/App/App/Info.plist');
    });
});
