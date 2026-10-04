// @vitest-environment node
/**
 * Local Ruby project-generation fixtures and Swift source contracts only.
 * No compiler, signing, provisioning, network, credentials or device actions.
 * These checks are NOT physical launch or Auth/session-continuity evidence.
 * The existing macOS Homebrew Ruby/xcodeproj runtime is required; never install it here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUBY = '/opt/homebrew/opt/ruby/bin/ruby';
const BUNDLE = 'app.thalassa.research.scuttlebutt-auth';
const SCENE_NAME = 'Research Window';
const SCENE_DELEGATE = 'ResearchSceneDelegate';
const NATIVE = fileURLToPath(new URL('../experiments/scuttlebutt-e2ee/bridge-native/', import.meta.url));
const APP_SOURCE = readFileSync(join(NATIVE, 'ResearchApp.swift'), 'utf8');
const TEMP_PREFIX = 'thalassa-research-launch-fixture-';
const PLATFORMS = ['iphoneos', 'iphonesimulator'] as const;
const GENERATED = new Map<string, GeneratedProject>();
const temporaryRoots: string[] = [];

type GeneratedProject = {
    info: Record<string, unknown>;
    attributes: Record<string, unknown>;
    targets: {
        name: string;
        productType: string;
        configurations: { name: string; settings: Record<string, unknown> }[];
        sourceFiles: string[];
        resourceFiles: string[];
        scriptPhases: number;
    }[];
};

function ruby(args: string[]): string {
    const result = spawnSync(RUBY, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    // Fail rather than skip or silently substitute a source-only assertion.
    expect(result.error, 'existing local Ruby invocation must complete').toBeUndefined();
    expect(result.signal, 'generator fixture must not time out').toBeNull();
    expect(result.status, 'existing xcodeproj generator/reader must succeed').toBe(0);
    return result.stdout;
}

function createProject(platform: (typeof PLATFORMS)[number]): GeneratedProject {
    const root = realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    for (const directory of [
        'Sources',
        'Bindings',
        'Provider',
        'public',
        'Frameworks/Capacitor.framework',
        'Frameworks/Cordova.framework',
    ]) {
        mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
    }
    const write = (path: string, content: string) =>
        writeFileSync(join(root, path), content, { mode: 0o600, flag: 'wx' });
    const sources = ['ResearchApp.swift', 'ScuttlebuttResearchAuthPlugin.swift', 'ResearchAuthHost.swift'];
    write('Sources/ResearchApp.swift', APP_SOURCE);
    for (const name of sources.slice(1))
        write('Sources/' + name, '// Synthetic generation-only fixture; never compiled.\n');
    write('Bindings/research_binding.swift', '// Synthetic binding; never compiled.\n');
    write('Bindings/research_binding.modulemap', '// Synthetic module map; never compiled.\n');
    write('Provider/libthalassa_vodozemac_native.a', 'synthetic generation-only archive placeholder\n');
    write('public/index.html', '<!doctype html><title>Generation fixture only</title>\n');
    write('capacitor.config.json', JSON.stringify({ appId: BUNDLE, webDir: 'public', loggingBehavior: 'none' }));
    write('research-config.json', '{}\n');
    write('config.xml', '<widget/>\n');
    write(
        'generator-input.json',
        JSON.stringify({
            projectRoot: root,
            bundleId: BUNDLE,
            platform,
            sources,
            bindingSwift: 'research_binding.swift',
            moduleMap: 'research_binding.modulemap',
        }),
    );
    ruby([join(NATIVE, 'generate_project.rb'), join(root, 'generator-input.json')]);
    // Parse ACTUAL generator output through its existing plist/project library.
    // This reader is literal code; neither input resources nor Swift are executed.
    const output = ruby([
        '-e',
        `
require 'json'
require 'xcodeproj'
project = Xcodeproj::Project.open(ARGV.fetch(0))
info = Xcodeproj::Plist.read_from_path(ARGV.fetch(1))
puts JSON.generate({
  info: info, attributes: project.root_object.attributes,
  targets: project.targets.map { |target| {
    name: target.name, productType: target.product_type,
    configurations: target.build_configurations.map { |config| {name: config.name, settings: config.build_settings} },
    sourceFiles: target.source_build_phase.files_references.map { |file| File.basename(file.path) }.sort,
    resourceFiles: target.resources_build_phase.files_references.map { |file| File.basename(file.path) }.sort,
    scriptPhases: target.shell_script_build_phases.length
  } }
})
`,
        join(root, 'ScuttlebuttResearchAuth.xcodeproj'),
        join(root, 'Info.plist'),
    ]);
    return JSON.parse(output) as GeneratedProject;
}

beforeAll(() => {
    for (const platform of PLATFORMS) GENERATED.set(platform, createProject(platform));
}, 50_000);

afterAll(() => {
    const parent = realpathSync(tmpdir());
    for (const root of temporaryRoots) {
        // Only exact mkdtemp-created fixture roots; never a checkout or broad temp directory.
        if (dirname(root) !== parent || !basename(root).startsWith(TEMP_PREFIX))
            throw new Error('Unsafe fixture cleanup target');
        rmSync(root, { recursive: true, force: false });
    }
});

function swiftBlock(source: string, signature: RegExp): { signature: string; body: string } {
    const matched = signature.exec(source);
    expect(matched, 'expected Swift declaration must exist').not.toBeNull();
    if (!matched) throw new Error('Swift declaration missing');
    const open = source.indexOf('{', matched.index + matched[0].length);
    if (open < 0) throw new Error('Swift declaration body missing');
    let depth = 1;
    for (let index = open + 1; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return { signature: source.slice(matched.index, open), body: source.slice(open + 1, index) };
    }
    throw new Error('Swift declaration body unbalanced');
}

describe('actual isolated research generator output — no compilation or device proof', () => {
    it.each(PLATFORMS)(
        '%s emits exactly one explicit UIWindowScene configuration, build 2 and no extra capabilities',
        (platform) => {
            const generated = GENERATED.get(platform)!;
            expect(generated.info).toEqual({
                CFBundleDevelopmentRegion: 'en',
                CFBundleDisplayName: 'Scuttlebutt Research',
                CFBundleExecutable: '$(EXECUTABLE_NAME)',
                CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
                CFBundleInfoDictionaryVersion: '6.0',
                CFBundleName: '$(PRODUCT_NAME)',
                CFBundlePackageType: 'APPL',
                CFBundleShortVersionString: '0.1.0',
                CFBundleVersion: '2',
                LSRequiresIPhoneOS: true,
                UILaunchScreen: {},
                UIApplicationSceneManifest: {
                    UIApplicationSupportsMultipleScenes: false,
                    UISceneConfigurations: {
                        UIWindowSceneSessionRoleApplication: [
                            {
                                UISceneConfigurationName: SCENE_NAME,
                                UISceneClassName: 'UIWindowScene',
                                UISceneDelegateClassName: SCENE_DELEGATE,
                            },
                        ],
                    },
                },
                UISupportedInterfaceOrientations: [
                    'UIInterfaceOrientationPortrait',
                    'UIInterfaceOrientationLandscapeLeft',
                    'UIInterfaceOrientationLandscapeRight',
                ],
                'UISupportedInterfaceOrientations~ipad': [
                    'UIInterfaceOrientationPortrait',
                    'UIInterfaceOrientationPortraitUpsideDown',
                    'UIInterfaceOrientationLandscapeLeft',
                    'UIInterfaceOrientationLandscapeRight',
                ],
            });
            // Exact Info keys exclude storyboard, background modes, ATS exceptions,
            // URL schemes and new usage/permission descriptions.
            expect(generated.targets).toHaveLength(1);
            const target = generated.targets[0];
            expect(target.name).toBe('ScuttlebuttResearchAuth');
            expect(target.productType).toBe('com.apple.product-type.application');
            expect(target.configurations.map((config) => config.name).sort()).toEqual(['Debug', 'Release']);
            for (const { settings } of target.configurations) {
                expect(settings).toMatchObject({
                    PRODUCT_BUNDLE_IDENTIFIER: BUNDLE,
                    PRODUCT_NAME: 'ScuttlebuttResearchAuth',
                    INFOPLIST_FILE: 'Info.plist',
                    GENERATE_INFOPLIST_FILE: 'NO',
                    IPHONEOS_DEPLOYMENT_TARGET: '17.0',
                    TARGETED_DEVICE_FAMILY: '1,2',
                    CODE_SIGNING_ALLOWED: 'NO',
                    CODE_SIGNING_REQUIRED: 'NO',
                    CODE_SIGN_IDENTITY: '',
                    DEVELOPMENT_TEAM: '',
                    AD_HOC_CODE_SIGNING_ALLOWED: 'NO',
                    SUPPORTS_MACCATALYST: 'NO',
                    SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD: 'NO',
                });
                expect(settings).not.toHaveProperty('CODE_SIGN_ENTITLEMENTS');
                expect(Object.keys(settings).some((key) => /STORYBOARD|USAGE_DESCRIPTION|CAPABILIT/i.test(key))).toBe(
                    false,
                );
            }
            expect(generated.attributes).not.toHaveProperty('SystemCapabilities');
            expect(JSON.stringify(generated.attributes)).not.toContain('SystemCapabilities');
            expect(target.scriptPhases).toBe(0);
            expect(target.sourceFiles).toEqual([
                'ResearchApp.swift',
                'ResearchAuthHost.swift',
                'ScuttlebuttResearchAuthPlugin.swift',
                'research_binding.swift',
            ]);
            expect(target.resourceFiles).toEqual([
                'capacitor.config.json',
                'config.xml',
                'public',
                'research-config.json',
            ]);
        },
    );
});

describe('single research scene source contract — not Swift compilation or physical launch', () => {
    it('ties the manifest delegate name to one Objective-C-visible UIWindowSceneDelegate class', () => {
        expect(APP_SOURCE).toMatch(
            /@objc\(ResearchSceneDelegate\)\s+final\s+class\s+ResearchSceneDelegate\s*:\s*UIResponder\s*,\s*UIWindowSceneDelegate/,
        );
        expect(APP_SOURCE.match(/\bclass\s+ResearchSceneDelegate\b/g)).toHaveLength(1);
        expect(APP_SOURCE.match(/@main\b/g)).toHaveLength(1);
    });
    it('returns the named configuration for the incoming session role and the exact research delegate', () => {
        const app = swiftBlock(APP_SOURCE, /final\s+class\s+ResearchApp\s*:\s*UIResponder\s*,\s*UIApplicationDelegate/);
        const connecting = swiftBlock(
            app.body,
            /func\s+application\s*\([^{}]*configurationForConnecting\s+\w+\s*:\s*UISceneSession[^{}]*\)\s*->\s*UISceneConfiguration/,
        );
        const session = connecting.signature.match(/configurationForConnecting\s+(\w+)\s*:\s*UISceneSession/)!;
        const configuration = connecting.body.match(
            /(?:let|var)\s+(\w+)\s*=\s*UISceneConfiguration\s*\(\s*name:\s*"Research Window"\s*,\s*sessionRole:\s*(\w+)\.role\s*\)/,
        );
        expect(configuration).not.toBeNull();
        if (!configuration) throw new Error('Named scene configuration missing');
        expect(configuration[2]).toBe(session[1]);
        expect(connecting.body).toMatch(
            new RegExp('\\b' + configuration[1] + '\\.sceneClass\\s*=\\s*UIWindowScene\\.self'),
        );
        expect(connecting.body).toMatch(
            new RegExp('\\b' + configuration[1] + '\\.delegateClass\\s*=\\s*ResearchSceneDelegate\\.self'),
        );
        expect(connecting.body).toMatch(new RegExp('\\breturn\\s+' + configuration[1] + '\\b'));
        expect(app.body).not.toMatch(/UIWindow\s*\(|rootViewController|makeKeyAndVisible|var\s+window\s*:/);
    });
    it('guards the application session role before creating and retaining its scene-owned bridge window', () => {
        const scene = swiftBlock(
            APP_SOURCE,
            /final\s+class\s+ResearchSceneDelegate\s*:\s*UIResponder\s*,\s*UIWindowSceneDelegate/,
        );
        expect(scene.body).toMatch(/var\s+window\s*:\s*UIWindow\?/);
        const connecting = swiftBlock(
            scene.body,
            /func\s+scene\s*\([^{}]*willConnectTo\s+\w+\s*:\s*UISceneSession[^{}]*\)/,
        );
        const guard = connecting.body.match(
            /guard\s+(\w+)\.role\s*==\s*\.windowApplication\s*,\s*let\s+(\w+)\s*=\s*(\w+)\s+as\?\s+UIWindowScene\s+else\s*\{\s*return\s*\}/,
        );
        expect(guard).not.toBeNull();
        if (!guard) throw new Error('Application-role and window-scene refusal guard missing');
        expect(connecting.signature).toMatch(new RegExp('willConnectTo\\s+' + guard[1] + '\\s*:\\s*UISceneSession'));
        expect(connecting.signature).toMatch(new RegExp('\\b' + guard[3] + '\\s*:\\s*UIScene'));
        const window = connecting.body.match(/let\s+(\w+)\s*=\s*UIWindow\s*\(\s*windowScene:\s*(\w+)\s*\)/);
        expect(window).not.toBeNull();
        if (!window) throw new Error('Scene-owned window creation missing');
        expect(window[2]).toBe(guard[2]);
        expect(guard.index! + guard[0].length).toBeLessThanOrEqual(window.index!);
        const bridgeCreation = connecting.body.indexOf('ResearchBridgeViewController()');
        expect(bridgeCreation).toBeGreaterThan(window.index!);
        expect(connecting.body).toMatch(
            new RegExp('\\b' + window[1] + '\\.rootViewController\\s*=\\s*ResearchBridgeViewController\\(\\)'),
        );
        expect(connecting.body).toMatch(new RegExp('\\bself\\.window\\s*=\\s*' + window[1] + '\\b'));
        expect(connecting.body).toMatch(new RegExp('\\b' + window[1] + '\\.makeKeyAndVisible\\(\\)'));
        expect(APP_SOURCE.match(/\bUIWindow\s*\(/g)).toHaveLength(1);
        expect(APP_SOURCE).not.toMatch(/UIWindow\s*\(\s*frame:|UIScreen\.main\.bounds/);
    });
    it('retains the Capacitor bridge registration without adding auth/session lifecycle mutations', () => {
        const bridge = swiftBlock(
            APP_SOURCE,
            /final\s+class\s+ResearchBridgeViewController\s*:\s*CAPBridgeViewController/,
        );
        const loaded = swiftBlock(bridge.body, /override\s+func\s+capacitorDidLoad\s*\(\s*\)/);
        expect(loaded.body).toContain('bridge?.registerPluginInstance(ScuttlebuttResearchAuthPlugin())');
        expect(APP_SOURCE.match(/registerPluginInstance\s*\(/g)).toHaveLength(1);
        expect(APP_SOURCE.match(/ResearchBridgeViewController\s*\(\s*\)/g)).toHaveLength(1);
        expect(APP_SOURCE).not.toMatch(
            /\b(?:fenceSession|authenticate|clearSelectedAccount|selectVerifiedIdentity|signOut|logout|reverify)\s*\(|\.reset\s*\(/,
        );
    });
});
