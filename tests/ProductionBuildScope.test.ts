import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (name: string) => readFileSync(join(root, name), 'utf8');

function config(name: string, directory = root) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
        join(directory, name),
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            },
        },
    );
    if (!parsed) throw new Error(`Could not parse ${name}`);
    expect(parsed.errors).toEqual([]);
    return parsed;
}

function roots(name: string, directory = root) {
    return config(name, directory).fileNames.map((file) => relative(directory, file).replaceAll('\\', '/'));
}

describe('production build scope', () => {
    it('uses the release compiler without removing strictness or either client-secret scan', () => {
        const build = JSON.parse(read('package.json')).scripts.build as string;
        expect(build).toBe(
            'npm run check:client-secrets && NODE_OPTIONS=--max-old-space-size=4096 tsc -p tsconfig.build.json && vite build && npm run check:client-secrets -- --dist',
        );
        const options = config('tsconfig.build.json').options;
        const ordinary = config('tsconfig.json').options;
        for (const key of ['strict', 'noImplicitAny', 'strictNullChecks', 'noEmit', 'isolatedModules'] as const) {
            expect(options[key]).toBe(true);
            expect(options[key]).toBe(ordinary[key]);
        }
        expect(options.moduleResolution).toBe(ordinary.moduleResolution);
        expect(options.lib).toEqual(ordinary.lib);
    });

    it('checks all five web surfaces, Vercel handlers and ordinary app source', () => {
        const files = roots('tsconfig.build.json');
        for (const file of [
            'index.tsx',
            'src/logs-main.tsx',
            'src/beta-main.tsx',
            'src/feedback-main.tsx',
            'src/ocean-main.tsx',
            'App.tsx',
            'ApplicationShell.tsx',
            'viewRegistry.tsx',
            'middleware.ts',
            'env.d.ts',
            'vite.config.ts',
            'api/_releaseAssetProxy.ts',
            'services/ww3CacheClient.ts',
        ]) {
            expect(files).toContain(file);
        }
        // Independent tracked-file inventory: a mistake in the root compiler
        // config must not also shrink this coverage baseline and hide a gap.
        const ordinarySource = execFileSync(
            'git',
            [
                'ls-files',
                '-z',
                '--',
                'api',
                'components',
                'context',
                'contexts',
                'data',
                'hooks',
                'managers',
                'modules',
                'pages',
                'services',
                'src',
                'stores',
                'styles',
                'types',
                'utils',
            ],
            { cwd: root, encoding: 'utf8' },
        )
            .split('\0')
            .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.(?:test|spec)\./.test(file));
        expect(ordinarySource.length).toBeGreaterThan(500);
        expect(ordinarySource.filter((file) => !files.includes(file))).toEqual([]);
        expect(files.filter((file) => /\.(?:test|spec)\./.test(file))).toEqual([]);
        expect(
            files.filter((file) => /^(?:tests|e2e|browser-tests|stories|experiments|ios|dist)\//.test(file)),
        ).toEqual([]);
    });

    it('keeps CI test/fixture checking, while Deno stays out of the Node compiler', () => {
        const files = roots('tsconfig.json');
        expect(files).toContain('tests/helpers/dayPlanFixtures.ts');
        expect(files).toContain('e2e/fixtures/day-planner.tsx');
        expect(files).toContain('tests/ProductionBuildScope.test.ts');
        const ci = read('.github/workflows/ci.yml');
        expect(ci).toContain('run: npx tsc --noEmit');
        expect(ci).toContain('run: deno check */index.ts');
        expect(ci).toContain('run: npx vitest run --reporter=verbose --coverage');
        expect(ci).toContain('run: npm run build');
    });

    it('does not select orphan browser fixtures or nested Research edge functions in a filtered checkout', () => {
        const directory = mkdtempSync(join(tmpdir(), 'thalassa-build-scope-'));
        try {
            for (const name of ['tsconfig.json', 'tsconfig.build.json'])
                writeFileSync(join(directory, name), read(name));
            const fixtures = {
                'index.tsx': 'export {};',
                'src/logs-main.tsx': 'export {};',
                'api/example.ts': 'export {};',
                'services/example.ts': 'export {};',
                'services/example.test.ts': 'export {};',
                'e2e/fixtures/day-planner.tsx': "import '../../tests/helpers/dayPlanFixtures';",
                'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts':
                    "import sql from 'npm:postgres@3.4.7'; Deno.serve(() => sql);",
                'experiments/scuttlebutt-e2ee/pilot/example.ts': 'export {};',
            };
            for (const [name, source] of Object.entries(fixtures)) {
                const file = join(directory, name);
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, source);
            }
            expect(roots('tsconfig.build.json', directory).sort()).toEqual([
                'api/example.ts',
                'index.tsx',
                'services/example.ts',
                'src/logs-main.tsx',
            ]);
            const ordinary = roots('tsconfig.json', directory);
            expect(ordinary).toContain('services/example.test.ts');
            expect(ordinary).toContain('e2e/fixtures/day-planner.tsx');
            expect(ordinary).toContain('experiments/scuttlebutt-e2ee/pilot/example.ts');
            expect(ordinary.some((file) => file.includes('/supabase/'))).toBe(false);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('packages production source and shared wave types, not test or Research material', () => {
        const excluded = [
            'tests/helpers/dayPlanFixtures.ts',
            'e2e/fixtures/day-planner.tsx',
            'browser-tests/example.ts',
            'stories/Example.stories.tsx',
            '.storybook/main.ts',
            'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts',
            'experiments/scuttlebutt-e2ee/full-app-pilot/main.tsx',
            'playwright.day-planner.config.ts',
            'vitest.config.ts',
            'supabase/functions/crew/index.ts',
        ];
        const included = [
            'tsconfig.json',
            'tsconfig.build.json',
            'vite.config.ts',
            'index.tsx',
            'src/logs-main.tsx',
            'api/_releaseAssetProxy.ts',
            'services/ww3CacheClient.ts',
            'supabase/functions/_shared/ww3.ts',
        ];
        // Let Git interpret the gitignore-compatible Vercel patterns, including
        // the important multi-level Supabase exception, rather than approximating them.
        const directory = mkdtempSync(join(tmpdir(), 'thalassa-vercel-scope-'));
        try {
            // No repository .gitignore/info-exclude rules may mask a missing
            // deployment rule: only .vercelignore decides this assertion.
            execFileSync('git', ['init', '--quiet', directory]);
            const ignored = execFileSync(
                'git',
                ['-c', `core.excludesFile=${resolve(root, '.vercelignore')}`, 'check-ignore', '--no-index', '--stdin'],
                { cwd: directory, input: [...excluded, ...included].join('\n') + '\n', encoding: 'utf8' },
            )
                .trim()
                .split('\n');
            expect(ignored.sort()).toEqual(excluded.sort());
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
