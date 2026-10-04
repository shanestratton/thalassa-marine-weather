// @vitest-environment node
/** Pure validation fixtures only: no Keychain, CMS trust, codesign, build,
 * network, provisioning, installation, launch or physical-device evidence. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The CLI entry point is direct-invocation guarded; import never signs.
import {
    BUNDLE,
    DEVICES,
    appleSignatureRequirement,
    certificateExtractionArguments,
    decodePlist,
    parseArguments,
    researchEntitlements,
    validateFinalEntitlements,
    validateProfile,
} from '../experiments/scuttlebutt-e2ee/bridge-native/signDevice.mjs';

const NOW = Date.parse('2026-10-04T00:00:00Z');
const TEAM = 'ABCDE12345',
    PREFIX = 'ZYXWV98765';
const DER = Buffer.from('synthetic-certificate-bytes-not-a-real-X509-certificate');
const IDENTITY = createHash('sha1').update(DER).digest('hex').toUpperCase();
function fixture() {
    const profile = {
        TeamIdentifier: [TEAM],
        ApplicationIdentifierPrefix: [PREFIX],
        Entitlements: researchEntitlements(TEAM, PREFIX),
        Platform: ['iOS'],
        ProvisionedDevices: [...DEVICES],
        DeveloperCertificates: [DER],
        CreationDate: '2026-10-01T00:00:00Z',
        ExpirationDate: '2026-11-01T00:00:00Z',
        UUID: '11111111-1111-4111-8111-111111111111',
        Version: 1,
    };
    const certificate = {
        fingerprint: IDENTITY,
        commonName: 'Apple Development: Synthetic Fixture',
        team: TEAM,
        validFrom: Date.parse('2026-10-01T00:00:00Z'),
        validTo: Date.parse('2026-11-01T00:00:00Z'),
    };
    return { profile, certificate };
}
function argv() {
    return [
        '--receipt',
        '/private/tmp/research/build-receipt.json',
        '--identity',
        IDENTITY,
        '--profile',
        '/private/tmp/research/development.mobileprovision',
        '--device',
        DEVICES[0],
        '--device',
        DEVICES[1],
    ];
}
function xml(body: string) {
    return '<?xml version="1.0"?><plist version="1.0"><dict>' + body + '</dict></plist>';
}

describe('research-only offline signing validators', () => {
    it('defaults to inspection; only explicit --sign can select signing', () => {
        expect(parseArguments(argv()).sign).toBe(false);
        expect(parseArguments([...argv(), '--sign']).sign).toBe(true);
        expect(() => parseArguments([...argv(), '--sign', '--sign'])).toThrow();
    });
    it('uses literal codesign requirement syntax, fixed Apple anchor and exact team/bundle', () => {
        expect(appleSignatureRequirement(TEAM, BUNDLE)).toBe(
            '=anchor apple generic and certificate leaf[subject.OU] = "' + TEAM + '" and identifier "' + BUNDLE + '"',
        );
        expect(appleSignatureRequirement(TEAM)).toBe(
            '=anchor apple generic and certificate leaf[subject.OU] = "' + TEAM + '"',
        );
        expect(() => appleSignatureRequirement(TEAM, '" or true')).toThrow();
        expect(() => appleSignatureRequirement('" or true', BUNDLE)).toThrow();
    });
    it('joins the optional certificate prefix to the codesign flag, never as a code target', () => {
        expect(certificateExtractionArguments('/private/tmp/research/cert-', '/private/tmp/research/app')).toEqual([
            '--display',
            '--extract-certificates=/private/tmp/research/cert-',
            '/private/tmp/research/app',
        ]);
        expect(() => certificateExtractionArguments('cert-', '/private/tmp/research/app')).toThrow();
        expect(() => certificateExtractionArguments('/private/tmp/research/cert-', './app')).toThrow();
        expect(() =>
            certificateExtractionArguments('/private/tmp/research/cert-\n', '/private/tmp/research/app'),
        ).toThrow();
    });
    it('refuses missing, duplicate, unknown or privileged selectors', () => {
        for (const suffix of [
            ['--install'],
            ['--team', TEAM],
            ['--bundle', 'com.thalassa.weather'],
            ['--identity', IDENTITY],
            ['--receipt'],
            ['--entitlements', '/tmp/arbitrary.plist'],
        ]) {
            expect(() => parseArguments([...argv(), ...suffix])).toThrow();
        }
        expect(() => parseArguments(argv().slice(0, -2))).toThrow();
        const duplicateDevice = argv();
        duplicateDevice[duplicateDevice.length - 1] = DEVICES[0];
        expect(() => parseArguments(duplicateDevice)).toThrow();
        const wrongDevice = argv();
        wrongDevice[wrongDevice.length - 1] = '00008030-0000000000000000';
        expect(() => parseArguments(wrongDevice)).toThrow();
        const relative = argv();
        relative[1] = './build-receipt.json';
        expect(() => parseArguments(relative)).toThrow();
    });
    it('permits distinct AppIdentifierPrefix and team, with only exact final group', () => {
        const { profile, certificate } = fixture();
        const result = validateProfile(profile, certificate, [...DEVICES], NOW);
        expect(result.team).toBe(TEAM);
        expect(result.prefix).toBe(PREFIX);
        expect(result.final['application-identifier']).toBe(PREFIX + '.' + BUNDLE);
        expect(result.final['keychain-access-groups']).toEqual([PREFIX + '.' + BUNDLE]);
        validateFinalEntitlements(result.final, TEAM, PREFIX);
    });
    it('accepts standard exact-prefix wildcard profile authorization but never final wildcard', () => {
        const { profile, certificate } = fixture();
        profile.Entitlements['keychain-access-groups'] = [PREFIX + '.*'];
        const result = validateProfile(profile, certificate, [...DEVICES], NOW);
        expect(result.final['keychain-access-groups']).toEqual([PREFIX + '.' + BUNDLE]);
        expect(() => validateFinalEntitlements(profile.Entitlements, TEAM, PREFIX)).toThrow();
    });
    it('accepts the observed Apple profile metadata without adding its token group to the app', () => {
        const { profile, certificate } = fixture();
        profile.Platform = ['iOS', 'xrOS', 'visionOS'];
        profile.Entitlements['keychain-access-groups'] = [PREFIX + '.*', 'com.apple.token'];
        const result = validateProfile(profile, certificate, [...DEVICES], NOW);
        expect(result.final).toEqual(researchEntitlements(TEAM, PREFIX));
        expect(result.final['keychain-access-groups']).toEqual([PREFIX + '.' + BUNDLE]);
        validateFinalEntitlements(result.final, TEAM, PREFIX);
        expect(() => validateFinalEntitlements(profile.Entitlements, TEAM, PREFIX)).toThrow();
        expect(() =>
            validateFinalEntitlements(
                { ...result.final, 'keychain-access-groups': [PREFIX + '.' + BUNDLE, 'com.apple.token'] },
                TEAM,
                PREFIX,
            ),
        ).toThrow();
    });
    it.each([
        ['com.apple.token'],
        [PREFIX + '.*', 'com.apple.token', 'com.apple.token'],
        [PREFIX + '.*', PREFIX + '.*'],
        [PREFIX + '.*', PREFIX + '.' + BUNDLE],
        [PREFIX + '.*', 'com.apple.other'],
        [PREFIX + '.*', 'com.apple.token', PREFIX + '.shared'],
    ])('refuses duplicate, absent-owner or unknown profile groups %j', (...groups) => {
        const { profile, certificate } = fixture();
        profile.Entitlements['keychain-access-groups'] = groups;
        expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
    });
    it.each([
        ['iOS', 'iOS'],
        ['xrOS', 'visionOS'],
        ['iOS', 'macOS'],
        ['iOS', 'xrOS', 'unknown'],
        ['iOS', 'xrOS', 'visionOS', 'macOS'],
        ['iOS,visionOS,xrOS'],
        ['iOS', 'visionOS,xrOS'],
        [],
    ])('refuses unknown, duplicate or unsupported profile platform sets %j', (...platform) => {
        const { profile, certificate } = fixture();
        profile.Platform = platform;
        expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
    });
    it.each<[string, unknown]>([
        ['application-identifier', PREFIX + '.*'],
        ['application-identifier', PREFIX + '.com.thalassa.weather'],
        ['com.apple.developer.team-identifier', 'OTHER12345'],
        ['get-task-allow', false],
        ['keychain-access-groups', ['*']],
        ['keychain-access-groups', [TEAM + '.*']],
        ['keychain-access-groups', [PREFIX + '.com.thalassa.weather']],
        ['keychain-access-groups', [PREFIX + '.' + BUNDLE, PREFIX + '.shared']],
    ])('refuses profile entitlement mismatch %s (%j)', (key, value) => {
        const { profile, certificate } = fixture();
        (profile.Entitlements as Record<string, unknown>)[key] = value;
        expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
    });
    it.each([
        'aps-environment',
        'com.apple.security.application-groups',
        'com.apple.developer.icloud-container-identifiers',
        'com.apple.developer.associated-domains',
        'com.apple.developer.ubiquity-kvstore-identifier',
    ])('refuses extra capability %s', (key) => {
        const { profile, certificate } = fixture();
        (profile.Entitlements as Record<string, unknown>)[key] = ['not-approved'];
        expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
        expect(() => validateFinalEntitlements(profile.Entitlements, TEAM, PREFIX)).toThrow();
    });
    it('refuses expired/future profiles, absent devices and broad enterprise/device scope', () => {
        for (const mutate of [
            (p: ReturnType<typeof fixture>['profile']) => {
                p.ExpirationDate = '2026-10-04T00:00:00Z';
            },
            (p: ReturnType<typeof fixture>['profile']) => {
                p.CreationDate = '2026-10-05T00:00:00Z';
            },
            (p: ReturnType<typeof fixture>['profile']) => {
                p.ProvisionedDevices.pop();
            },
            (p: ReturnType<typeof fixture>['profile']) => {
                p.ProvisionedDevices.push('extra-device');
            },
            (p: ReturnType<typeof fixture>['profile']) => {
                p.ProvisionedDevices[1] = DEVICES[0];
            },
            (p: ReturnType<typeof fixture>['profile']) => {
                Object.assign(p, { ProvisionsAllDevices: true });
            },
            (p: ReturnType<typeof fixture>['profile']) => {
                p.Platform = ['iOS', 'macOS'];
            },
        ]) {
            const { profile, certificate } = fixture();
            mutate(profile);
            expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
        }
    });
    it('requires the exact included, live Apple Development certificate and matching team', () => {
        for (const mutate of [
            (c: ReturnType<typeof fixture>['certificate']) => {
                c.fingerprint = 'A'.repeat(40);
            },
            (c: ReturnType<typeof fixture>['certificate']) => {
                c.team = PREFIX;
            },
            (c: ReturnType<typeof fixture>['certificate']) => {
                c.commonName = 'Apple Distribution: Synthetic Fixture';
            },
            (c: ReturnType<typeof fixture>['certificate']) => {
                c.validTo = NOW;
            },
            (c: ReturnType<typeof fixture>['certificate']) => {
                c.validFrom = NOW + 1;
            },
        ]) {
            const { profile, certificate } = fixture();
            mutate(certificate);
            expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
        }
        const { profile, certificate } = fixture();
        profile.DeveloperCertificates.push(DER);
        expect(() => validateProfile(profile, certificate, [...DEVICES], NOW)).toThrow();
    });
    it('decodes only bounded typed plist data without duplicate/prototype keys or entities', () => {
        const value = decodePlist(
            xml(
                '<key>flag</key><true/><key>data</key><data>YQ==</data><key>list</key><array><integer>1</integer><string>a &amp; b</string></array>',
            ),
        );
        expect(value.flag).toBe(true);
        expect(value.data).toEqual(Buffer.from('a'));
        expect(value.list).toEqual([1, 'a & b']);
        for (const body of [
            '<key>a</key><true/><key>a</key><false/>',
            '<key>__proto__</key><dict/>',
            '<key>a</key><real>1.5</real>',
            '<key>a</key><true>false</true>',
            '<key>a</key><data>YQ=</data>',
            '<key>a</key><string><string>nested</string></string>',
            '<key>a</key>',
        ]) {
            expect(() => decodePlist(xml(body))).toThrow();
        }
        expect(() =>
            decodePlist('<!DOCTYPE plist [<!ENTITY x "secret">]>' + xml('<key>a</key><string>&x;</string>')),
        ).toThrow();
        expect(() => decodePlist('x'.repeat(2 * 1024 * 1024 + 1))).toThrow();
        expect(() =>
            decodePlist(xml('<key>a</key>' + '<array>'.repeat(34) + '<string>x</string>' + '</array>'.repeat(34))),
        ).toThrow();
    });
});
