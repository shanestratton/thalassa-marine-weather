// @vitest-environment node
/**
 * The Pi runs copies of three things it does not own (build 126, package
 * 126-05; the third from Pi update 3, 127-C-d):
 *   - the inshore routing engine (services/inshoreRouterEngine.ts and the ~36
 *     modules it imports), mirrored to pi-cache/src/routerEngine by
 *     pi-cache/scripts/sync-router-engine.mjs;
 *   - the collision rule (utils/collisionRule.ts), mirrored to
 *     pi-cache/src/collisionRule by pi-cache/scripts/sync-collision-rule.mjs;
 *   - the o-charts SENC parser the chart vault opens cells with
 *     (tools/senc-extractor/src, 11 modules), mirrored to
 *     pi-cache/src/sencEngine by pi-cache/scripts/sync-senc-engine.mjs.
 *
 * Each script has a --check that fails when its copy has drifted. The router's
 * ran nowhere: CI's pi-cache lane has no root prettier, and no test called it.
 * So the Pi's router lagged the phone's by a whole engine (125-05/06) with
 * nothing going red. These run both checks, prove the router check actually
 * catches a one-character engine edit (on a scratch copy, never the repo), and
 * pin the CI step that runs them on every push.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();
const ROUTER_SCRIPT = 'pi-cache/scripts/sync-router-engine.mjs';
const RULE_SCRIPT = 'pi-cache/scripts/sync-collision-rule.mjs';
const SENC_SCRIPT = 'pi-cache/scripts/sync-senc-engine.mjs';
const SENC_UPSTREAM = 'tools/senc-extractor/src';
const ENGINE_ENTRY = 'services/inshoreRouterEngine.ts';
// Prettier formats the mirror (and its --check output) across ~36 files.
const CHECK_TIMEOUT_MS = 120_000;
// A 'dir' symlink needs Developer Mode or admin on Windows; a junction needs neither (and rmSync removes only the link).
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

function check(cwd: string, script: string) {
    const result = spawnSync(process.execPath, [script, '--check'], {
        cwd,
        encoding: 'utf8',
        timeout: CHECK_TIMEOUT_MS,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Every file under dir, repo-style relative paths. */
function filesUnder(dir: string): string[] {
    return fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
        .sort();
}

/**
 * A scratch repo holding just what the router check reads: the script, the
 * Pi package's manifest (its TypeScript resolves through it), the mirror, the
 * app sources the mirror was copied from, the prettier config, and the repo's
 * node_modules (prettier, typescript) by symlink.
 */
function scratchRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-pi-mirror-'));
    const copy = (rel: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    };
    copy(ROUTER_SCRIPT);
    copy('pi-cache/package.json');
    copy('.prettierrc');
    copy('.prettierignore');
    for (const rel of filesUnder(path.join(REPO, 'pi-cache/src/routerEngine'))) {
        copy(`pi-cache/src/routerEngine/${rel}`);
        // The mirror keeps each module at its app path; the stamp has no app source.
        if (rel !== 'syncedFrom.ts') copy(rel);
    }
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), DIR_LINK);
    return root;
}

/** A scratch repo for the senc check: the script, the extractor's modules, the mirror, prettier. */
function sencScratchRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-senc-mirror-'));
    const copy = (rel: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    };
    copy(SENC_SCRIPT);
    copy('.prettierrc');
    copy('.prettierignore');
    for (const rel of filesUnder(path.join(REPO, 'pi-cache/src/sencEngine'))) {
        copy(`pi-cache/src/sencEngine/${rel}`);
        if (rel !== 'syncedFrom.ts') copy(`${SENC_UPSTREAM}/${rel}`);
    }
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), DIR_LINK);
    return root;
}

