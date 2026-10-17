// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const yaml = createRequire(import.meta.url)('yaml');
afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

it('ordinary full browser checks explicitly execute both inert proof configs against that job’s actual dist', () => {
    const workflow = yaml.parse(fs.readFileSync('.github/workflows/full-checks.yml', 'utf8'));
    const steps = workflow.jobs.e2e.steps;
    const build = steps.findIndex((step: { name?: string }) => step.name === 'Build');
    const mini = steps.findIndex(
        (step: { name?: string }) => step.name === 'Complete packed-data synthetic entry proofs in both engines',
    );
    const actual = steps.findIndex(
        (step: { name?: string }) => step.name === 'Complete packed-data actual release entry proofs in both engines',
    );
    expect(build).toBeGreaterThan(0);
    expect(mini).toBeGreaterThan(build);
    expect(actual).toBeGreaterThan(mini);
    expect(steps[mini].run).toBe('npx playwright test --config playwright.inert-ui-data139.config.ts');
    expect(steps[actual].run).toBe(
        'ACTUAL_INERT_DIST="$PWD/dist" npx playwright test --config playwright.inert-ui-artifact139.config.ts',
    );
    expect(steps[actual].env).toEqual({ INERT_UI_RELEASE_ARTIFACT: '1' });
    for (const step of [steps[mini], steps[actual]]) {
        expect(step.if).toBeUndefined();
        expect(step['continue-on-error']).toBeUndefined();
    }
});

it('CI proof configs use installed Chromium/WebKit, refuse test.only and retain their own failure outputs', async () => {
    vi.stubEnv('CI', 'true');
    const configs = [
        (await import('../playwright.inert-ui-data139.config')).default,
        (await import('../playwright.inert-ui-artifact139.config')).default,
    ];
    expect(configs.map((config) => config.testMatch)).toEqual([
        'inert-ui-data139.spec.ts',
        'inert-ui-artifact139.spec.ts',
    ]);
    for (const config of configs) {
        expect(config.forbidOnly).toBe(true);
        expect(config.workers).toBe(1);
        expect(config.retries).toBe(0);
        expect(config.outputDir).toMatch(/^test-results\/inert-ui139-/);
        expect(config.projects?.map((project) => project.name)).toEqual(['chromium', 'webkit']);
        expect(config.projects?.[0].use?.channel).toBeUndefined();
        expect(config.projects?.[1].use?.defaultBrowserType).toBe('webkit');
        expect(config.webServer && !Array.isArray(config.webServer) && config.webServer.reuseExistingServer).toBe(
            false,
        );
    }
});

it('ordinary e2e and keyboard fixture matchers do not accidentally run proof specs on their incompatible servers', async () => {
    const normal = (await import('../playwright.config')).default;
    const keyboard = (await import('../playwright.keyboard.config')).default;
    expect(normal.testDir).toBe('./e2e');
    for (const file of ['inert-ui-data139.spec.ts', 'inert-ui-artifact139.spec.ts'])
        expect(keyboard.testMatch).not.toContain(file);
    expect(fs.readFileSync('browser-tests/inert-ui-artifact139.spec.ts', 'utf8')).not.toMatch(/\btest\.skip\b/);
    expect(fs.readFileSync('browser-tests/inert-ui-data139.spec.ts', 'utf8')).not.toMatch(/\btest\.skip\b/);
});

it('release artifact mode rejects an external or default diagnostic artifact rather than silently substituting it', () => {
    for (const value of [undefined, path.resolve('../build139-configured-inert-tuples')]) {
        const env: NodeJS.ProcessEnv = { ...process.env, INERT_UI_RELEASE_ARTIFACT: '1' };
        if (value === undefined) delete env.ACTUAL_INERT_DIST;
        else env.ACTUAL_INERT_DIST = value;
        const result = spawnSync(process.execPath, ['scripts/serve-inert-ui-artifact139.mjs'], {
            env,
            encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Release proof requires the explicit already-built repository dist.');
    }
});
