/**
 * OFFLINE, separate research app signing only. Inspection is the default.
 * node signDevice.mjs --receipt ABS --identity SHA1 --profile ABS
 *   --device 00008130-000964E80AF8001C --device 00008030-001C692E0A60202E [--sign]
 *
 * No build, auto-provisioning, installation, launch, device lookup or server call.
 * --sign changes only a newly created private copy, never the unsigned input.
 * This is local integrity/profile validation, not a physical-device acceptance
 * test, fresh online revocation check, or independent provider/security audit.
 */
import { createHash, X509Certificate } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom'); // Existing read-only dependency; no installation.
export const BUNDLE = 'app.thalassa.research.scuttlebutt-auth';
export const DEVICES = Object.freeze(['00008130-000964E80AF8001C', '00008030-001C692E0A60202E']);
const CHECKOUT = '/Users/shanestratton/.codex/worktrees/scuttlebutt-e2ee/thalassa-marine-weather';
const HERE = join(CHECKOUT, 'experiments/scuttlebutt-e2ee/bridge-native');
const EXPERIMENT = dirname(HERE);
const PROJECT = 'kmtupdvwdgbhtssqqova',
    ORGANIZATION = 'tideqlkywysyczrqreiz';
const BUILD_HASH = 'da321dde51ec3623b807750bd20e66f88d3f22e3d0376385ecb6183ead32decd';
const GENERATOR_HASH = '37365d3bbc72aa5c520d8980e38967ce4facd4fb66f3e6eb8af746bb7309b35b';
const MANIFEST_HASH = '8cef57a4b945989302db94361bb03df46157e9c305862232dd9d59379ed610d9';
const LOCKFILE_HASH = '5788c45d3bd629c4640f88c5b533484c89d39029674a02bce0301597e6fe50f7';
const NATIVE_SOURCES = [
    ...[
        'ResearchApp.swift',
        'ScuttlebuttResearchAuthPlugin.swift',
        'ResearchAuthHost.swift',
        'ResearchMessagingAdapter.swift',
    ].map((name) => join(HERE, name)),
    ...[
        'VodozemacSealedStore.swift',
        'VodozemacDmFrame.swift',
        'VodozemacDmCoordinator.swift',
        'VodozemacMessageOperations.swift',
        'VodozemacRelayCodec.swift',
        'VodozemacRelayTransport.swift',
        'VodozemacRelayResult.swift',
        'VodozemacRelayPolicy.swift',
        'VodozemacScopedRelayClient.swift',
        'VodozemacSupabaseAuth.swift',
        'VodozemacAuthSession.swift',
        'VodozemacAccountDirectory.swift',
        'VodozemacSessionFacade.swift',
    ].map((name) => join(EXPERIMENT, name)),
];
const LIBRARIES = ['ScuttlebuttResearchAuth.debug.dylib', '__preview.dylib'];
const FRAMEWORKS = ['Capacitor', 'Cordova'];
const ENTITLEMENT_KEYS = [
    'application-identifier',
    'com.apple.developer.team-identifier',
    'get-task-allow',
    'keychain-access-groups',
];
const NETWORK_DENIAL = '(version 1)(allow default)(deny network*)';
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const ensure = (condition, name) => {
    if (!condition) throw new Error(name);
};
const exactKeys = (value, expected, name) =>
    ensure(
        value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).sort().join('\n') === [...expected].sort().join('\n'),
        name,
    );

export function parseArguments(args) {
    const parsed = { sign: false, devices: [] },
        seen = new Set();
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (flag === '--sign') {
            ensure(!seen.has(flag), 'duplicate-flag');
            parsed.sign = true;
            seen.add(flag);
            continue;
        }
        ensure(['--receipt', '--identity', '--profile', '--device'].includes(flag), 'unknown-flag');
        const value = args[++index];
        ensure(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'missing-value');
        if (flag === '--device') {
            parsed.devices.push(value);
            ensure(parsed.devices.length <= 2, 'device-count');
        } else {
            ensure(!seen.has(flag), 'duplicate-flag');
            seen.add(flag);
            parsed[flag.slice(2)] = value;
        }
    }
    ensure(isAbsolute(parsed.receipt ?? '') && isAbsolute(parsed.profile ?? ''), 'absolute-inputs');
    ensure(/^[a-fA-F0-9]{40}$/.test(parsed.identity ?? ''), 'identity-sha1');
    ensure(
        parsed.devices.length === 2 && [...parsed.devices].sort().join(',') === [...DEVICES].sort().join(','),
        'pinned-devices',
    );
    parsed.identity = parsed.identity.toUpperCase();
    return parsed;
}

