import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
describe('wake wire survives the actual web upload boundary', () => {
    it('keeps wake app imports (including type-only imports) out of excluded Pi/server source', () => {
        const files = [
            'services/alarms/WakeRuleWatch.ts',
            'services/alarms/wakePiWire.ts',
            'services/alarms/wakeAlarmStore.ts',
            'services/alarms/wakeCloudAlarms.ts',
            'services/alarms/wakeAlarmAcknowledgement.ts',
            'utils/wakePiContract.ts',
        ];
        for (const file of files) {
            const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
            function visit(node: ts.Node) {
                if (
                    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                    node.moduleSpecifier &&
                    ts.isStringLiteral(node.moduleSpecifier)
                ) {
                    const target = path.posix.normalize(
                        path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text),
                    );
                    expect(target).not.toMatch(/^(pi-cache|ios|supabase\/functions\/(?!_shared))/);
                    expect(node.moduleSpecifier.text).not.toMatch(/^node:/);
                }
                ts.forEachChild(node, visit);
            }
            visit(tree);
        }
        expect(readFileSync('.vercelignore', 'utf8')).toMatch(/^pi-cache\/$/m);
    });
    it('compiles the real canonical wire and rule without Pi files, Node types or repository modules', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'thalassa-wake-wire-'));
        expect(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep + 'thalassa-wake-wire-')).toBe(true);
        try {
            for (const file of ['wakePiContract.ts', 'wakeRule.ts'])
                copyFileSync(path.resolve('utils', file), path.join(dir, file));
            writeFileSync(
                path.join(dir, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        target: 'ES2022',
                        module: 'ESNext',
                        moduleResolution: 'bundler',
                        lib: ['ES2022', 'DOM'],
                        types: [],
                        strict: true,
                        noEmit: true,
                    },
                    include: ['*.ts'],
                }),
            );
            expect(
                execFileSync(
                    process.execPath,
                    [path.resolve('node_modules/typescript/bin/tsc'), '--project', path.join(dir, 'tsconfig.json')],
                    { encoding: 'utf8', timeout: 25_000 },
                ),
            ).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});
