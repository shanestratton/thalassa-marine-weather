import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(process.cwd(), 'services/AvNavDiscoveryService.ts'), 'utf8');

describe('AvNav discovery trust boundary', () => {
    it('loads the optional native plugin without runtime code generation', () => {
        expect(SOURCE).not.toMatch(/\bnew\s+Function\s*\(/);
        expect(SOURCE).not.toMatch(/\beval\s*\(/);
        expect(SOURCE).toContain('import(/* @vite-ignore */ moduleSpecifier)');
        expect(SOURCE).toContain('isZeroconfPlugin');
    });
});