// Bounded plist decoding, with no parser diagnostics, entity expansion, duplicate
// keys or prototype keys. XML data remains private memory, never a command log.
export function decodePlist(xml) {
    ensure(
        typeof xml === 'string' && Buffer.byteLength(xml) <= 2 * 1024 * 1024 && !/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml),
        'plist-size-or-entity',
    );
    let parserFailure = false,
        nodes = 0;
    const doc = new DOMParser({
        errorHandler: {
            warning: () => {
                parserFailure = true;
            },
            error: () => {
                parserFailure = true;
            },
            fatalError: () => {
                parserFailure = true;
            },
        },
    }).parseFromString(xml, 'application/xml');
    ensure(!parserFailure && doc.documentElement?.tagName === 'plist', 'plist-document');
    ensure(
        doc.documentElement.attributes.length === 1 && doc.documentElement.getAttribute('version') === '1.0',
        'plist-version',
    );
    for (let child = doc.firstChild; child; child = child.nextSibling) {
        ensure(
            child === doc.documentElement ||
                [7, 8, 10].includes(child.nodeType) ||
                (child.nodeType === 3 && !child.data.trim()),
            'plist-document-child',
        );
    }
    const elements = (node) => {
        const children = [];
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1) children.push(child);
            else
                ensure(
                    child.nodeType === 8 || ((child.nodeType === 3 || child.nodeType === 4) && !child.data.trim()),
                    'plist-child',
                );
        }
        return children;
    };
    const scalar = (node) => {
        for (let child = node.firstChild; child; child = child.nextSibling) {
            ensure([3, 4, 8].includes(child.nodeType), 'plist-scalar');
        }
        return node.textContent;
    };
    function read(node, depth) {
        ensure(++nodes <= 8192 && depth <= 32 && node.attributes.length === 0, 'plist-bound');
        const tag = node.tagName;
        if (tag === 'dict') {
            const out = Object.create(null),
                children = elements(node);
            ensure(children.length % 2 === 0, 'plist-dict');
            for (let index = 0; index < children.length; index += 2) {
                const keyNode = children[index];
                ensure(keyNode.tagName === 'key' && keyNode.attributes.length === 0, 'plist-key');
                const key = scalar(keyNode);
                ensure(
                    key.length > 0 &&
                        key.length <= 256 &&
                        !['__proto__', 'constructor', 'prototype'].includes(key) &&
                        !Object.hasOwn(out, key),
                    'plist-key-duplicate',
                );
                out[key] = read(children[index + 1], depth + 1);
            }
            return out;
        }
        if (tag === 'array') return elements(node).map((child) => read(child, depth + 1));
        const value = scalar(node);
        if (tag === 'string') return value;
        if (tag === 'true' || tag === 'false') {
            ensure(!value.trim(), 'plist-boolean');
            return tag === 'true';
        }
        if (tag === 'integer') {
            ensure(/^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)), 'plist-integer');
            return Number(value);
        }
        if (tag === 'date') {
            ensure(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
                    Number.isFinite(Date.parse(value)) &&
                    new Date(value).toISOString() === value.replace('Z', '.000Z'),
                'plist-date',
            );
            return value;
        }
        if (tag === 'data') {
            const text = value.replace(/\s/g, '');
            ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text), 'plist-data');
            const data = Buffer.from(text, 'base64');
            ensure(data.length <= 1024 * 1024 && data.toString('base64') === text, 'plist-data');
            return data;
        }
        throw new Error('plist-tag');
    }
    const roots = elements(doc.documentElement);
    ensure(roots.length === 1 && roots[0].tagName === 'dict', 'plist-root');
    return read(roots[0], 0);
}

