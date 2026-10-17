import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    RELEASE_REPOSITORY,
    validateReleasedRefs,
    readReleasedSource,
    isolatedReleasedRefEnvironment,
} from './released-source.mjs';
const commit = 'a'.repeat(40);
const valid = {
    commit,
    appBuild: 141,
    origin: RELEASE_REPOSITORY,
    localMaster: commit,
    localBuild: commit,
    remote: `${commit}\trefs/heads/master\n${commit}\trefs/heads/b141\n`,
};
test('fixed-origin ref reader strips every inherited Git transport/config override, including TLS bypass', () => {
    const safe = isolatedReleasedRefEnvironment({
        PATH: 'synthetic-path',
        GIT_SSL_NO_VERIFY: '1',
        GIT_CONFIG_PARAMETERS: 'unreviewed',
        GIT_CONFIG_COUNT: '9',
        GIT_DIR: '/unrelated',
        GIT_EXEC_PATH: '/unrelated',
        git_ssl_no_verify: '1',
        GIT_PROXY_COMMAND: 'unreviewed',
    });
    assert.equal(safe.PATH, 'synthetic-path');
    assert.equal(safe.GIT_SSL_NO_VERIFY, undefined);
    assert.equal(safe.git_ssl_no_verify, undefined);
    assert.equal(safe.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(safe.GIT_DIR, undefined);
    assert.equal(safe.GIT_EXEC_PATH, undefined);
    assert.equal(safe.GIT_PROXY_COMMAND, undefined);
    assert.equal(safe.GIT_CONFIG_COUNT, '0');
    assert.equal(safe.GIT_CONFIG_GLOBAL, os.devNull);
    assert.equal(safe.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(safe.GIT_TERMINAL_PROMPT, '0');
});
test('release metadata must bind the exact master and actual matching build release branch', () => {
    assert.equal(validateReleasedRefs(valid).buildCommit, commit);
    assert.equal(validateReleasedRefs(valid).buildBranch, 'b141');
    for (const patch of [
        { origin: 'https://lookalike.invalid/thalassa.git' },
        { localMaster: 'b'.repeat(40) },
        { localBuild: 'b'.repeat(40) },
        { remote: `${commit}\trefs/heads/master` },
        { remote: valid.remote + valid.remote },
        { remote: valid.remote.replace('b141', 'b140') },
        { remote: valid.remote.replace('refs/heads/b141', 'refs/tags/b141') },
        { remote: valid.remote + `${commit}\trefs/tags/b141^{}\n` },
        { remote: valid.remote.replaceAll(commit, 'b'.repeat(40)) },
        { remote: valid.remote + ' '.repeat(65537) },
    ])
        assert.throws(() => validateReleasedRefs({ ...valid, ...patch }));
});
test('actual local pre-release checkout is refused before any fixed-origin network read or output creation', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-release-refusal-'));
    t.after(() => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
        assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        fs.rmSync(root, { recursive: true, force: true });
    });
    execFileSync('git', ['init', '--quiet', root]);
    fs.writeFileSync(path.join(root, 'candidate.txt'), 'Synthetic unreleased source\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', [
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=NUL',
        'commit',
        '--quiet',
        '-m',
        'Synthetic candidate',
    ]);
    const candidate = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.throws(() => readReleasedSource(root, candidate, 141), /clean exact released checkout/);
    assert.deepEqual(fs.readdirSync(root).sort(), ['.git', 'candidate.txt']);
});
