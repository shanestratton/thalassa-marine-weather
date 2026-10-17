import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import dompurifyUnavailable, { DOMPURIFY_UNAVAILABLE_MESSAGE } from '../utils/vendorStubs/dompurifyUnavailable';
import html2canvasUnavailable, { HTML2CANVAS_UNAVAILABLE_MESSAGE } from '../utils/vendorStubs/html2canvasUnavailable';

/**
 * html2canvas and DOMPurify are jsPDF's optional HTML renderer and sanitiser,
 * reached only through doc.html(). Since 129-10 the float plan and maintenance
 * PDFs draw with jsPDF primitives, so vite.config.ts aliases both packages to
 * stubs and the build stops shipping ~230 KB of lazy chunks nothing could load.
 *
 * This guard fails if the cut stops being free: app source calls `.html(`
 * again, imports either package (DOMPurify must never be stubbed under
 * something that sanitises with it), or a jsPDF upgrade starts reaching them
 * from somewhere other than its html() plugin.
 */
const ROOT = process.cwd();
const STUBS = ['utils/vendorStubs/html2canvasUnavailable.ts', 'utils/vendorStubs/dompurifyUnavailable.ts'];
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
// Spelled in pieces so scripts/check-deps.mjs does not read this test as importing them.
const jspdfImport = (name: string) => ['import(', `"${name}"`, ')'].join('');

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
    return out.map((path) => relative(ROOT, path).split(sep).join('/'));
}

describe('jsPDF ships without html2canvas and DOMPurify', () => {
    it('aliases both bare specifiers to their stubs in the app build', () => {
        const viteConfig = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
        expect(viteConfig).toMatch(
            /\{\s*find:\s*\/\^html2canvas\$\/,\s*replacement:\s*path\.resolve\(__dirname,\s*'utils\/vendorStubs\/html2canvasUnavailable\.ts'\),?\s*\}/,
        );
        expect(viteConfig).toMatch(
            /\{\s*find:\s*\/\^dompurify\$\/,\s*replacement:\s*path\.resolve\(__dirname,\s*'utils\/vendorStubs\/dompurifyUnavailable\.ts'\),?\s*\}/,
        );
    });

    it('jsPDF imports each once, both inside its html() plugin', () => {
        const jspdf = readFileSync(join(ROOT, 'node_modules/jspdf/dist/jspdf.es.min.js'), 'utf8');
        for (const name of ['html2canvas', 'dompurify']) {
            expect(jspdf.split(jspdfImport(name)).length - 1, name).toBe(1);
        }
        // The plugin runs from the html2canvas loader to the next plugin's first
        // API method; the sanitiser's loader and html() itself are inside it.
        const start = jspdf.indexOf(jspdfImport('html2canvas'));
        const plugin = jspdf.slice(start, start + jspdf.slice(start).search(/\.API\.\w+=function/));
        expect(plugin).toContain(jspdfImport('dompurify'));
        expect(plugin).toMatch(/\.html=function/);
    });

    it('no package but jsPDF depends on either', () => {
        const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
            packages: Record<
                string,
                {
                    dependencies?: Record<string, string>;
                    optionalDependencies?: Record<string, string>;
                    peerDependencies?: Record<string, string>;
                }
            >;
        };
        const dependents = Object.entries(lock.packages)
            .filter(([, info]) => {
                const deps = { ...info.dependencies, ...info.optionalDependencies, ...info.peerDependencies };
                return 'html2canvas' in deps || 'dompurify' in deps;
            })
            .map(([name]) => name);
        expect(dependents).toEqual(['node_modules/jspdf']);
    });

    it('app source never calls .html( or imports html2canvas or dompurify', () => {
        const files = appSourceFiles();
        expect(files).toContain('services/floatPlanPdf.ts');
        expect(files).toContain('services/MaintenancePdfService.ts');
        expect(files.length).toBeGreaterThan(500);
        const offenders = files
            .filter((path) => !STUBS.includes(path))
            .filter((path) => {
                const text = readFileSync(join(ROOT, path), 'utf8');
                return /\.html\(|from\s+['"](html2canvas|dompurify)['"]|import\(\s*['"](html2canvas|dompurify)['"]\s*\)/.test(
                    text,
                );
            });
        expect(offenders).toEqual([]);
    });

    it('the stubs fail loudly through the same promise chain jsPDF uses', async () => {
        expect(() => html2canvasUnavailable()).toThrow(HTML2CANVAS_UNAVAILABLE_MESSAGE);
        expect(() => dompurifyUnavailable.sanitize()).toThrow(DOMPURIFY_UNAVAILABLE_MESSAGE);
        // jsPDF loads each, takes `.default` when present, then calls it.
        const render = import('../utils/vendorStubs/html2canvasUnavailable')
            .then((module) => module.default)
            .then((html2canvas) => html2canvas());
        await expect(render).rejects.toThrow(HTML2CANVAS_UNAVAILABLE_MESSAGE);
        const sanitise = import('../utils/vendorStubs/dompurifyUnavailable')
            .then((module) => module.default)
            .then((purify) => purify.sanitize());
        await expect(sanitise).rejects.toThrow(DOMPURIFY_UNAVAILABLE_MESSAGE);
    });
});