export function researchEntitlements(team, prefix) {
    ensure(/^[A-Z0-9]{10}$/.test(team) && /^[A-Z0-9]{10}$/.test(prefix), 'team-prefix');
    return {
        'application-identifier': prefix + '.' + BUNDLE,
        'com.apple.developer.team-identifier': team,
        'get-task-allow': true,
        'keychain-access-groups': [prefix + '.' + BUNDLE],
    };
}
export function validateFinalEntitlements(value, team, prefix) {
    exactKeys(value, ENTITLEMENT_KEYS, 'final-capabilities');
    ensure(
        JSON.stringify(Object.entries(value).sort()) ===
            JSON.stringify(Object.entries(researchEntitlements(team, prefix)).sort()),
        'final-research-scope',
    );
}
export function appleSignatureRequirement(team, identifier = null) {
    ensure(
        /^[A-Z0-9]{10}$/.test(team) &&
            (identifier === null || (typeof identifier === 'string' && /^[A-Za-z0-9.-]+$/.test(identifier))),
        'code-identifier',
    );
    // codesign treats unprefixed text as a file name, not requirement source.
    return (
        '=anchor apple generic and certificate leaf[subject.OU] = "' +
        team +
        '"' +
        (identifier === null ? '' : ' and identifier "' + identifier + '"')
    );
}
export function validateProfile(profile, certificate, selectedDevices, now) {
    ensure(Number.isFinite(now), 'clock');
    ensure(
        Array.isArray(profile.TeamIdentifier) &&
            profile.TeamIdentifier.length === 1 &&
            Array.isArray(profile.ApplicationIdentifierPrefix) &&
            profile.ApplicationIdentifierPrefix.length === 1,
        'profile-team-prefix',
    );
    const team = profile.TeamIdentifier[0],
        prefix = profile.ApplicationIdentifierPrefix[0],
        final = researchEntitlements(team, prefix);
    const entitlements = profile.Entitlements;
    exactKeys(entitlements, ENTITLEMENT_KEYS, 'profile-capabilities');
    ensure(
        entitlements['application-identifier'] === final['application-identifier'] &&
            entitlements['com.apple.developer.team-identifier'] === team &&
            entitlements['get-task-allow'] === true,
        'profile-app-development',
    );
    const groups = entitlements['keychain-access-groups'];
    ensure(
        Array.isArray(groups) && groups.length === 1 && [prefix + '.' + BUNDLE, prefix + '.*'].includes(groups[0]),
        'profile-keychain-scope',
    );
    ensure(
        profile.ProvisionsAllDevices === undefined || profile.ProvisionsAllDevices === false,
        'profile-not-enterprise',
    );
    ensure(
        Array.isArray(profile.Platform) && profile.Platform.length === 1 && profile.Platform[0] === 'iOS',
        'profile-platform',
    );
    ensure(
        Array.isArray(selectedDevices) &&
            selectedDevices.length === 2 &&
            [...selectedDevices].sort().join(',') === [...DEVICES].sort().join(','),
        'pinned-devices',
    );
    ensure(
        Array.isArray(profile.ProvisionedDevices) &&
            profile.ProvisionedDevices.length === 2 &&
            [...profile.ProvisionedDevices].sort().join(',') === [...DEVICES].sort().join(','),
        'profile-device-scope',
    );
    const created = Date.parse(profile.CreationDate),
        expires = Date.parse(profile.ExpirationDate);
    ensure(
        Number.isFinite(created) && Number.isFinite(expires) && created <= now && now < expires,
        'profile-expired-or-future',
    );
    ensure(
        typeof profile.UUID === 'string' &&
            /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(profile.UUID) &&
            profile.Version === 1,
        'profile-version',
    );
    ensure(
        certificate &&
            /^Apple Development: [^\r\n]+$/.test(certificate.commonName) &&
            certificate.team === team &&
            /^[A-F0-9]{40}$/.test(certificate.fingerprint) &&
            Number.isFinite(certificate.validFrom) &&
            Number.isFinite(certificate.validTo) &&
            certificate.validFrom <= now &&
            now < certificate.validTo,
        'development-certificate',
    );
    ensure(
        Array.isArray(profile.DeveloperCertificates) &&
            profile.DeveloperCertificates.length > 0 &&
            profile.DeveloperCertificates.length <= 32 &&
            profile.DeveloperCertificates.every(
                (entry) => Buffer.isBuffer(entry) && entry.length > 0 && entry.length <= 64 * 1024,
            ) &&
            profile.DeveloperCertificates.filter(
                (entry) => sha(entry, 'sha1').toUpperCase() === certificate.fingerprint,
            ).length === 1,
        'profile-certificate-membership',
    );
    return { team, prefix, expires, final };
}

