import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

function buildConfiguration(project: string, id: string): string {
    const section = project.slice(project.indexOf('/* Begin XCBuildConfiguration section */'));
    const configuration = section.match(new RegExp(`${id} /\\* [^*]+ \\*/ = \\{([\\s\\S]*?)\\n\\t\\t\\};`));
    expect(configuration, `build configuration ${id} exists`).not.toBeNull();
    return configuration![1];
}

describe('reviewed Xcode 27 recommendations', () => {
    it('survives pod regeneration without repeating the Cordova archive regression or changing app policy', () => {
        const podfile = read('ios/App/Podfile');
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        // Read executable hook lines, not the historical comments documenting
        // the failing ENABLE_MODULE_VERIFIER = YES migration in archive 106.
        const hook = podfile.slice(podfile.indexOf('post_install do |installer|')).replace(/^\s*#.*$/gm, '');

        for (const stamp of ['LastUpgradeCheck', 'LastSwiftUpdateCheck']) {
            expect(hook).toContain(`installer.pods_project.root_object.attributes['${stamp}'] = '2700'`);
            expect(project).toMatch(new RegExp(`${stamp} = 2700;`));
        }

        expect(hook).toContain(
            'obsolete_swift_settings = %w[EMBEDDED_CONTENT_CONTAINS_SWIFT ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES]',
        );
        const aggregateCleanup = hook.slice(
            hook.indexOf('installer.aggregate_targets.each'),
            hook.indexOf('installer.pods_project.targets.each'),
        );
        expect(aggregateCleanup).toContain('aggregate.xcconfigs.each do |configuration_name, xcconfig|');
        expect(aggregateCleanup).toContain('obsolete_swift_settings.each { |key| xcconfig.attributes.delete(key) }');
        expect(aggregateCleanup).toContain('xcconfig.save_as(aggregate.xcconfig_path(configuration_name))');

        const podTargetPolicy = hook.slice(
            hook.indexOf('installer.pods_project.targets.each'),
            hook.indexOf('silence_cp_phases ='),
        );
        expect(podTargetPolicy).toContain('target.build_configurations.each do |config|');
        expect(podTargetPolicy).toContain('obsolete_swift_settings.each { |key| config.build_settings.delete(key) }');
        for (const [setting, value] of Object.entries({
            ENABLE_MODULE_VERIFIER: 'NO',
            ENABLE_USER_SCRIPT_SANDBOXING: 'NO',
            CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER: 'NO',
            CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES: 'YES',
            IPHONEOS_DEPLOYMENT_TARGET: '17.0',
            SWIFT_VERSION: '5.0',
        })) {
            expect(podTargetPolicy).toContain(`config.build_settings['${setting}'] = '${value}'`);
        }
        expect(hook).toContain('installer.pods_project.save');
        expect(hook).not.toMatch(/(?:CODE_SIGNING_ALLOWED|CODE_SIGNING_REQUIRED|CODE_SIGN_IDENTITY|DEVELOPMENT_TEAM)/);

        // The vendor exceptions must not leak into either first-party target.
        expect(project).not.toContain('ENABLE_MODULE_VERIFIER = NO');
        expect(project).not.toContain('-suppress-warnings');
        expect(project).not.toContain('EMBEDDED_CONTENT_CONTAINS_SWIFT');
        expect(project).not.toContain('ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES');
        for (const id of ['504EC3141FED79650016851F', '504EC3151FED79650016851F']) {
            const configuration = buildConfiguration(project, id);
            expect(configuration).toContain('CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES;');
            expect(configuration).toContain('IPHONEOS_DEPLOYMENT_TARGET = 17.0;');
        }
        for (const [id, environment] of Object.entries({
            '504EC3171FED79650016851F': 'development',
            '504EC3181FED79650016851F': 'production',
        })) {
            const configuration = buildConfiguration(project, id);
            expect(configuration).toContain(`APS_ENVIRONMENT = ${environment};`);
            expect(configuration).toContain('CODE_SIGN_STYLE = Automatic;');
            expect(configuration).toContain('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;');
        }
        for (const id of ['A5CCB7392F98653D00778C68', 'A5CCB73A2F98653D00778C68']) {
            const configuration = buildConfiguration(project, id);
            expect(configuration).toContain('ENABLE_USER_SCRIPT_SANDBOXING = YES;');
            expect(configuration).toContain('SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor;');
            expect(configuration).toContain('WATCHOS_DEPLOYMENT_TARGET = 10.0;');
        }
    });
});
