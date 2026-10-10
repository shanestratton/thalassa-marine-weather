/**
 * The wiring a box tag needs to open Thalassa (126-11b), pinned as file text.
 *
 * None of it can be exercised in vitest and all of it fails silently: a
 * missing entitlement makes Core NFC refuse to start, a SceneDelegate that
 * does not forward means a tapped link opens the app on The Glass instead of
 * the box, and a wrong association file makes iOS open Safari. The archive
 * proves the Swift compiles; Shane's tags prove the rest on a device.
 *
 * Shane, 2026-10-10: "NTAG213, 215 or 216 - it must be one of these claude,
 * because i can write to them and read them back". Thalassa never locks a tag,
 * so any tag can be rewritten for another box.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOX_LINK_ORIGIN } from '../scripts/verify-web-release.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const IOS = 'ios/App/App';

/** The <array> of strings under a plist key, or null when the key is absent. */
function plistStrings(plist: string, key: string): string[] | null {
    const at = plist.indexOf(`<key>${key}</key>`);
    if (at < 0) return null;
    const array = plist.slice(at).match(/<\/key>\s*<array>([\s\S]*?)<\/array>/);
    return array ? [...array[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]) : null;
}

describe('iOS: NFC and the box links', () => {
    it('the entitlements read NFC tags as TAG (never NDEF) and claim only www.thalassawx.app', () => {
        const entitlements = read(`${IOS}/App.entitlements`);
        expect(plistStrings(entitlements, 'com.apple.developer.nfc.readersession.formats')).toEqual(['TAG']);
        expect(entitlements).not.toMatch(/<string>NDEF<\/string>/);
        // www, not the apex: the apex 307s to www and Apple reads no association file behind a redirect.
        expect(plistStrings(entitlements, 'com.apple.developer.associated-domains')).toEqual([
            'applinks:www.thalassawx.app',
        ]);
        // What was there stays.
        expect(entitlements).toContain('<key>com.apple.developer.applesignin</key>');
        expect(entitlements).toContain('<key>com.apple.developer.weatherkit</key>');
        expect(entitlements).toContain('<key>aps-environment</key>');
    });

    it('the tags, the entitlement and the post-deploy check all name the same host', async () => {
        const { boxLinkFor } = await import('../services/native/nfcTags');
        const onTag = new URL(boxLinkFor('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'));
        const entitlements = read(`${IOS}/App.entitlements`);
        expect(plistStrings(entitlements, 'com.apple.developer.associated-domains')).toEqual([
            `applinks:${onTag.hostname}`,
        ]);
        // scripts/verify-web-release.mjs fetches the association file from this host itself,
        // with no redirect followed, after every production deploy.
        expect(BOX_LINK_ORIGIN).toBe(onTag.origin);
        expect(read('scripts/verify-web-release.mjs')).toMatch(
            /getResponse\(\s*BOX_LINK_ORIGIN,\s*APP_SITE_ASSOCIATION_PATH,\s*'manual'/,
        );
    });

    it('Info.plist says why Thalassa uses NFC, in words about the boxes', () => {
        const plist = read(`${IOS}/Info.plist`);
        const usage = plist.match(/<key>NFCReaderUsageDescription<\/key>\s*<string>([^<]+)<\/string>/);
        expect(usage?.[1]).toMatch(/stowage boxes/);
    });

    it('SceneDelegate hands every link to Capacitor: cold start, a tapped link, a URL', () => {
        const scene = read(`${IOS}/SceneDelegate.swift`);
        expect(scene).toContain(
            'SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)',
        );
        expect(scene).toMatch(/func scene\(_ scene: UIScene, continue userActivity: NSUserActivity\)/);
        expect(scene).toContain('SceneDelegateProxy.shared.scene(scene, continue: userActivity)');
        expect(scene).toMatch(/func scene\(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>\)/);
        expect(scene).toContain('SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)');
        // The window still comes from the storyboard: forwarding must not return early before it.
        expect(scene).not.toMatch(
            /guard let _ = \(scene as\? UIWindowScene\) else \{ return \}\s*\n\s*SceneDelegateProxy/,
        );
    });

    it('the NfcTag plugin is registered, declared with its three calls, and in the build', () => {
        expect(read(`${IOS}/ThalassaBridgeViewController.swift`)).toContain(
            'bridge?.registerPluginInstance(NfcTagPlugin())',
        );
        const bridge = read(`${IOS}/NfcTagPlugin.m`);
        expect(bridge).toMatch(/CAP_PLUGIN\(NfcTagPlugin, "NfcTag",/);
        for (const method of ['isAvailable', 'write', 'scan']) {
            expect(bridge).toContain(`CAP_PLUGIN_METHOD(${method}, CAPPluginReturnPromise);`);
        }
        const swift = read(`${IOS}/NfcTagPlugin.swift`);
        expect(swift).toContain('@objc(NfcTagPlugin)');
        for (const method of ['isAvailable', 'write', 'scan']) {
            expect(swift).toMatch(new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)`));
        }
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        const count = (text: string) => project.split(text).length - 1;
        for (const file of ['NfcTagPlugin.swift', 'NfcTagPlugin.m', 'DataScannerPlugin.swift']) {
            // The file reference, the App group and the build file's fileRef name the file;
            // the build file and the App target's Sources phase name the build file.
            expect(count(`/* ${file} */`), file).toBe(3);
            expect(count(`/* ${file} in Sources */`), file).toBe(2);
            expect(project).toContain(`/* ${file} in Sources */,`);
        }
    });

    it('the plugin answers from Core NFC callbacks, never by waiting, and ends its session on every way out', () => {
        const swift = read(`${IOS}/NfcTagPlugin.swift`);
        // Capacitor runs every plugin call on one serial queue (capacitor-bridge-queue):
        // anything that blocks here stalls every other plugin.
        expect(swift).not.toMatch(/DispatchSemaphore|\.wait\(|\.sync\s*\{|Thread\.sleep|usleep/);
        expect(swift).toContain('NFCTagReaderSession(pollingOption: .iso14443');
        expect(swift).toContain(
            'func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error)',
        );
        // One place answers the call, and it invalidates the session first.
        expect(swift).toMatch(/func finish\([\s\S]*?invalidate[\s\S]*?resolve/);
        // Read straight back after writing: a tag that can't be read in place is caught at once.
        expect(swift).toContain('readNDEF');
        expect(swift).toContain('not_verified');
        // The capacity check comes before the write.
        expect(swift.indexOf('capacity')).toBeLessThan(swift.indexOf('writeNDEF'));
        // Scan box refusing a transit card says what the app will say, not the write words.
        expect(swift).toMatch(/message == nil\s*\?\s*"This tag isn't a box tag from Thalassa\."/);
    });

    it('the app listens for box links on iOS only, from inside the app shell', () => {
        const shell = read('ApplicationShell.tsx');
        expect(shell).toMatch(
            /if \(Capacitor\.isNativePlatform\(\)\) \{\s*void import\('\.\/services\/boxLinks'\)\.then\(\(links\) => links\.installBoxLinks\(\)\)/,
        );
        // Not at the web's entry: boxLinks must never be in the first load.
        expect(read('index.tsx')).not.toContain('boxLinks');
    });

    it('no Swift file ever locks a tag', () => {
        for (const file of readdirSync(IOS).filter((name) => name.endsWith('.swift'))) {
            expect(read(`${IOS}/${file}`), file).not.toMatch(/writeLock/);
        }
    });
});

describe('the web: the association file and the page for phones without Thalassa', () => {
    it('apple-app-site-association is JSON that claims only /box/* for this app', () => {
        const association = JSON.parse(read('public/.well-known/apple-app-site-association'));
        expect(Object.keys(association)).toEqual(['applinks']);
        const details = association.applinks.details;
        expect(details).toHaveLength(1);
        expect(details[0].appIDs).toEqual(['D4TW8A23QZ.com.thalassa.weather']);
        expect(details[0].components.map((component: { '/': string }) => component['/'])).toEqual(['/box/*']);
        // The team and bundle id are the ones the project signs with.
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        expect(project).toContain('DEVELOPMENT_TEAM = D4TW8A23QZ;');
        expect(project).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.thalassa.weather;');
    });

    it('vercel.json serves it as JSON, and /box/<id> as the static page before the app catch-all', () => {
        const config = JSON.parse(read('vercel.json'));
        const header = config.headers.filter(
            (rule: { source: string }) => rule.source === '/.well-known/apple-app-site-association',
        );
        expect(header).toHaveLength(1);
        expect(header[0].headers).toEqual([{ key: 'Content-Type', value: 'application/json' }]);
        const sources = config.rewrites.map((rule: { source: string }) => rule.source);
        const box = sources.indexOf('/box/:id');
        expect(box).toBeGreaterThanOrEqual(0);
        expect(config.rewrites[box].destination).toBe('/box.html');
        expect(box).toBeLessThan(sources.indexOf('/((?!api/)(?!.*\\..*).*)'));
        // No redirect anywhere near the association file: Apple refuses one.
        expect(JSON.stringify(config.redirects)).not.toContain('well-known');
    });

    it('box.html runs no script, loads nothing, and tells a stranger nothing about the box', () => {
        const html = read('public/box.html');
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/\bsrc=|<link[^>]+href="(?!data:)/i);
        expect(html).toContain('This tag belongs to a stowage box on a boat that uses Thalassa.');
        expect(html).toMatch(/<meta name="robots" content="noindex/);
        expect(html).toMatch(/prefers-color-scheme: dark/);
    });
});
