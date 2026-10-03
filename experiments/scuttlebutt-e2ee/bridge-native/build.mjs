/**
 * AUTH-only, separate Capacitor iOS compile. Never cap sync, sign, install,
 * launch, enroll a peer, acquire a human token or build the primary app.
 *
 * node build.mjs NATIVE_CACHE CAPACITOR_PRODUCTS_ROOT PUBLIC_DIST
 *   [--platform iphoneos|iphonesimulator] [--public-key-file ABS_JSON]
 *
 * PUBLIC_DIST is supplied by a separate research web build. The default public
 * anon lookup uses only the approved healthy pilot project/organization. An
 * optional pinned public-only config file avoids retrieving the CLI's full
 * API-key response. No key values or raw failures enter console/receipts.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
    chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
    readFileSync, readdirSync, realpathSync, rmdirSync, statfsSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = resolve(HERE, '..'), CHECKOUT = resolve(HERE, '../../..');
const PROJECT = 'kmtupdvwdgbhtssqqova', ORGANIZATION = 'tideqlkywysyczrqreiz';
const ORIGIN = 'https://' + PROJECT + '.supabase.co';
const CONVERSATION = 'thalassa-e2ee-pilot-auth-v1';
const BUNDLE = 'app.thalassa.research.scuttlebutt-auth';
const CLI = '/opt/homebrew/bin/supabase', RUBY = '/opt/homebrew/opt/ruby/bin/ruby';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const slot = join(tmpdir(), 'thalassa-isolated-heavy-slot-' + process.getuid());
let stage = 'arguments', scratch, receipt, receiptPath, slotNonce;
const saveReceipt = () => {
    if (receiptPath) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
};

function directory(path) {
    assert(isAbsolute(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory());
    return realpathSync(path);
}
function regular(path, limit = 512 * 1024 * 1024) {
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink() && stat.isFile() && stat.size <= limit);
}
function tree(root) {
    const files = [];
    function visit(path) {
        assert(!lstatSync(path).isSymbolicLink(), 'Snapshot links are refused');
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const next = join(path, entry.name);
            assert(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()));
            if (entry.isDirectory()) visit(next);
            else { regular(next); files.push(next); assert(files.length <= 20_000); }
        }
    }
    visit(root);
    return files.sort();
}
function snapshotTree(source, destination) {
    mkdirSync(destination, { mode: 0o700 });
    const inputs = tree(source), hashes = {};
    for (const input of inputs) {
        const name = relative(source, input), output = join(destination, name);
        hashes[name] = hash(input);
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        copyFileSync(input, output); chmodSync(output, lstatSync(input).mode & 0o700);
        assert(hash(output) === hashes[name] && hash(input) === hashes[name], 'Cache changed during snapshot');
    }
    return hashes;
}
function quiet(command, args, timeout = 30_000) {
    const result = spawnSync(command, args, {
        encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    if (command === '/usr/bin/xcodebuild' && scratch && receipt) {
        // Compiler-only diagnostics, never CLI credential/Auth response bodies.
        const diagnostics = (result.stdout + '\n' + result.stderr).split('\n')
            .filter((line) => result.status !== 0 || /(?:error|warning|fatal error):/.test(line))
            .slice(0, 250).map((line) => line.slice(0, 2048)
                .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
                .replace(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, '[redacted-key]'))
            .join('\n');
        const path = join(scratch, 'compiler-diagnostics.txt');
        writeFileSync(path, diagnostics + '\n', { mode: 0o600 });
        receipt.compilerDiagnostics = { path, sha256: hash(path), commandExitStatus: result.status };
        saveReceipt();
    }
    assert(!result.error && result.status === 0, 'Command refused at current stage');
    return result.stdout;
}
function cliJson(args) {
    // This transient response may contain other API-key entries. Only the anon
    // entry is selected; raw response/errors are never written or printed.
    return JSON.parse(quiet(CLI, args));
}
function validPublicKey(key) {
    assert(typeof key === 'string' && key.length > 0 && key.length <= 8192 &&
        /^[A-Za-z0-9._~+/-]+=*$/.exec(key)?.[0] === key);
    if (key.startsWith('sb_publishable_')) { assert(key.length > 15); return; }
    const parts = key.split('.');
    assert(parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.exec(part)?.[0] === part));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // Config validation only, never JWT account authentication.
    assert(claims.role === 'anon' && claims.ref === PROJECT);
}
function publicConfig(file) {
    if (file) {
        regular(file, 16 * 1024);
        const value = JSON.parse(readFileSync(file, 'utf8'));
        assert(Object.keys(value).sort().join(',') === 'organization,project,projectOrigin,publicApiKey');
        assert(value.project === PROJECT && value.organization === ORGANIZATION && value.projectOrigin === ORIGIN);
        validPublicKey(value.publicApiKey);
        return { key: value.publicApiKey, source: 'supplied-pinned-public-config', healthyProjectChecked: false };
    }
    const projects = cliJson(['projects', 'list', '--output', 'json']);
    assert(Array.isArray(projects));
    const selected = projects.find((item) => item.id === PROJECT);
    assert(selected?.organization_id === ORGANIZATION && selected?.name === 'Thalassa E2EE Pilot' &&
        selected?.status === 'ACTIVE_HEALTHY');
    const keys = cliJson(['projects', 'api-keys', '--project-ref', PROJECT, '--output', 'json']);
    assert(Array.isArray(keys));
    const key = keys.find((item) => item.name === 'anon')?.api_key;
    validPublicKey(key);
    return { key, source: 'guarded-cli-public-anon', healthyProjectChecked: true };
}

async function reserveBuildSlot() {
    process.title = 'scuttlebutt auth research waiting';
    let announced = false;
    for (;;) {
        try {
            mkdirSync(slot, { mode: 0o700 });
            slotNonce = randomUUID();
            writeFileSync(join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: slotNonce }), { mode: 0o600, flag: 'wx' });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const stat = lstatSync(slot);
            assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
            const ownerPath = join(slot, 'owner.json');
            if (existsSync(ownerPath)) {
                regular(ownerPath, 256);
                const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
                assert(Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.nonce === 'string');
                try { process.kill(owner.pid, 0); }
                catch (failure) {
                    if (failure?.code === 'ESRCH' && readdirSync(slot).length === 1) {
                        unlinkSync(ownerPath); rmdirSync(slot);
                    } else if (failure?.code !== 'EPERM') throw failure;
                }
            }
            if (!announced) console.info('Waiting for the shared build slot.');
            announced = true; await delay(5000); continue;
        }
        const check = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8', timeout: 10_000 });
        assert(!check.error && [0, 1].includes(check.status));
        const others = check.stdout.trim().split('\n').filter((line) =>
            /^\d+\s/.test(line) && !line.startsWith(process.pid + ' ') &&
            !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|tail|grep|rg|pgrep)\s/.test(line));
        if (!others.length) { process.title = 'vite build slot: isolated AUTH-only Capacitor compile'; return; }
        releaseBuildSlot();
        if (!announced) console.info('Waiting for the shared build slot.');
        announced = true; await delay(5000);
    }
}
function releaseBuildSlot() {
    if (!slotNonce) return;
    const path = join(slot, 'owner.json');
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    assert(owner.pid === process.pid && owner.nonce === slotNonce && readdirSync(slot).length === 1);
    unlinkSync(path); rmdirSync(slot); slotNonce = undefined;
}

try {
    assert(process.platform === 'darwin' && process.arch === 'arm64');
    const [cacheArg, productsArg, distArg, ...options] = process.argv.slice(2);
    assert(cacheArg && productsArg && distArg);
    let platform = 'iphoneos', keyFile;
    const seen = new Set();
    for (let index = 0; index < options.length; index += 2) {
        const flag = options[index], value = options[index + 1];
        assert(value && !seen.has(flag)); seen.add(flag);
        if (flag === '--platform') { assert(['iphoneos', 'iphonesimulator'].includes(value)); platform = value; }
        else if (flag === '--public-key-file') { assert(isAbsolute(value)); keyFile = value; }
        else assert(false, 'Unsupported isolated build argument');
    }
    const cache = directory(cacheArg), products = directory(productsArg), dist = directory(distArg);
    assert(dist !== join(CHECKOUT, 'dist') && !dist.startsWith(join(CHECKOUT, 'ios') + '/'));
    regular(join(dist, 'index.html'), 1024 * 1024);
    stage = 'cached inputs';
    const pin = JSON.parse(readFileSync(join(EXPERIMENT, 'vodozemac-native-pin.json'), 'utf8'));
    assert(pin.provider === 'vodozemac' && pin.protocol === 'olm-v1' && pin.shippingApproved === false);
    assert(hash(join(EXPERIMENT, 'vodozemac-native/Cargo.toml')) === pin.manifestSha256 &&
        hash(join(EXPERIMENT, 'vodozemac-native/Cargo.lock')) === pin.lockfileSha256);
    const priorNames = readdirSync(cache).filter((name) => /^run-[0-9a-f-]+\.json$/.test(name));
    const completed = priorNames.find((name) => {
        try {
            const path = join(cache, name); regular(path, 64 * 1024);
            const prior = JSON.parse(readFileSync(path, 'utf8'));
            return prior.status === 'passed' && prior.observation === 'cleanup-and-uninstall-complete' &&
                prior.completedPhases?.some((phase) => phase.phase === 'relay-replay');
        } catch { return false; }
    });
    assert(completed, 'A completed native relay proof cache is required');
    const bindingRoot = directory(join(cache, 'bindings')), bindingFiles = tree(bindingRoot);
    const swift = bindingFiles.filter((path) => path.endsWith('.swift'));
    const maps = bindingFiles.filter((path) => path.endsWith('.modulemap'));
    assert(swift.length === 1 && maps.length === 1 && bindingFiles.length <= 8);
    const provider = join(cache, 'target', platform === 'iphoneos' ? 'aarch64-apple-ios' : 'aarch64-apple-ios-sim',
        'debug/libthalassa_vodozemac_native.a');
    regular(provider);
    const sourcePaths = [
        ...['ResearchApp.swift', 'ScuttlebuttResearchAuthPlugin.swift', 'ResearchAuthHost.swift'].map((name) => join(HERE, name)),
        ...['VodozemacSealedStore.swift', 'VodozemacDmFrame.swift', 'VodozemacDmCoordinator.swift', 'VodozemacMessageOperations.swift',
            'VodozemacRelayCodec.swift', 'VodozemacRelayTransport.swift', 'VodozemacRelayResult.swift',
            'VodozemacScopedRelayClient.swift', 'VodozemacSupabaseAuth.swift',
            'VodozemacAuthSession.swift', 'VodozemacAccountDirectory.swift', 'VodozemacSessionFacade.swift'].map((name) => join(EXPERIMENT, name)),
    ];
    sourcePaths.forEach((path) => regular(path, 1024 * 1024));
    scratch = mkdtempSync(join(tmpdir(), 'thalassa-auth-only-build-')); chmodSync(scratch, 0o700);
    assert(!scratch.startsWith(CHECKOUT + '/') && statfsSync(scratch).bavail * statfsSync(scratch).bsize > 3 * 1024 ** 3);
    receiptPath = join(scratch, 'build-receipt.json');
    receipt = {
        status: 'preparing', authOnly: true, bundleId: BUNDLE, platform,
        project: PROJECT, organization: ORGANIZATION, sourceHashes: {}, copiedFrameworkHashes: {},
        cachedBindingHashes: {}, providerSha256: hash(provider),
        providerManifestSha256: pin.manifestSha256, providerLockfileSha256: pin.lockfileSha256,
        priorNativeResearchReceiptSha256: hash(join(cache, completed)),
        freshRustBuild: false, independentlyVerifiedCachedArtifactProvenance: false,
        providerProvenanceLimit: 'Locally cached bindings/archive and a completed fixture receipt; no signed provenance chain or fresh provider build.',
        signingPerformed: false, installed: false, launched: false, physicalDeviceExecution: false,
        compileOnly: true, unsignedApplication: null, primaryCapSyncExecuted: false, primaryTargetsBuilt: false,
        liveAuthExecuted: false, peerEnrollmentImplemented: false, privateMessagePortImplemented: false,
        applicationSignatureCheckedAbsent: false,
        cachedFrameworkSignatures: 'Any existing cached framework signatures are preserved; this runner performs no signing.',
        outputRoot: scratch,
    };
    saveReceipt(); console.info('Nonsecret AUTH-only build receipt: ' + receiptPath);
    stage = 'public pilot configuration';
    const config = publicConfig(keyFile);
    receipt.publicConfigurationSource = config.source;
    receipt.healthyPilotProjectChecked = config.healthyProjectChecked;
    const nativeConfig = { projectOrigin: ORIGIN, publicApiKey: config.key, conversationId: CONVERSATION };
    const projectRoot = join(scratch, 'Project'); mkdirSync(projectRoot, { mode: 0o700 });
    writeFileSync(join(projectRoot, 'research-config.json'), JSON.stringify(nativeConfig, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(projectRoot, 'capacitor.config.json'), JSON.stringify({
        appId: BUNDLE, appName: 'Scuttlebutt Auth Research', webDir: 'public', loggingBehavior: 'none',
        ios: { loggingBehavior: 'none', webContentsDebuggingEnabled: false },
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(projectRoot, 'config.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><widget version="0.1.0" xmlns="http://www.w3.org/ns/widgets"><preference name="DisableDeploy" value="true" /></widget>\n',
        { mode: 0o600, flag: 'wx' });
    stage = 'private input snapshots';
    // The native plugin is the only public-config gateway. A plain browser must
    // fail closed; do not put pilot keys/configuration in its static web assets.
    assert(!existsSync(join(dist, 'research-config.json')) && !existsSync(join(dist, 'capacitor.config.json')));
    receipt.publicDistInputHashes = snapshotTree(dist, join(projectRoot, 'public'));
    mkdirSync(join(projectRoot, 'Sources'), { mode: 0o700 });
    for (const source of sourcePaths) {
        const name = relative(dirname(source), source), output = join(projectRoot, 'Sources', name);
        receipt.sourceHashes[source] = hash(source); copyFileSync(source, output); chmodSync(output, 0o600);
        assert(hash(output) === receipt.sourceHashes[source]);
    }
    receipt.cachedBindingHashes = snapshotTree(bindingRoot, join(projectRoot, 'Bindings'));
    mkdirSync(join(projectRoot, 'Provider'), { mode: 0o700 });
    copyFileSync(provider, join(projectRoot, 'Provider/libthalassa_vodozemac_native.a'));
    assert(hash(join(projectRoot, 'Provider/libthalassa_vodozemac_native.a')) === receipt.providerSha256);
    mkdirSync(join(projectRoot, 'Frameworks'), { mode: 0o700 });
    const frameworkSources = {
        Capacitor: directory(join(products, 'Capacitor/Capacitor.framework')),
        Cordova: directory(join(products, 'CapacitorCordova/Cordova.framework')),
    };
    for (const [name, source] of Object.entries(frameworkSources)) {
        const supported = JSON.parse(quiet('/usr/bin/plutil', ['-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', join(source, 'Info.plist')]));
        assert(Array.isArray(supported) && supported.includes(platform === 'iphoneos' ? 'iPhoneOS' : 'iPhoneSimulator'));
        receipt.copiedFrameworkHashes[name] = snapshotTree(source, join(projectRoot, 'Frameworks', name + '.framework'));
    }
    const generator = join(HERE, 'generate_project.rb'); regular(generator, 64 * 1024);
    receipt.generatorSha256 = hash(generator);
    receipt.runnerSha256 = hash(fileURLToPath(import.meta.url));
    writeFileSync(join(projectRoot, 'generator-input.json'), JSON.stringify({
        projectRoot, bundleId: BUNDLE, platform, sources: sourcePaths.map((path) => relative(dirname(path), path)),
        bindingSwift: relative(bindingRoot, swift[0]), moduleMap: relative(bindingRoot, maps[0]),
    }) + '\n', { mode: 0o600, flag: 'wx' });
    stage = 'isolated project generation';
    quiet(RUBY, [generator, join(projectRoot, 'generator-input.json')]);
    receipt.projectPath = join(projectRoot, 'ScuttlebuttResearchAuth.xcodeproj');
    receipt.projectFileSha256 = hash(join(receipt.projectPath, 'project.pbxproj'));
    receipt.bundledConfigSha256 = hash(join(projectRoot, 'research-config.json'));
    saveReceipt();
    stage = 'shared build slot'; await reserveBuildSlot();
    stage = 'unsigned isolated compile'; receipt.status = 'building'; saveReceipt();
    const derivedData = join(scratch, 'DerivedData');
    quiet('/usr/bin/xcodebuild', [
        '-project', receipt.projectPath, '-scheme', 'ScuttlebuttResearchAuth', '-configuration', 'Debug',
        '-sdk', platform, '-destination', platform === 'iphoneos' ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
        '-derivedDataPath', derivedData, '-clonedSourcePackagesDirPath', join(scratch, 'Packages'),
        '-disableAutomaticPackageResolution', '-skipPackageUpdates', '-jobs', '1', '-quiet',
        'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGN_IDENTITY=', 'COMPILER_INDEX_STORE_ENABLE=NO', 'INDEX_ENABLE_DATA_STORE=NO',
        'CLANG_MODULE_CACHE_PATH=' + join(scratch, 'Modules'), 'MODULE_CACHE_DIR=' + join(scratch, 'Modules'),
        'SDK_STAT_CACHE_DIR=' + join(scratch, 'SDKStatCaches'), 'COMPILATION_CACHE_ENABLE_CACHING=NO', 'build',
    ], 300_000);
    stage = 'unsigned artifact verification';
    receipt.artifact = join(derivedData, 'Build/Products/Debug-' + platform + '/ScuttlebuttResearchAuth.app');
    const executable = join(receipt.artifact, 'ScuttlebuttResearchAuth'); regular(executable);
    const architecture = quiet('/usr/bin/xcrun', ['lipo', '-archs', executable]).trim(); assert(architecture === 'arm64');
    const binaryPlatform = quiet('/usr/bin/xcrun', ['vtool', '-show-build', executable]);
    assert((platform === 'iphoneos' ? /platform\s+IOS\s/ : /platform\s+IOSSIMULATOR\s/).test(binaryPlatform));
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', executable], { encoding: 'utf8', timeout: 30_000 });
    assert(!signature.error && signature.status !== 0 && /code object is not signed at all/.test(signature.stderr));
    receipt.applicationSignatureCheckedAbsent = true; receipt.unsignedApplication = true;
    receipt.executableSha256 = hash(executable);
    receipt.artifactHashes = Object.fromEntries(tree(receipt.artifact).map((path) => [relative(receipt.artifact, path), hash(path)]));
    for (const [path, expected] of Object.entries(receipt.sourceHashes)) assert(hash(path) === expected);
    for (const [name, expected] of Object.entries(receipt.cachedBindingHashes)) assert(hash(join(bindingRoot, name)) === expected);
    assert(hash(provider) === receipt.providerSha256);
    for (const [name, source] of Object.entries(frameworkSources)) {
        for (const [file, expected] of Object.entries(receipt.copiedFrameworkHashes[name])) assert(hash(join(source, file)) === expected);
    }
    receipt.status = 'passed'; saveReceipt();
    console.info('PASS isolated AUTH-only app compiled unsigned. No signing, installation, launch or live Auth run.');
} catch {
    if (receipt) { receipt.status = 'failed'; receipt.failedStage = stage; saveReceipt(); }
    console.error('AUTH-only build refused at stage: ' + stage + (receiptPath ? '. Receipt: ' + receiptPath : '.'));
    process.exitCode = 1;
} finally {
    try { releaseBuildSlot(); }
    catch { console.error('Unable to release the exact owned build slot.'); process.exitCode = 1; }
}
