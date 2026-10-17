import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RELEASE_REPOSITORY = 'https://github.com/shanestratton/thalassa-marine-weather.git';
export function isolatedReleasedRefEnvironment(environment = process.env) {
    return {
        ...Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name))),
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
    };
}
const commitId = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
/** Pure metadata validation; this alone is not a release-authority receipt. */
export function validateReleasedRefs({ commit, appBuild, origin, localMaster, localBuild, remote }) {
    if (
        !commitId(commit) ||
        !Number.isSafeInteger(appBuild) ||
        appBuild < 1 ||
        appBuild > 9999 ||
        origin !== RELEASE_REPOSITORY ||
        localMaster !== commit ||
        localBuild !== commit ||
        typeof remote !== 'string' ||
        Buffer.byteLength(remote) > 65536
    )
        throw Error('Exact released master and build branch were not proven');
    const buildBranch = `refs/heads/b${appBuild}`;
    const refs = new Map();
    for (const line of remote.trim().split(/\r?\n/)) {
        const match = /^([a-f0-9]{40})\t(\S+)$/.exec(line);
        if (!match || !['refs/heads/master', buildBranch].includes(match[2]) || refs.has(match[2]))
            throw Error('Released ref reply is invalid');
        refs.set(match[2], match[1]);
    }
    if (refs.get('refs/heads/master') !== commit || refs.get(buildBranch) !== commit)
        throw Error('Exact released master and build branch were not proven');
    return { origin: RELEASE_REPOSITORY, master: commit, buildBranch: `b${appBuild}`, buildCommit: commit };
}
/** Actual fixed-origin read, after local pre-release refusals and before any staging output.
 * A caller-supplied JSON flag/hash cannot bypass this read. Release owner still verifies TestFlight. */
export function readReleasedSource(repository, commit, appBuild) {
    const git = (args, options = {}) =>
        execFileSync('git', ['-C', repository, ...args], {
            encoding: 'utf8',
            maxBuffer: 65536,
            timeout: 20000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
            stdio: ['ignore', 'pipe', 'pipe'],
            ...options,
        }).trim();
    if (!commitId(commit) || !Number.isSafeInteger(appBuild) || appBuild < 1 || appBuild > 9999)
        throw Error('An exact released source commit and build are required');
    let localMaster, localBuild, origin;
    try {
        if (git(['rev-parse', 'HEAD^{commit}']) !== commit || git(['status', '--porcelain']))
            throw Error('Working tree differs');
        localMaster = git(['rev-parse', 'refs/remotes/origin/master^{commit}']);
        localBuild = git(['rev-parse', `refs/remotes/origin/b${appBuild}^{commit}`]);
        origin = git(['remote', 'get-url', 'origin']);
    } catch {
        throw Error('A clean exact released checkout with master and build branch is required');
    }
    if (origin !== RELEASE_REPOSITORY || localMaster !== commit || localBuild !== commit)
        throw Error('Exact released master and build branch were not proven');
    let remote;
    // Public ref read ignores repository/global URL rewrites and credential helpers.
    // It does not fetch objects or persist authentication/source data.
    const remoteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-released-ref-'));
    try {
        const remoteEnvironment = isolatedReleasedRefEnvironment();
        remote = execFileSync(
            'git',
            [
                '-c',
                'credential.helper=',
                '-c',
                'http.followRedirects=false',
                '-c',
                'http.sslVerify=true',
                'ls-remote',
                '--exit-code',
                RELEASE_REPOSITORY,
                'refs/heads/master',
                `refs/heads/b${appBuild}`,
            ],
            {
                cwd: remoteDirectory,
                env: remoteEnvironment,
                encoding: 'utf8',
                timeout: 20000,
                maxBuffer: 65536,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        ).trim();
    } catch {
        throw Error('Released GitHub refs are unavailable; no bundle was staged');
    } finally {
        // This directory is created here and never receives provider/runtime files.
        fs.rmdirSync(remoteDirectory);
    }
    return {
        ...validateReleasedRefs({ commit, appBuild, origin, localMaster, localBuild, remote }),
        observedAt: Date.now(),
    };
}
