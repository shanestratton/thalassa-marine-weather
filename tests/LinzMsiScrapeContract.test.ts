import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('LINZ MSI scheduled writer contract', () => {
    it('locks and verifies the nested dependency tree before the secret-bearing step', () => {
        const workflow = read('.github/workflows/linz-msi-scrape.yml');
        const orderedCommands = [
            'run: npm ci',
            'run: npm audit --audit-level=high',
            'run: npm ls --all',
            'run: npm test',
            'run: npx --no-install playwright install chromium --with-deps',
            'run: node scrape.mjs',
        ];
        let previousIndex = -1;
        for (const command of orderedCommands) {
            const index = workflow.indexOf(command);
            expect(index, `missing workflow command: ${command}`).toBeGreaterThan(previousIndex);
            previousIndex = index;
        }

        expect(workflow).toContain("node-version: '22'");
        expect(workflow).toContain('cache-dependency-path: scripts/linz-msi-scrape/package-lock.json');
        expect(workflow).toContain('group: linz-msi-scrape');
        expect(workflow).toContain('cancel-in-progress: false');
        expect(workflow).toContain("if: github.ref == 'refs/heads/master'");
        expect(workflow).not.toContain("github.event_name == 'workflow_dispatch' ||");
        expect(workflow).not.toContain('npm install --no-audit');
        expect(existsSync(join(root, 'scripts/linz-msi-scrape/package-lock.json'))).toBe(true);

        const testIndex = workflow.indexOf('run: npm test');
        const liveIndex = workflow.indexOf('run: node scrape.mjs');
        const serviceKeyIndex = workflow.indexOf('SUPABASE_SERVICE_ROLE_KEY:');
        expect(serviceKeyIndex).toBeGreaterThan(testIndex);
        expect(serviceKeyIndex).toBeLessThan(liveIndex);
        expect(workflow.match(/SUPABASE_SERVICE_ROLE_KEY:/g)).toHaveLength(1);
    });

    it('keeps upstream Chromium sandboxed and verifies safety before persistence', () => {
        const source = read('scripts/linz-msi-scrape/scrape.mjs');

        expect(source).not.toContain("'--no-sandbox'");
        expect(source).toContain('chromiumSandbox: true');
        expect(source).toContain('env: browserEnv');
        expect(source).toContain('const writeCredentials = dryRun ? null : validateWriteEnvironment(env);');
        expect(source.indexOf('validateWriteEnvironment(env)')).toBeLessThan(source.indexOf('await scrapePage('));
        expect(source.indexOf('normalizeWarnings(bodyText, runTimestamp)')).toBeLessThan(
            source.indexOf('await persistWarnings('),
        );
        expect(source).toContain("if (value === '1') return true;");
        expect(source).toContain('duplicate warning IDs found');
        expect(source).toContain('page in-force timestamp is stale');
        expect(source).toContain('write preflight failed');
        expect(source.indexOf(".select('id', { count: 'exact', head: true })")).toBeLessThan(
            source.indexOf('.upsert(warnings'),
        );
    });
});