function regular(path, limit = 512 * 1024 * 1024) {
    ensure(isAbsolute(path), 'file-absolute');
    const stat = lstatSync(path);
    ensure(!stat.isSymbolicLink() && stat.isFile() && stat.size <= limit && stat.nlink === 1, 'regular-file');
    return stat;
}
function hashFile(path, limit) {
    regular(path, limit);
    return sha(readFileSync(path));
}
function directory(path) {
    const stat = lstatSync(path);
    ensure(isAbsolute(path) && !stat.isSymbolicLink() && stat.isDirectory(), 'directory');
    return realpathSync(path);
}
function tree(root) {
    const files = [];
    function visit(path) {
        directory(path);
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const next = join(path, entry.name);
            ensure(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()), 'tree-links');
            if (entry.isDirectory()) visit(next);
            else {
                regular(next);
                files.push(next);
                ensure(files.length <= 20_000, 'tree-bound');
            }
        }
    }
    visit(root);
    return files.sort();
}
function verifyMap(root, expected) {
    ensure(expected && typeof expected === 'object' && !Array.isArray(expected), 'hash-map');
    const actual = tree(root).map((path) => relative(root, path));
    ensure(actual.join('\n') === Object.keys(expected).sort().join('\n'), 'tree-file-set');
    for (const name of actual)
        ensure(/^[a-f0-9]{64}$/.test(expected[name]) && hashFile(join(root, name)) === expected[name], 'tree-hash');
}
function freezeInputs(args) {
    const receiptHash = hashFile(args.receipt, 1024 * 1024),
        profileHash = hashFile(args.profile, 2 * 1024 * 1024);
    const value = JSON.parse(readFileSync(args.receipt, 'utf8'));
    ensure(
        value.status === 'passed' &&
            value.bundleId === BUNDLE &&
            value.platform === 'iphoneos' &&
            value.project === PROJECT &&
            value.organization === ORGANIZATION &&
            value.compileOnly === true &&
            value.unsignedApplication === true &&
            value.applicationSignatureCheckedAbsent === true &&
            value.signingPerformed === false &&
            value.installed === false &&
            value.launched === false &&
            value.physicalDeviceExecution === false &&
            value.primaryCapSyncExecuted === false &&
            value.primaryTargetsBuilt === false,
        'unsigned-research-receipt',
    );
    const output = directory(value.outputRoot),
        stat = lstatSync(output);
    ensure(
        output === realpathSync(dirname(args.receipt)) &&
            basename(args.receipt) === 'build-receipt.json' &&
            /^thalassa-messaging-build-[A-Za-z0-9]+$/.test(basename(output)) &&
            dirname(output) === realpathSync(tmpdir()) &&
            stat.uid === process.getuid() &&
            (stat.mode & 0o777) === 0o700,
        'private-build-root',
    );
    const artifact = directory(value.artifact),
        project = join(output, 'Project');
    ensure(
        artifact === join(output, 'DerivedData/Build/Products/Debug-iphoneos/ScuttlebuttResearchAuth.app') &&
            realpathSync(value.projectPath) === join(project, 'ScuttlebuttResearchAuth.xcodeproj'),
        'separate-artifact',
    );
    exactKeys(value.sourceHashes, NATIVE_SOURCES, 'native-source-set');
    for (const source of NATIVE_SOURCES) {
        ensure(
            hashFile(source, 1024 * 1024) === value.sourceHashes[source] &&
                hashFile(join(project, 'Sources', basename(source)), 1024 * 1024) === value.sourceHashes[source],
            'current-source-hash',
        );
    }
    ensure(
        value.runnerSha256 === BUILD_HASH &&
            hashFile(join(HERE, 'build.mjs')) === BUILD_HASH &&
            value.generatorSha256 === GENERATOR_HASH &&
            hashFile(join(HERE, 'generate_project.rb')) === GENERATOR_HASH,
        'trusted-build-tools',
    );
    ensure(
        hashFile(join(project, 'ScuttlebuttResearchAuth.xcodeproj/project.pbxproj')) === value.projectFileSha256 &&
            hashFile(join(project, 'research-config.json')) === value.bundledConfigSha256 &&
            hashFile(join(artifact, 'research-config.json')) === value.bundledConfigSha256 &&
            hashFile(join(project, 'Provider/libthalassa_vodozemac_native.a')) === value.providerSha256 &&
            value.providerManifestSha256 === MANIFEST_HASH &&
            value.providerLockfileSha256 === LOCKFILE_HASH &&
            hashFile(join(EXPERIMENT, 'vodozemac-native/Cargo.toml')) === MANIFEST_HASH &&
            hashFile(join(EXPERIMENT, 'vodozemac-native/Cargo.lock')) === LOCKFILE_HASH,
        'build-input-hashes',
    );
    verifyMap(join(project, 'Bindings'), value.cachedBindingHashes);
    verifyMap(join(project, 'public'), value.publicDistInputHashes);
    exactKeys(value.copiedFrameworkHashes, FRAMEWORKS, 'framework-set');
    for (const name of FRAMEWORKS)
        verifyMap(join(project, 'Frameworks', name + '.framework'), value.copiedFrameworkHashes[name]);
    verifyMap(artifact, value.artifactHashes);
    ensure(hashFile(join(artifact, 'ScuttlebuttResearchAuth')) === value.executableSha256, 'executable-hash');
    ensure(
        readdirSync(join(artifact, 'Frameworks')).sort().join(',') ===
            FRAMEWORKS.map((name) => name + '.framework')
                .sort()
                .join(','),
        'embedded-framework-set',
    );
    ensure(
        tree(artifact)
            .filter((path) => path.endsWith('.dylib'))
            .map((path) => relative(artifact, path))
            .sort()
            .join(',') === [...LIBRARIES].sort().join(','),
        'embedded-dylib-set',
    );
    ensure(
        !tree(artifact).some((path) =>
            /(?:^|\/)(?:PlugIns|Watch|_CodeSignature)(?:\/|$)|\.mobileprovision$/.test(relative(artifact, path)),
        ),
        'no-extra-code-or-profile',
    );
    if (value.compilerDiagnostics) {
        ensure(
            realpathSync(value.compilerDiagnostics.path) === join(output, 'compiler-diagnostics.txt') &&
                hashFile(value.compilerDiagnostics.path) === value.compilerDiagnostics.sha256 &&
                value.compilerDiagnostics.commandExitStatus === 0,
            'compile-diagnostic-hash',
        );
    }
    return { receiptHash, profileHash, value, artifact, output };
}
function copyArtifact(input, destination, expected) {
    mkdirSync(destination, { mode: 0o700 });
    for (const path of tree(input)) {
        const name = relative(input, path),
            target = join(destination, name);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(path, target);
        chmodSync(target, lstatSync(path).mode & 0o700);
        ensure(hashFile(target) === expected[name] && hashFile(path) === expected[name], 'copy-hash');
    }
    verifyMap(destination, expected);
}
function entitlementXml(entitlements) {
    return (
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
        '<key>application-identifier</key><string>' +
        entitlements['application-identifier'] +
        '</string>' +
        '<key>com.apple.developer.team-identifier</key><string>' +
        entitlements['com.apple.developer.team-identifier'] +
        '</string>' +
        '<key>get-task-allow</key><true/><key>keychain-access-groups</key><array><string>' +
        entitlements['keychain-access-groups'][0] +
        '</string></array></dict></plist>\n'
    );
}

