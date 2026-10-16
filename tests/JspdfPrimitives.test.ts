import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { parseAst } from 'rollup/parseAst';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { jsPDF } from 'jspdf';
import { pruneJspdfPlugins, jspdfPrimitives } from '../scripts/jspdf-primitives.mjs';
import { __testing as floatPlan } from '../services/floatPlanPdf';
import { __testing as maintenance } from '../services/MaintenancePdfService';
import { standardFloatPlan, maintenanceTasks, maintenanceHistory, PDF_FIXTURE_NOW } from './helpers/pdfFixtures';
import { installFakeCanvas } from './helpers/jspdfPages';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'node_modules/jspdf/dist/jspdf.es.js'), 'utf8');
const trimmed = pruneJspdfPlugins(source, parseAst);
type PdfConstructor = typeof jsPDF;
let original: PdfConstructor, pruned: PdfConstructor;

async function compile(code: string): Promise<PdfConstructor> {
    // Compile in Node's own realm; jsdom's Uint8Array breaks esbuild's native
    // TextEncoder invariant. Evaluation below still uses the real browser API.
    const compiled = execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
        import fs from 'node:fs'; import path from 'node:path'; import {build} from 'esbuild';
        const result=await build({stdin:{contents:fs.readFileSync(0,'utf8'),resolveDir:path.resolve('node_modules/jspdf/dist'),loader:'js'},platform:'browser',format:'cjs',bundle:true,write:false,external:['canvg','html2canvas','dompurify']});
        process.stdout.write(result.outputFiles[0].text);
    `,
        ],
        {
            cwd: root,
            input: code,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
            timeout: 30_000,
        },
    );
    const module = { exports: {} as { jsPDF: PdfConstructor } };
    new Function('module', 'exports', compiled)(module, module.exports);
    return module.exports.jsPDF;
}

beforeAll(async () => {
    [original, pruned] = await Promise.all([compile(source), compile(trimmed.code)]);
});
afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('jspdf');
});
function canonical(bytes: Uint8Array) {
    // jsPDF's sole nondeterministic part is its randomly generated document ID.
    return Buffer.from(bytes)
        .toString('latin1')
        .replace(/\/ID\s*\[\s*<[A-F\d]+>\s*<[A-F\d]+>\s*\]/g, '/ID [<fixed><fixed>]');
}
function blobBytes(blob: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.readAsArrayBuffer(blob);
    });
}

describe('reviewed jsPDF primitive build', () => {
    it('removes exactly three complete AST IIFEs and rejects any unreviewed bytes', () => {
        expect(trimmed.plugins.sort()).toEqual(['canvas', 'context2d', 'html']);
        expect(() => parseAst(trimmed.code)).not.toThrow();
        expect(() => pruneJspdfPlugins(source + '\n', parseAst)).toThrow(/Unreviewed jsPDF ESM source/);
        expect(() => pruneJspdfPlugins(source.replace('Context2D', 'Context3D'), parseAst)).toThrow();
        expect(trimmed.code).toContain('jsPDFAPI.processWEBP');
        expect(trimmed.code).toContain('AcroFormAppearance');
    });
    it('is production-build-only and resolves the reviewed browser module', () => {
        const plugin = jspdfPrimitives(root);
        expect(plugin.apply).toBe('build');
        expect(plugin.enforce).toBe('pre');
        const configure = plugin.configResolved as (config: { isProduction: boolean }) => void;
        const resolve = plugin.resolveId as (id: string) => string | null;
        configure({ isProduction: true });
        expect(resolve('jspdf')).toBe(path.join(root, 'node_modules/jspdf/dist/jspdf.es.js'));
        configure({ isProduction: false });
        expect(resolve('jspdf')).toBeNull();
    });
    it('guards actual app PDF consumers against an emulation API dependency', () => {
        const offenders: string[] = [];
        const files: string[] = [];
        function collect(folder: string) {
            for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
                const file = path.join(folder, entry.name);
                if (entry.isDirectory()) collect(file);
                else if (/\.(ts|tsx)$/.test(file)) files.push(file);
            }
        }
        ['services', 'components', 'hooks'].forEach(collect);
        for (const file of files) {
            const text = fs.readFileSync(path.join(root, file), 'utf8');
            const pdfConsumer = /from\s*['"]jspdf['"]|import\(\s*['"]jspdf['"]/.test(text);
            const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            function visit(node: ts.Node) {
                const member = ts.isPropertyAccessExpression(node)
                    ? node.name.text
                    : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
                      ? node.argumentExpression.text
                      : null;
                if (member === 'html' || member === 'context2d') offenders.push(file);
                if (
                    pdfConsumer &&
                    member === 'canvas' &&
                    ts.isPropertyAccessExpression(node) &&
                    node.expression.kind !== ts.SyntaxKind.ThisKeyword
                )
                    offenders.push(file);
                ts.forEachChild(node, visit);
            }
            visit(tree);
        }
        expect(offenders).toEqual([]);
    });
    it('preserves all actual PDF primitives, image decoders and AcroForm methods', () => {
        const base = new original(),
            doc = new pruned();
        for (const name of [
            'text',
            'line',
            'rect',
            'addImage',
            'processPNG',
            'processJPEG',
            'processWEBP',
            'processRGBA',
            'addField',
            'splitTextToSize',
        ]) {
            expect(typeof doc[name as keyof jsPDF], name).toBe(typeof base[name as keyof jsPDF]);
            expect(typeof base[name as keyof jsPDF], name).toBe('function');
        }
        expect('context2d' in doc).toBe(false);
        expect('canvas' in doc).toBe(false);
        expect('html' in doc).toBe(false);
    });
    it('keeps real float-plan, checklist, service-history and hourly-route PDFs byte-identical', async () => {
        vi.useFakeTimers({ now: PDF_FIXTURE_NOW, toFake: ['Date'] });
        const canvas = installFakeCanvas();
        const groups: Uint8Array[][] = [];
        try {
            for (const [label, Constructor] of [
                ['original', original],
                ['pruned', pruned],
            ] as const) {
                const docs = [
                    floatPlan.buildFloatPlanPdf(standardFloatPlan(), Constructor).doc,
                    maintenance.buildChecklistPdf(
                        maintenanceTasks(),
                        1200,
                        'Fictional vessel',
                        Constructor,
                        new Date(PDF_FIXTURE_NOW),
                    ),
                    maintenance.buildServiceHistoryPdf(
                        maintenanceHistory(),
                        'Fictional vessel',
                        Constructor,
                        new Date(PDF_FIXTURE_NOW),
                    ),
                ];
                const bytes: Uint8Array[] = docs.map((doc) => new Uint8Array(doc.output('arraybuffer')));
                vi.doMock('jspdf', () => ({ jsPDF: Constructor, default: Constructor }));
                vi.resetModules();
                const { generateRouteReportPdf } = await import('../services/RouteReportPdfService');
                const { routeWeatherFixture, routeWeatherFixturePins } = await import('./fixtures/routeWeatherFixture');
                const report = routeWeatherFixture();
                bytes.push(
                    await blobBytes(
                        generateRouteReportPdf({
                            routeName: 'Fictional hourly weather passage',
                            pins: routeWeatherFixturePins,
                            verdicts: [],
                            tideLabels: {},
                            departureLabel: '',
                            routeWeather: report,
                            nowMs: report.loadedAtMs,
                        }),
                    ),
                );
                groups.push(bytes);
                if (process.env.JSPDF_PROOF_DIR) {
                    fs.mkdirSync(process.env.JSPDF_PROOF_DIR, { recursive: true });
                    ['float-plan', 'checklist', 'service-history', 'route-weather'].forEach((name, i) =>
                        fs.writeFileSync(path.join(process.env.JSPDF_PROOF_DIR!, `${label}-${name}.pdf`), bytes[i]),
                    );
                }
            }
            groups[0].forEach((bytes, i) => expect(canonical(groups[1][i])).toBe(canonical(bytes)));
        } finally {
            canvas.restore();
        }
    });
});
