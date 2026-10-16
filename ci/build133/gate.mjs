import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TARGET = Object.freeze({
    repo: 'shanestratton/thalassa-marine-weather',
    source: '7ceb502424825ff7f06f970d8734e4c69595a8e3',
    sourceBranch: 'codex/build-133-integration',
    originalB132: 'a9372b33c967d79d8676e9bb3564b68c794cc33b',
    originalB133: '771716bf91078e86d5a90aedc91f961c89cce1f8',
    master: '5b3187afc146f618126ca0658e0aa142aff40196',
    validationRun: Number('38828754980'),
    validationDefinition: '21f77e4cca7f2a37b408dd9404e2ef5deb603a61',
    validationPath: '.github/workflows/validate-testflight-133.yml',
    validationBranch: 'codex/build-133-full-validation',
});

export const requiredSteps = Object.freeze({
    'full (unit-coverage)': ['Verify exact source and all four build numbers', 'All unit tests with coverage', 'Record successful full suite'],
    'full (two-browser-e2e)': ['Verify exact source and all four build numbers', 'Build production app for both browser engines', 'All Chromium and mobile Safari E2E tests', 'Record successful full suite'],
    'full (keyboard-1)': ['Verify exact source and all four build numbers', 'Complete keyboard, daylight and split-pane shard', 'Record successful full suite'],
    'full (keyboard-2)': ['Verify exact source and all four build numbers', 'Complete keyboard, daylight and split-pane shard', 'Record successful full suite'],
    'full (keyboard-3)': ['Verify exact source and all four build numbers', 'Complete keyboard, daylight and split-pane shard', 'Record successful full suite'],
    'full (keyboard-pixel)': ['Verify exact source and all four build numbers', 'Wind pixel checks, one worker', 'Record successful full suite'],
    'full (plan-your-day)': ['Verify exact source and all four build numbers', 'Complete Plan Your Day fit suite', 'Record successful full suite'],
    'quick release gates': ['Verify exact application commit and preserved release ancestors', 'Ephemeral PostgreSQL underway privacy, capability and RLS replay', 'Preserve ephemeral PostgreSQL replay evidence', 'Dependency audits and both release gates', 'Lint, migration, route, formatting, mirror and type checks', 'Edge formatting, types and all behavior tests', 'Guard tests', 'Update 5 staged-source and anchor-lease guard tests', 'Production build, hidden-map cleanup and artifact checks', 'Lighthouse budgets', 'Assert Lighthouse audited the real application shell'],
    'package (ais-ingest)': ['Verify exact application commit and preserved release ancestors', 'Install, audit and validate independent dependency tree', 'Build and test package'],
    'package (deepgram-proxy)': ['Verify exact application commit and preserved release ancestors', 'Install, audit and validate independent dependency tree', 'Type-check Deepgram proxy'],
    'package (pi-cache)': ['Verify exact application commit and preserved release ancestors', 'Install, audit and validate independent dependency tree', 'Build and test package', 'Stage frozen Pi update 5 and verify its read-only install plan', 'Preserve staged Pi update 5 source and checksum inventory'],
});

export function validateEvidence(run, listing, refs) {
    if (run.id !== TARGET.validationRun || run.head_sha !== TARGET.validationDefinition ||
        run.path !== TARGET.validationPath || run.head_branch !== TARGET.validationBranch || run.event !== 'push' || run.run_attempt !== 1 ||
        run.actor?.login !== 'shanestratton' || run.head_repository?.full_name !== TARGET.repo)
        throw new Error('Unexpected validation identity, source definition, actor or run attempt');
    if (refs.candidate !== TARGET.source || refs.b132 !== TARGET.originalB132 || refs.master !== TARGET.master || refs.b133 !== TARGET.originalB133)
        throw new Error('A release source branch changed; refresh and revalidate, never ship a stale candidate');
    if (!Array.isArray(listing.jobs) || listing.total_count !== listing.jobs.length)
        throw new Error('Incomplete job evidence');
    const expected = Object.keys(requiredSteps);
    const names = listing.jobs.map(job => job.name);
    if (listing.jobs.some(job => job.run_id !== TARGET.validationRun || job.head_sha !== TARGET.validationDefinition || job.head_branch !== TARGET.validationBranch))
        throw new Error('A validation job belongs to a different run, definition or branch');
    if (new Set(names).size !== names.length || names.some(name => !expected.includes(name)))
        throw new Error('Duplicate or unexpected validation jobs');
    if (listing.jobs.some(job => job.status === 'completed' && job.conclusion !== 'success'))
        throw new Error('A release validation job failed, was skipped or was cancelled; upload is blocked');
    if (run.status !== 'completed') {
        if (!['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(run.status))
            throw new Error('Unexpected validation status');
        return 'pending';
    }
    if (run.conclusion !== 'success' || names.length !== expected.length)
        throw new Error('Full validation did not pass all eleven jobs');
    for (const job of listing.jobs) {
        if (job.status !== 'completed' || job.conclusion !== 'success') throw new Error(`Job not passed: ${job.name}`);
        for (const name of requiredSteps[job.name]) {
            const steps = (job.steps ?? []).filter(step => step.name === name);
            if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success')
                throw new Error(`Required release check did not actually pass: ${job.name} / ${name}`);
        }
    }
    return 'passed';
}

export async function inspect(fetcher, token) {
    async function get(endpoint) {
        const response = await fetcher(`https://api.github.com/repos/${TARGET.repo}/${endpoint}`, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
            headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        });
        if (!response.ok) throw new Error(`GitHub validation read failed: HTTP ${response.status}`);
        return response.json();
    }
    const [run, listing, candidate, b132, master, b133] = await Promise.all([
        get(`actions/runs/${TARGET.validationRun}`), get(`actions/runs/${TARGET.validationRun}/jobs?filter=latest&per_page=100`),
        get(`git/ref/heads/${TARGET.sourceBranch}`), get('git/ref/heads/b132'), get('git/ref/heads/master'), get('git/ref/heads/b133'),
    ]);
    return validateEvidence(run, listing, {candidate: candidate.object?.sha, b132: b132.object?.sha, master: master.object?.sha, b133: b133.object?.sha});
}

async function main() {
    const token = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    if (!token) throw new Error('GitHub read token is missing');
    const wait = process.argv.includes('--wait');
    const deadline = Date.now() + (wait ? 155 * 60_000 : 0);
    for (;;) {
        const state = await inspect(fetch, token);
        if (state === 'passed') {
            const message = `All eleven release jobs and their required steps passed for ${TARGET.source}, build 133; source refs remain unchanged.`;
            console.log(message);
            if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
            return;
        }
        if (!wait || Date.now() >= deadline) throw new Error('Full validation is not finished; signing/upload is blocked');
        console.log('Waiting for the exact build-133 validation; no Apple signing or upload has started.');
        await new Promise(done => setTimeout(done, 30_000));
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
    main().catch(error => {console.error(error.message); process.exitCode = 1;});
