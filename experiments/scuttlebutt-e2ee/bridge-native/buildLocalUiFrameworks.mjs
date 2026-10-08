/** Fresh cached-source simulator frameworks; no Pods/SPM/network or shared writes.
 * All products/sources/modules stay in a newly owned private scratch directory.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const here = dirname(fileURLToPath(import.meta.url)),
    checkout = resolve(here, '../../..');
assert(checkout.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
assert(process.platform === 'darwin' && process.arch === 'arm64' && process.argv.length === 2);
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const source = realpathSync(join(checkout, 'node_modules/@capacitor/ios'));
const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
assert(pkg.name === '@capacitor/ios' && pkg.version === '8.5.2');
function tree(root) {
    const out = [];
    function visit(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            assert(!entry.isSymbolicLink());
            if (entry.isDirectory()) visit(p);
            else {
                assert(entry.isFile());
                out.push(p);
                assert(out.length <= 1000);
            }
        }
    }
    visit(root);
    return out.sort();
}
const inputs = Object.fromEntries(tree(source).map((p) => [relative(source, p), hash(p)]));
const inventory = Object.entries(inputs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, h]) => p + '\0' + h + '\n')
    .join('');
const inventoryHash = createHash('sha256').update(inventory).digest('hex');
assert(
    Object.keys(inputs).length === 106 &&
        inventoryHash === '857c1beede78d3d6d3fe2e7ee7423ecf0a0cc7e95a86575bfc1d9d9e23bbae4b',
);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'thalassa-local-ui-frameworks-')));
chmodSync(scratch, 0o700);
const receiptPath = join(scratch, 'frameworks-receipt.json');
const receipt = {
    version: 1,
    status: 'preparing',
    platform: 'iphonesimulator',
    packageName: pkg.name,
    packageVersion: pkg.version,
    sourceInventorySha256: inventoryHash,
    sourceHashes: inputs,
    sourceRoot: join(scratch, 'source'),
    outputRoot: scratch,
    generatorSha256: hash(join(here, 'generate_local_ui_frameworks.rb')),
    runnerSha256: hash(fileURLToPath(import.meta.url)),
    noNetworkOrPackageResolution: true,
    sharedDependenciesWritten: false,
    independentProvenanceAttested: false,
};
const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
save();
console.info('Nonsecret local UI frameworks receipt: ' + receiptPath);
function command(bin, args, timeout = 30000) {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
        writeFileSync(join(scratch, 'failed-command.log'), r.stdout + '\n' + r.stderr, { mode: 0o600 });
    }
    assert(!r.error && r.status === 0, 'Owned framework step refused');
    return r.stdout.trim();
}
try {
    mkdirSync(receipt.sourceRoot, { mode: 0o700 });
    for (const [name, h] of Object.entries(inputs)) {
        const src = join(source, name),
            dst = join(receipt.sourceRoot, name);
        assert(hash(src) === h);
        mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
        copyFileSync(src, dst);
        chmodSync(dst, 0o600);
        assert(hash(dst) === h && hash(src) === h);
    }
    const manifest = join(scratch, 'generator-input.json');
    writeFileSync(manifest, JSON.stringify({ root: scratch, sourceRoot: receipt.sourceRoot }), {
        mode: 0o600,
        flag: 'wx',
    });
    command('/opt/homebrew/opt/ruby/bin/ruby', [join(here, 'generate_local_ui_frameworks.rb'), manifest]);
    receipt.projectPath = join(scratch, 'Frameworks.xcodeproj');
    receipt.projectSha256 = hash(join(receipt.projectPath, 'project.pbxproj'));
    process.title = 'thalassa local UI frameworks awaiting shared-Mac slot';
    const deadline = Date.now() + 600000;
    for (;;) {
        const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8', timeout: 10000 });
        assert(!p.error && [0, 1].includes(p.status));
        const others = p.stdout
            .trim()
            .split('\n')
            .filter(
                (s) =>
                    s &&
                    !s.startsWith(process.pid + ' ') &&
                    !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|env|xargs)\s/.test(s),
            );
        if (!others.length) break;
        assert(Date.now() < deadline, 'Shared build slot deadline');
        await delay(5000);
    }
    process.title = 'vite build slot: owned simulator frameworks';
    receipt.status = 'building';
    save();
    receipt.toolchain = command('/usr/bin/xcodebuild', ['-version']);
    const args = [
        '-project',
        receipt.projectPath,
        '-scheme',
        'Capacitor',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        join(scratch, 'DerivedData'),
        '-disableAutomaticPackageResolution',
        '-skipPackageUpdates',
        '-jobs',
        '1',
        '-quiet',
        'ARCHS=arm64',
        'ONLY_ACTIVE_ARCH=YES',
        'SUPPORTED_PLATFORMS=iphonesimulator',
        'CODE_SIGNING_ALLOWED=NO',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGN_IDENTITY=',
        'AD_HOC_CODE_SIGNING_ALLOWED=NO',
        'COMPILER_INDEX_STORE_ENABLE=NO',
        'INDEX_ENABLE_DATA_STORE=NO',
        'CLANG_MODULE_CACHE_PATH=' + join(scratch, 'Modules'),
        'MODULE_CACHE_DIR=' + join(scratch, 'Modules'),
        'SDK_STAT_CACHE_DIR=' + join(scratch, 'SDKStatCaches'),
        'COMPILATION_CACHE_ENABLE_CACHING=NO',
        'build',
    ];
    receipt.buildArgs = args;
    save();
    const result = spawnSync('/usr/bin/xcodebuild', args, {
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 8 * 1024 * 1024,
    });
    const log = join(scratch, 'compiler.log');
    writeFileSync(log, result.stdout + '\n' + result.stderr, { mode: 0o600 });
    receipt.compilerLog = { path: log, sha256: hash(log), exitCode: result.status };
    save();
    assert(!result.error && result.status === 0, 'Owned framework compiler refused');
    receipt.products = join(scratch, 'DerivedData/Build/Products/Debug-iphonesimulator');
    receipt.frameworkHashes = {};
    for (const name of ['Capacitor', 'Cordova']) {
        const dir = join(receipt.products, name + '.framework'),
            exe = join(dir, name);
        assert(command('/usr/bin/xcrun', ['lipo', '-archs', exe]) === 'arm64');
        assert(command('/usr/bin/xcrun', ['vtool', '-show-build', exe]).includes('platform IOSSIMULATOR'));
        const platforms = JSON.parse(
            command('/usr/bin/plutil', [
                '-extract',
                'CFBundleSupportedPlatforms',
                'json',
                '-o',
                '-',
                join(dir, 'Info.plist'),
            ]),
        );
        assert(platforms.includes('iPhoneSimulator'));
        const signed = spawnSync('/usr/bin/codesign', ['-dv', exe], { encoding: 'utf8', timeout: 30000 });
        assert(signed.status !== 0, 'Simulator frameworks must remain unsigned');
        receipt.frameworkHashes[name] = Object.fromEntries(tree(dir).map((p) => [relative(dir, p), hash(p)]));
    }
    assert(receipt.frameworkHashes.Capacitor['native-bridge.js']);
    for (const [p, h] of Object.entries(inputs))
        assert(hash(join(receipt.sourceRoot, p)) === h && hash(join(source, p)) === h);
    receipt.status = 'passed';
    receipt.unsigned = true;
    receipt.completedAtUTC = new Date().toISOString();
    save();
    console.info('PASS owned source-complete unsigned simulator frameworks. No independent provenance attestation.');
} catch {
    receipt.status = 'failed';
    save();
    console.error('FAIL owned simulator frameworks; retained private receipt/compiler diagnostics.');
    process.exitCode = 1;
}
