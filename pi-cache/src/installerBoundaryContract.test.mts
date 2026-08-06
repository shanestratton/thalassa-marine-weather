import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines?: { node?: string };
};
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
    packages?: Record<string, { engines?: { node?: string } }>;
};
const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');

test('Pi package metadata declares Undici 7 runtime floor', () => {
    assert.equal(packageJson.engines?.node, '>=20.18.1');
    assert.equal(packageLock.packages?.['']?.engines?.node, '>=20.18.1');
});

test('installer upgrades or rejects an old Node before npm and service restart', () => {
    assert.match(installer, /MIN_NODE_VERSION="20\.18\.1"/);
    assert.match(installer, /node_meets_minimum\(\)/);
    assert.match(installer, /Installing\/upgrading Node\.js/);
    assert.match(installer, /Aborting before dependency installation or service restart/);

    const runtimeCheck = installer.indexOf('if [[ -z "$NODE_BIN" ]] || ! node_meets_minimum "$NODE_BIN"');
    const dependencyInstall = installer.indexOf('npm ci --prefix');
    assert.ok(runtimeCheck > 0 && runtimeCheck < dependencyInstall, 'runtime check must precede npm ci');

    assert.match(installer, /NODE_BIN=\$\(readlink -f/);
    assert.match(installer, /ExecStart=\$\{NODE_BIN\} dist\/server\.js/);
    assert.doesNotMatch(installer, /ExecStart=\/usr\/bin\/node/);
});