describe("the Pi's copies of the phone's code are in sync", () => {
    it(
        'the router engine copy matches the phone engine (sync-router-engine --check)',
        () => {
            const { status, output } = check(REPO, ROUTER_SCRIPT);
            expect(status, output).toBe(0);
            // This reference tag may describe the source's generation checkpoint.
            // Actual copied bytes and SHA256 digests are enforced by --check.
            expect(output).toMatch(/in sync \(\d+ modules, copied from [0-9a-f]{8}(?:[0-9a-f]{32})?(?:-dirty)?\)/);
        },
        CHECK_TIMEOUT_MS,
    );

    it('the collision rule copy matches the phone rule (sync-collision-rule --check)', () => {
        const { status, output } = check(REPO, RULE_SCRIPT);
        expect(status, output).toBe(0);
        // Provenance metadata does not replace the script's byte and SHA256 checks.
        expect(output).toMatch(/in sync \(sha256 [0-9a-f]{12}, copied from [0-9a-f]{8}(?:[0-9a-f]{32})?(?:-dirty)?\)/);
    });

    it(
        'the chart vault’s parser copy matches the extractor (sync-senc-engine --check)',
        () => {
            const { status, output } = check(REPO, SENC_SCRIPT);
            expect(status, output).toBe(0);
            expect(output).toMatch(/in sync \(11 modules, copied from [0-9a-f]{8}(?:[0-9a-f]{32})?(?:-dirty)?\)/);
        },
        CHECK_TIMEOUT_MS,
    );

    it(
        'a one-character edit to the upstream featureParser makes the senc check fail',
        () => {
            const root = sencScratchRepo();
            try {
                const clean = check(root, SENC_SCRIPT);
                expect(clean.status, clean.output).toBe(0);
                const parser = path.join(root, SENC_UPSTREAM, 'featureParser.ts');
                const source = fs.readFileSync(parser, 'utf8');
                const at = source.indexOf('e');
                fs.writeFileSync(parser, `${source.slice(0, at)}E${source.slice(at + 1)}`);
                const drifted = check(root, SENC_SCRIPT);
                expect(drifted.status).toBe(1);
                expect(drifted.output).toContain('differs: featureParser.ts');
                expect(drifted.output).toContain('stale digest: syncedFrom.ts');
                expect(drifted.output).toContain('Run: node pi-cache/scripts/sync-senc-engine.mjs');
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
        CHECK_TIMEOUT_MS * 2,
    );

    it(
        'a one-character edit to the phone engine makes the router check fail',
        () => {
            const root = scratchRepo();
            try {
                // The scratch copy is faithful: unedited, it passes like the repo.
                const clean = check(root, ROUTER_SCRIPT);
                expect(clean.status, clean.output).toBe(0);

                const entry = path.join(root, ENGINE_ENTRY);
                const source = fs.readFileSync(entry, 'utf8');
                const at = source.indexOf('e');
                expect(at).toBeGreaterThan(-1);
                fs.writeFileSync(entry, `${source.slice(0, at)}E${source.slice(at + 1)}`);

                const drifted = check(root, ROUTER_SCRIPT);
                expect(drifted.status).toBe(1);
                expect(drifted.output).toContain('has drifted');
                expect(drifted.output).toContain('stale digest: syncedFrom.ts');
                expect(drifted.output).toContain('Run: node pi-cache/scripts/sync-router-engine.mjs');
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
        CHECK_TIMEOUT_MS * 2,
    );
});

describe('CI runs all three checks on every push', () => {
    const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
    // The root `check` job: the only one with the root prettier the router check needs
    // (and, since the 2026-10 split, the only job in ci.yml).
    const checkJob = ci.slice(ci.indexOf('\n    check:\n'));

    it('in the root check job, after the root install', () => {
        expect(checkJob.length).toBeGreaterThan(0);
        const install = checkJob.indexOf('run: npm ci');
        const router = checkJob.indexOf(`run: node ${ROUTER_SCRIPT} --check`);
        const rule = checkJob.indexOf(`run: node ${RULE_SCRIPT} --check`);
        const senc = checkJob.indexOf(`run: node ${SENC_SCRIPT} --check`);
        expect(install).toBeGreaterThan(-1);
        expect(senc, 'the senc engine mirror check is a step of the check job').toBeGreaterThan(install);
        expect(router, 'the router mirror check is a step of the check job').toBeGreaterThan(install);
        expect(rule, 'the collision rule mirror check is a step of the check job').toBeGreaterThan(install);
    });
});
