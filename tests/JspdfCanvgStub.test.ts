import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import canvgUnavailable, { CANVG_UNAVAILABLE_MESSAGE } from '../utils/vendorStubs/canvgUnavailable';

/**
 * canvg is jsPDF's optional SVG rasteriser. jsPDF reaches it through one
 * dynamic import inside `addSvgAsImage`, which Thalassa never calls, so
 * vite.config.ts aliases 'canvg' to a stub and the build stops shipping a
 * ~159 KB canvg + core-js chunk that nothing could load (2026-10-05).
 *
 * This guard fails if the cut stops being free: app source starts calling
 * addSvgAsImage or importing canvg, or a jsPDF upgrade starts needing canvg
 * somewhere else (doc.html() needs html2canvas and DOMPurify, which stay).
 */
const ROOT = process.cwd();
const STUB = 'utils/vendorStubs/canvgUnavailable.ts';
const APP_DIRS = [
    'components',
    'context',
    'contexts',
    'hooks',
    'managers',
    'modules',
    'pages',
    'services',
    'src',
    'stores',
    'utils',
];
const APP_FILES = ['App.tsx', 'ApplicationShell.tsx', 'index.tsx', 'viewRegistry.tsx', 'utils.ts'];
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
// Spelled in pieces so scripts/check-deps.mjs does not read this test as importing canvg.
const JSPDF_CANVG_IMPORT = ['import(', '"canvg"', ')'].join('');

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (SOURCE.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
    }
}

function appSourceFiles(): string[] {
    const out: string[] = [];
    for (const dir of APP_DIRS) {
        try {
            walk(join(ROOT, dir), out);
        } catch {
            /* a directory this checkout does not have */
        }
    }
    for (const file of APP_FILES) {
        try {
            if (statSync(join(ROOT, file)).isFile()) out.push(join(ROOT, file));
        } catch {
            /* optional entry point */
        }
    }
    return out.map((path) => relative(ROOT, path));
}

describe('jsPDF ships without canvg', () => {
    it('aliases the bare canvg specifier to the stub in the app build', () => {
        const viteConfig = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
        expect(viteConfig).toMatch(
            /\{\s*find:\s*\/\^canvg\$\/,\s*replacement:\s*path\.resolve\(__dirname,\s*'utils\/vendorStubs\/canvgUnavailable\.ts'\)\s*\}/,
        );
    });

    it('jsPDF imports canvg once, from inside addSvgAsImage only', () => {
        const jspdf = readFileSync(join(ROOT, 'node_modules/jspdf/dist/jspdf.es.min.js'), 'utf8');
        const imports = jspdf.split(JSPDF_CANVG_IMPORT).length - 1;
        expect(imports).toBe(1);
        const before = jspdf.slice(0, jspdf.indexOf(JSPDF_CANVG_IMPORT));
        const methods = [...before.matchAll(/\.API\.(\w+)=function/g)];
        expect(methods.at(-1)?.[1]).toBe('addSvgAsImage');
    });

    it('app source never calls addSvgAsImage or imports canvg', () => {
        const files = appSourceFiles();
        expect(files).toContain('services/MaintenancePdfService.ts');
        expect(files.length).toBeGreaterThan(500);
        const offenders = files
            .filter((path) => path !== STUB)
            .filter((path) => {
                const text = readFileSync(join(ROOT, path), 'utf8');
                return /addSvgAsImage|from\s+['"]canvg['"]|import\(\s*['"]canvg['"]\s*\)/.test(text);
            });
        expect(offenders).toEqual([]);
    });

    it('the stub fails loudly through the same promise chain jsPDF uses', async () => {
        expect(() => canvgUnavailable.fromString()).toThrow(CANVG_UNAVAILABLE_MESSAGE);
        // jsPDF loads canvg, takes `.default` when present, then calls fromString().
        const chain = import('../utils/vendorStubs/canvgUnavailable')
            .then((module) => module.default)
            .then((canvg) => canvg.fromString());
        await expect(chain).rejects.toThrow(CANVG_UNAVAILABLE_MESSAGE);
    });
});
