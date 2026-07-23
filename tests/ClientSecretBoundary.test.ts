import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) files.push(...sourceFiles(path));
        else if (['.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
    }
    return files;
}

describe('browser paid-secret boundary', () => {
    it('does not resolve server-managed provider secrets from Vite client code', () => {
        const roots = ['components', 'hooks', 'services', 'stores', 'utils'].map((folder) =>
            join(process.cwd(), folder),
        );
        const forbidden = [
            'VITE_GEMINI_API_KEY',
            'VITE_STORMGLASS_API_KEY',
            'VITE_WORLDTIDES_API_KEY',
            'VITE_WORLD_TIDES_API_KEY',
            'VITE_SPOONACULAR_KEY',
            'VITE_RAINBOW_API_KEY',
        ];
        const violations: string[] = [];
        for (const file of roots.flatMap(sourceFiles)) {
            const source = readFileSync(file, 'utf8');
            for (const name of forbidden) {
                if (source.includes(name)) violations.push(`${file}: ${name}`);
            }
        }
        expect(violations).toEqual([]);
    });
});
