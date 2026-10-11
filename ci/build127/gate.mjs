import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TARGET = Object.freeze({
    repo: 'shanestratton/thalassa-marine-weather',
    source: '31f97f1f369981be3917b2a8450006ba272b7650',
    sourceBranch: 'codex/testflight-127',
    originalB127: '6c60882fd39a87a6c00e1a327455903182293baa',
    master: 'b8ef21d96a699a240b0378db7d7fcdc0e93810cd',
    validationRun: 38130827961,
    validationDefinition: 'b6a35c6eda0331f0a00647b9b8662d4e5b9f5be4',
    validationPath: '.github/workflows/validate-testflight-127.yml',
});

export const requiredSteps = Object.freeze({
    'full (unit-coverage)': ['Verify exact source and all four build numbers', 'All unit tests with coverage', 'Record successful full suite'],
    'full (two-browser-e2e)': ['Verify exact source and all four build numbers', 'Build production app for both browser engines', 'All Chromium and mobile Safari E2E tests', 'Record successful full suite'],
    'full (keyboard-1)': ['Verify exact source and all four build numbers', 'Complete keyboard, daylight and split-pane shard', 'Record successful full suite'],
    'full (keyboard-2)': ['Verify exact source and all four build numbers', 'Complete keyboard, daylight and split-pane shard', 'Record successful full suite'],
    'full (keyboard-3)': ['Verify exact source and all four build numbers', 'Complete keyboard, daylight and split-pane shard', 'Record successful full suite'],
    'full (plan-your-day)': ['Verify exact source and all four build numbers', 'Complete Plan Your Day fit suite', 'Record successful full suite'],
    'quick release gates': ['Dependency audits and both release gates', 'Lint, migration, route, formatting, mirror and type checks', 'Edge formatting, types and all behavior tests', 'Guard tests', 'Production build, hidden-map cleanup and artifact checks', 'Lighthouse budgets', 'Assert Lighthouse audited the real application shell'],
    'package (ais-ingest)': ['Install, audit and validate independent dependency tree', 'Build and test package'],
    'package (deepgram-proxy)': ['Install, audit and validate independent dependency tree', 'Type-check Deepgram proxy'],
    'package (pi-cache)': ['Install, audit and validate independent dependency tree', 'Build and test package'],
});

export function validateEvidence(run, listing, refs) {
    if (run.id !== TARGET.validationRun || run.head_sha !== TARGET.validationDefinition ||
        run.path !== TARGET.validationPath || run.event !== 'push' || run.run_attempt !== 1 ||
        run.actor?.login !== 'shanestratton' || run.head_repository?.full_name !== TARGET.repo)
        throw new Error('Unexpected validation identity, source definition, actor or run attempt');
    if (refs.candidate !== TARGET.source || refs.b127 !== TARGET.originalB127 || refs.master !== TARGET.master)
        throw new Error('A release source branch changed; refresh and revalidate, never ship a stale candidate');
    if (!Array.isArray(listing.jobs) || listing.total_count !== listing.jobs.length)
        throw new Error('Incomplete job evidence');
    const expected = Object.keys(requiredSteps);
    const names = listing.jobs.map(job => job.name);
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
        throw new Error('Full validation did not pass all ten jobs');
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
    const [run, listing, candidate, b127, master] = await Promise.all([
        get(`actions/runs/${TARGET.validationRun}`), get(`actions/runs/${TARGET.validationRun}/jobs?filter=latest&per_page=100`),
        get(`git/ref/heads/${TARGET.sourceBranch}`), get('git/ref/heads/b127'), get('git/ref/heads/master'),
    ]);
    return validateEvidence(run, listing, {candidate: candidate.object?.sha, b127: b127.object?.sha, master: master.object?.sha});
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
            const message = `All ten release jobs and their required steps passed for ${TARGET.source}, build 127; source refs remain unchanged.`;
            console.log(message);
            if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
            return;
        }
        if (!wait || Date.now() >= deadline) throw new Error('Full validation is not finished; signing/upload is blocked');
        console.log('Waiting for the exact build-127 validation; no Apple signing or upload has started.');
        await new Promise(done => setTimeout(done, 30_000));
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
    main().catch(error => {console.error(error.message); process.exitCode = 1;});