export function main(argv = process.argv.slice(2)) {
    let stage = 'arguments',
        scratch,
        receiptPath,
        receipt;
    const steps = [];
    function save() {
        if (!scratch) return;
        const log = join(scratch, 'signing-stages.json');
        writeFileSync(log, JSON.stringify(steps.slice(0, 64)) + '\n', { mode: 0o600 });
        chmodSync(log, 0o600);
        receipt.stageLogSha256 = hashFile(log);
        writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
        chmodSync(receiptPath, 0o600);
    }
    function quiet(label, command, args, { allowFailure = false, timeout = 30_000 } = {}) {
        const result = spawnSync('/usr/bin/sandbox-exec', ['-p', NETWORK_DENIAL, command, ...args], {
            encoding: 'utf8',
            timeout,
            maxBuffer: 2 * 1024 * 1024,
            env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: process.env.HOME,
                TMPDIR: process.env.TMPDIR,
                LANG: 'C',
            },
        });
        steps.push({
            operation: label,
            status: Number.isInteger(result.status) ? result.status : null,
            timedOut: result.error?.code === 'ETIMEDOUT',
        });
        ensure(!result.error && (result.status === 0 || allowFailure), 'local-command-refused');
        return result;
    }
    try {
        const args = parseArguments(argv);
        ensure(
            process.platform === 'darwin' &&
                process.arch === 'arm64' &&
                realpathSync(dirname(fileURLToPath(import.meta.url))) === HERE &&
                realpathSync(process.cwd()) === CHECKOUT,
            'pinned-worktree',
        );
        stage = 'frozen unsigned inputs';
        const frozen = freezeInputs(args),
            selfHash = hashFile(fileURLToPath(import.meta.url));
        stage = 'unsigned code';
        for (const path of [
            frozen.artifact,
            ...LIBRARIES.map((name) => join(frozen.artifact, name)),
            ...FRAMEWORKS.map((name) => join(frozen.artifact, 'Frameworks', name + '.framework')),
        ]) {
            const result = quiet('unsigned-code-check', '/usr/bin/codesign', ['--display', '--verbose=2', path], {
                allowFailure: true,
            });
            ensure(
                result.status !== 0 && /code object is not signed at all/.test(result.stderr),
                'already-signed-input',
            );
        }
        const info = decodePlist(
            quiet('app-metadata', '/usr/bin/plutil', [
                '-convert',
                'xml1',
                '-o',
                '-',
                join(frozen.artifact, 'Info.plist'),
            ]).stdout,
        );
        ensure(
            info.CFBundleIdentifier === BUNDLE &&
                info.CFBundleExecutable === 'ScuttlebuttResearchAuth' &&
                info.MinimumOSVersion === '17.0' &&
                JSON.stringify(info.UIDeviceFamily) === '[1,2]' &&
                JSON.stringify(info.CFBundleSupportedPlatforms) === '["iPhoneOS"]',
            'research-app-metadata',
        );
        stage = 'development profile and identity';
        const profile = decodePlist(
            quiet('profile-decode', '/usr/bin/security', ['cms', '-D', '-i', args.profile]).stdout,
        );
        const matches = profile.DeveloperCertificates?.filter(
            (entry) => Buffer.isBuffer(entry) && sha(entry, 'sha1').toUpperCase() === args.identity,
        );
        ensure(matches?.length === 1, 'profile-certificate-membership');
        const certificate = new X509Certificate(matches[0]),
            subject = certificate.toLegacyObject().subject;
        const facts = {
            fingerprint: certificate.fingerprint.replaceAll(':', '').toUpperCase(),
            commonName: subject.CN,
            team: subject.OU,
            validFrom: Date.parse(certificate.validFrom),
            validTo: Date.parse(certificate.validTo),
        };
        const validated = validateProfile(profile, facts, args.devices, Date.now());
        const identities = quiet('local-development-identity', '/usr/bin/security', [
            'find-identity',
            '-p',
            'codesigning',
        ]).stdout;
        // find-identity can repeat the same identity in its matching/valid
        // sections. Require every matching row to name the selected certificate,
        // not exactly one textual occurrence. No identity subject is recorded.
        const identityPattern = new RegExp(
            '^\\s*\\d+\\) ' + args.identity + ' "(Apple Development: [^"\\r\\n]+)"(?:\\s.*)?$',
        );
        const identityNames = identities
            .split('\n')
            .map((line) => identityPattern.exec(line)?.[1])
            .filter(Boolean);
        ensure(
            identityNames.length > 0 && identityNames.every((name) => name === facts.commonName),
            'local-private-key-identity',
        );
        // Inspection changes no supplied input and performs no signing. Its only
        // outputs are fresh private diagnostic/receipt/certificate files.
        scratch = mkdtempSync(join(tmpdir(), 'thalassa-research-sign-'));
        chmodSync(scratch, 0o700);
        receiptPath = join(scratch, 'signing-receipt.json');
        receipt = {
            status: 'inspecting',
            bundleId: BUNDLE,
            project: PROJECT,
            organization: ORGANIZATION,
            operation: args.sign ? 'sign-private-copy' : 'inspect',
            suppliedBuildReceiptSha256: frozen.receiptHash,
            unsignedArtifact: frozen.artifact,
            unsignedArtifactHashes: frozen.value.artifactHashes,
            sourceHashes: frozen.value.sourceHashes,
            signingRunnerSha256: selfHash,
            profileSha256: frozen.profileHash,
            identitySha1: args.identity,
            certificateSha256: sha(matches[0]),
            team: validated.team,
            applicationIdentifierPrefix: validated.prefix,
            profileExpiresAt: new Date(validated.expires).toISOString(),
            selectedDeviceSha256: args.devices.map((device) => sha(device)).sort(),
            directChildNetworkingDenied: true,
            certificateVerification: 'local-only cached revocation; no fresh online revocation claim',
            signingPerformed: false,
            signingStarted: false,
            installed: false,
            launched: false,
            physicalDeviceExecution: false,
            primaryAppChanged: false,
            unsignedInputsChanged: false,
            safety: 'Research-only new private copy. No build, provisioning, install, launch, device operation, server write or store reset.',
            provenanceLimit: frozen.value.providerProvenanceLimit,
        };
        save();
        const certificateFile = join(scratch, 'selected-certificate.der');
        writeFileSync(certificateFile, matches[0], { mode: 0o600, flag: 'wx' });
        quiet('offline-certificate-trust', '/usr/bin/security', [
            'verify-cert',
            '-c',
            certificateFile,
            '-p',
            'codeSign',
            '-L',
            '-R',
            'offline',
            '-q',
        ]);
        stage = 'unchanged input confirmation';
        const confirm = () => {
            const current = freezeInputs(args);
            ensure(
                current.receiptHash === frozen.receiptHash &&
                    current.profileHash === frozen.profileHash &&
                    hashFile(fileURLToPath(import.meta.url)) === selfHash,
                'inputs-changed',
            );
            validateProfile(profile, facts, args.devices, Date.now());
        };
        confirm();
        if (!args.sign) {
            receipt.status = 'inspection-passed';
            receipt.profileAndIdentityChecked = true;
            save();
            console.info(
                'PASS offline signing inspection only; no app signed/copied/installed/launched. Private receipt: ' +
                    receiptPath,
            );
            return receiptPath;
        }
        stage = 'private app snapshot';
        const app = join(scratch, 'ScuttlebuttResearchAuth.app');
        copyArtifact(frozen.artifact, app, frozen.value.artifactHashes);
        copyFileSync(args.profile, join(app, 'embedded.mobileprovision'));
        chmodSync(join(app, 'embedded.mobileprovision'), 0o600);
        ensure(hashFile(join(app, 'embedded.mobileprovision')) === frozen.profileHash, 'embedded-profile-hash');
        const entitlements = join(scratch, 'research-entitlements.plist');
        writeFileSync(entitlements, entitlementXml(validated.final), { mode: 0o600, flag: 'wx' });
        validateFinalEntitlements(decodePlist(readFileSync(entitlements, 'utf8')), validated.team, validated.prefix);
        confirm();
        receipt.signedArtifact = app;
        receipt.signingStarted = true;
        // A failed/partial codesign attempt must not claim no signing occurred.
        receipt.signingPerformed = null;
        save();
        stage = 'inside-out private signing';
        const nested = [
            ...LIBRARIES.map((name) => join(app, name)),
            ...FRAMEWORKS.map((name) => join(app, 'Frameworks', name + '.framework')),
        ];
        for (const path of nested)
            quiet(
                'sign-nested-code',
                '/usr/bin/codesign',
                ['--force', '--sign', args.identity, '--timestamp=none', path],
                { timeout: 60_000 },
            );
        quiet(
            'sign-research-app',
            '/usr/bin/codesign',
            [
                '--force',
                '--sign',
                args.identity,
                '--timestamp=none',
                '--generate-entitlement-der',
                '--entitlements',
                entitlements,
                app,
            ],
            { timeout: 60_000 },
        );
        stage = 'strict signed artifact verification';
        for (const [index, path] of [...nested, app].entries()) {
            const identifier =
                path === app
                    ? BUNDLE
                    : path.endsWith('.framework')
                      ? decodePlist(
                            quiet('framework-metadata', '/usr/bin/plutil', [
                                '-convert',
                                'xml1',
                                '-o',
                                '-',
                                join(path, 'Info.plist'),
                            ]).stdout,
                        ).CFBundleIdentifier
                      : null;
            const requirement = appleSignatureRequirement(validated.team, identifier);
            quiet('strict-apple-code-signature', '/usr/bin/codesign', [
                '--verify',
                '--strict=all',
                '--deep',
                '--test-requirement',
                requirement,
                path,
            ]);
            const prefix = join(scratch, 'signed-certificate-' + index + '-');
            quiet('signature-certificate-extract', '/usr/bin/codesign', [
                '--display',
                '--extract-certificates',
                prefix,
                path,
            ]);
            for (const name of readdirSync(scratch).filter((name) => name.startsWith(basename(prefix)))) {
                regular(join(scratch, name), 64 * 1024);
                chmodSync(join(scratch, name), 0o600);
            }
            ensure(sha(readFileSync(prefix + '0'), 'sha1').toUpperCase() === args.identity, 'signed-leaf-identity');
            const xml = quiet('signed-entitlement-check', '/usr/bin/codesign', [
                '--display',
                '--entitlements',
                '-',
                '--xml',
                path,
            ]).stdout.trim();
            if (path === app) validateFinalEntitlements(decodePlist(xml), validated.team, validated.prefix);
            else ensure(!xml || Object.keys(decodePlist(xml)).length === 0, 'nested-capabilities');
        }
        ensure(hashFile(join(app, 'embedded.mobileprovision')) === frozen.profileHash, 'signed-profile-unchanged');
        for (const path of tree(app)) {
            const name = relative(app, path);
            const changedBySigning =
                name === 'ScuttlebuttResearchAuth' ||
                LIBRARIES.includes(name) ||
                FRAMEWORKS.some((framework) => name === 'Frameworks/' + framework + '.framework/' + framework) ||
                /(?:^|\/)\_CodeSignature\//.test(name) ||
                name === 'embedded.mobileprovision';
            ensure(
                changedBySigning || hashFile(path) === frozen.value.artifactHashes[name],
                'signed-resource-unchanged',
            );
        }
        ensure(
            Object.keys(frozen.value.artifactHashes).every((name) =>
                tree(app).some((path) => relative(app, path) === name),
            ),
            'signed-original-file-set',
        );
        stage = 'final unchanged input confirmation';
        confirm();
        receipt.status = 'signed-and-locally-verified';
        receipt.signingPerformed = true;
        receipt.strictSignatureVerified = true;
        receipt.finalEntitlements = validated.final;
        receipt.signedArtifactHashes = Object.fromEntries(
            tree(app).map((path) => [relative(app, path), hashFile(path)]),
        );
        receipt.finalSignedAt = new Date().toISOString();
        save();
        console.info(
            'PASS separate research app signed and locally verified only. No install, launch or physical exchange. Private receipt: ' +
                receiptPath,
        );
        return receiptPath;
    } catch {
        // Even a receipt-write failure must not fall through to Node's raw
        // exception rendering (CMS/X509/native failure details stay private).
        if (receipt) {
            receipt.status = 'refused';
            receipt.failedStage = stage;
            try {
                save();
            } catch {
                /* Fixed refusal below; no raw errors. */
            }
        }
        console.error(
            'Offline research signing refused at stage: ' +
                stage +
                (receiptPath ? '. Private receipt: ' + receiptPath : '.'),
        );
        process.exitCode = 1;
        return undefined;
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
