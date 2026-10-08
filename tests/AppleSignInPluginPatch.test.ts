import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * @capacitor-community/apple-sign-in 7.1.0 called performRequests() on
 * Capacitor's background "bridge" queue with no presentation anchor, kept its
 * pending call id in UserDefaults, and rejected with only localizedDescription,
 * so JavaScript could not tell Apple error 1000 (unknown) from 1001 (canceled).
 * patch-package fixes all three on every `npm ci` (postinstall). This pins the
 * patch's shape; the Swift itself is parse-checked with `xcrun swiftc -parse`
 * and compiled in the archive build.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const PATCH = 'patches/@capacitor-community+apple-sign-in+7.1.0.patch';
const PLUGIN = 'node_modules/@capacitor-community/apple-sign-in/ios/Sources/SignInWithApple/Plugin.swift';

describe('Sign in with Apple plugin patch', () => {
    it('is applied by every install, against the exact plugin version the lockfile pins', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.scripts.postinstall).toBe('patch-package');
        const lock = JSON.parse(read('package-lock.json'));
        expect(lock.packages['node_modules/@capacitor-community/apple-sign-in'].version).toBe('7.1.0');
        expect(existsSync(join(root, PATCH))).toBe(true);
    });

    it('changes Plugin.swift and nothing else', () => {
        const files = [...read(PATCH).matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => match[2]);
        expect(files).toEqual([PLUGIN]);
    });

    it('presents on the main thread with a presentation anchor and reports the Apple error code', () => {
        const added = read(PATCH)
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .join('\n');
        expect(added).toContain('DispatchQueue.main.async');
        expect(added).toContain('controller.presentationContextProvider = self');
        expect(added).toContain('ASAuthorizationControllerPresentationContextProviding');
        expect(added).toContain('bridge?.webView?.window');
        // The NSError code travels as the call's error code AND in its message.
        expect(added).toMatch(/call\.reject\([^\n]*String\(code\)[^\n]*, String\(code\)/);
        // The pending call lives on the plugin instance, not in UserDefaults.
        expect(added).toContain('private var pendingCall: CAPPluginCall?');
        expect(added).not.toMatch(/UserDefaults\s*\(/);
    });

    it('is what this checkout actually compiles', () => {
        const plugin = read(PLUGIN);
        expect(plugin).toContain('controller.presentationContextProvider = self');
        expect(plugin).not.toMatch(/UserDefaults\s*\(/);
        expect(plugin).not.toContain('identityToken!');
    });
});
