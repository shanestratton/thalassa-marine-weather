import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { parseAst } from 'rollup/parseAst';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { jsPDF } from 'jspdf';
import { assertJspdfAppApis, pruneJspdfPlugins, jspdfPrimitives } from '../scripts/jspdf-primitives.mjs';
import { __testing as floatPlan } from '../services/floatPlanPdf';
import { __testing as maintenance } from '../services/MaintenancePdfService';
import { standardFloatPlan, maintenanceTasks, maintenanceHistory, PDF_FIXTURE_NOW } from './helpers/pdfFixtures';
import { installFakeCanvas } from './helpers/jspdfPages';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'node_modules/jspdf/dist/jspdf.es.js'), 'utf8');
const published = fs.readFileSync(path.join(root, 'node_modules/jspdf/dist/jspdf.es.min.js'), 'utf8');
const trimmed = pruneJspdfPlugins(source, parseAst, { acroform: true, appFonts: true, packedBidi: true });
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
    [original, pruned] = await Promise.all([compile(published), compile(trimmed.code)]);
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
    it('reconstructs all 2,048 bidi classes exactly with fixed bounded runs', () => {
        const packed = trimmed.bidiTable!;
        const decode = new Function('return ' + packed.decoder)() as (encoded: string) => string[];
        expect(decode(packed.encoded)).toEqual(packed.values);
        expect(packed.encoded).toHaveLength(474);
        for (const damaged of [
            packed.encoded.slice(1),
            'Z1' + packed.encoded.slice(2),
            'A0' + packed.encoded.slice(2),
            'Azzzz' + packed.encoded.slice(5),
            '?'.repeat(474),
        ])
            expect(() => decode(damaged)).toThrow(/PDF bidi data/);
    });
    it('preserves actual mixed RTL/LTR PDF text ordering and alignment', () => {
        for (const rtl of [false, true])
            for (const text of [
                'Port 12.5 \u05d0\u05d1\u05d2 starboard',
                '\u0627\u0644\u0628\u062d\u0631 25 kn SW',
                '\u05e9\u05dc\u05d5\u05dd (123) \u0628\u062d\u0631',
                'AVATAR \u202babc 123\u202c To',
            ]) {
                const bytes = [original, pruned].map((Constructor) => {
                    const doc = new Constructor();
                    doc.setCreationDate(new Date(PDF_FIXTURE_NOW));
                    doc.setR2L(rtl);
                    doc.text(text, 20, 20);
                    return new Uint8Array(doc.output('arraybuffer'));
                });
                expect(canonical(bytes[1])).toBe(canonical(bytes[0]));
            }
    });
    it('proves TrueType implementation bindings have no references outside the removed region', () => {
        const file = fs.realpathSync(path.join(root, 'node_modules/jspdf/dist/jspdf.es.js'));
        const program = ts.createProgram([file], { allowJs: true, noLib: true, noResolve: true });
        const checker = program.getTypeChecker(),
            tree = program.getSourceFile(file)!;
        const start = source.indexOf('jsPDF.API.TTFFont = function'),
            end = source.indexOf('}();', source.indexOf('jsPDF.API.PDFObject = function')) + 4;
        const bindings = new Set<ts.Symbol>();
        function collect(node: ts.Node) {
            if (
                node.getStart(tree) >= start &&
                node.end <= end &&
                (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
                node.name &&
                ts.isIdentifier(node.name)
            ) {
                const symbol = checker.getSymbolAtLocation(node.name);
                if (symbol) bindings.add(symbol);
            }
            ts.forEachChild(node, collect);
        }
        collect(tree);
        expect(bindings.size).toBeGreaterThan(100);
        const outside: string[] = [];
        function inspect(node: ts.Node) {
            if (ts.isIdentifier(node) && (node.getStart(tree) < start || node.end > end)) {
                const symbol = checker.getSymbolAtLocation(node);
                if (symbol && bindings.has(symbol)) outside.push(node.text);
            }
            ts.forEachChild(node, inspect);
        }
        inspect(tree);
        expect(outside).toEqual([]);
        expect(trimmed.code).not.toContain('jsPDF.API.TTFFont');
        expect(trimmed.code).not.toContain('jsPDF.API.PDFObject');
    });
    it('retains every font registration/ID, used metrics and default Helvetica behavior', () => {
        const baseline = new original(),
            doc = new pruned();
        expect(doc.getFontList()).toEqual(baseline.getFontList());
        expect(doc.getFont()).toMatchObject({ fontName: 'helvetica', fontStyle: 'normal', id: 'F1' });
        for (const [family, styles] of [
            ['helvetica', ['normal', 'bold', 'italic', 'bolditalic']],
            ['courier', ['normal']],
        ] as const)
            for (const style of styles) {
                baseline.setFont(family, style);
                doc.setFont(family, style);
                expect(doc.getFont()).toEqual(baseline.getFont());
                for (const text of ['MAYDAY 123.45', 'Jalape\u00f1o \u20ac \u00b0', 'AVATAR WA To fi'])
                    expect(doc.getTextWidth(text)).toBe(baseline.getTextWidth(text));
            }
        expect(typeof doc.processArabic).toBe('function');
        expect(doc.processArabic('\u0627\u0644\u0628\u062d\u0631')).toBe(
            baseline.processArabic('\u0627\u0644\u0628\u062d\u0631'),
        );
        for (const name of ['TTFFont', 'PDFObject', 'addFileToVFS', 'cell', 'table']) expect(name in doc).toBe(false);
    });
    it('fails closed on unsupported fonts, custom-font/VFS APIs, aliases and library table calls', () => {
        const file = '/app/services/newPdf.ts';
        for (const code of [
            "doc.setFont('times', 'normal')",
            "doc.setFont('courier','bold')",
            'doc.setFont(font)',
            "doc.setFont('helvetica',style)",
            "doc.addFont('font.ttf','custom','normal')",
            "doc.addFileToVFS('font.ttf',bytes)",
            'doc.cellAddPage()',
            'doc.table(rows)',
            'doc.setTableHeaderRow(rows)',
            'doc.existsFileInVFS(name)',
            'const f=doc.setFont',
            'const {setFont:f}=doc',
            "doc['setFont']('symbol','normal')",
        ])
            expect(() => assertJspdfAppApis(code, file), code).toThrow(/Unsupported jsPDF/);
        expect(() =>
            assertJspdfAppApis("doc.setFont('helvetica',bold?'bold':'normal');doc.setFont('courier','normal')", file),
        ).not.toThrow();
        expect(() =>
            assertJspdfAppApis('const page=new jsPDF();page.table(rows)', '/app/services/MaintenancePdfService.ts'),
        ).toThrow();
        expect(() =>
            assertJspdfAppApis(
                fs.readFileSync(path.join(root, 'services/MaintenancePdfService.ts'), 'utf8'),
                path.join(root, 'services/MaintenancePdfService.ts'),
            ),
        ).not.toThrow();
    });
    it('checks every actual production source module, including the older utility PDF writers', () => {
        let checked = 0;
        function scan(folder: string) {
            if (!fs.existsSync(path.join(root, folder))) return;
            for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
                const file = path.join(folder, entry.name);
                if (entry.isDirectory()) scan(file);
                else if (/\.[jt]sx?$/.test(file) && !/(?:\.test\.|\.spec\.|\.stories\.)/.test(file)) {
                    assertJspdfAppApis(fs.readFileSync(path.join(root, file), 'utf8'), path.join(root, file));
                    checked += 1;
                }
            }
        }
        [
            'services',
            'components',
            'utils',
            'hooks',
            'modules',
            'stores',
            'contexts',
            'context',
            'pages',
            'managers',
            'src',
        ].forEach(scan);
        expect(checked).toBeGreaterThan(1000);
    });
    it('proves removed AcroForm bindings have no outside consumers except its twelve removed exports', () => {
        const file = fs.realpathSync(path.join(root, 'node_modules/jspdf/dist/jspdf.es.js'));
        const program = ts.createProgram([file], { allowJs: true, noLib: true, noResolve: true });
        const checker = program.getTypeChecker(),
            tree = program.getSourceFile(file)!;
        const start = source.indexOf('var jsPDFAPI = jsPDF.API;');
        const end = source.indexOf('var AcroForm = jsPDF.AcroForm;') + 'var AcroForm = jsPDF.AcroForm;'.length;
        const symbols = new Set<ts.Symbol>();
        function collect(node: ts.Node) {
            if (
                node.getStart(tree) >= start &&
                node.end <= end &&
                (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
                node.name &&
                ts.isIdentifier(node.name)
            ) {
                const symbol = checker.getSymbolAtLocation(node.name);
                if (symbol) symbols.add(symbol);
            }
            ts.forEachChild(node, collect);
        }
        collect(tree);
        const references: string[] = [];
        function inspect(node: ts.Node) {
            if (ts.isIdentifier(node) && (node.getStart(tree) < start || node.end > end)) {
                let symbol = checker.getSymbolAtLocation(node);
                if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
                if (symbol && symbols.has(symbol)) {
                    expect(ts.isExportSpecifier(node.parent), node.text).toBe(true);
                    references.push(node.text);
                }
            }
            ts.forEachChild(node, inspect);
        }
        inspect(tree);
        expect(references).toEqual([
            'AcroForm',
            'AcroFormAppearance',
            'AcroFormButton',
            'AcroFormCheckBox',
            'AcroFormChoiceField',
            'AcroFormComboBox',
            'AcroFormEditBox',
            'AcroFormListBox',
            'AcroFormPasswordField',
            'AcroFormPushButton',
            'AcroFormRadioButton',
            'AcroFormTextField',
        ]);
    });
    it('removes exactly three complete AST IIFEs and rejects any unreviewed bytes', () => {
        expect(trimmed.plugins.sort()).toEqual(['canvas', 'context2d', 'html']);
        expect(() => parseAst(trimmed.code)).not.toThrow();
        expect(() => pruneJspdfPlugins(source + '\n', parseAst)).toThrow(/Unreviewed jsPDF ESM source/);
        expect(() => pruneJspdfPlugins(source.replace('Context2D', 'Context3D'), parseAst)).toThrow();
        expect(trimmed.code).toContain('jsPDFAPI.processWEBP');
        expect(trimmed.acroFormRemoved).toBe(true);
        expect(trimmed.code).not.toContain('AcroFormAppearance');
        expect(pruneJspdfPlugins(source, parseAst).code).toContain('AcroFormAppearance');
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
                    ts.isIdentifier(node) &&
                    (node.text === 'addField' || node.text.startsWith('AcroForm') || node.text === '__acroform__')
                )
                    offenders.push(file);
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
    it('preserves all actual PDF primitives and image decoders with no unused form registration', () => {
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
            'splitTextToSize',
        ]) {
            expect(typeof doc[name as keyof jsPDF], name).toBe(typeof base[name as keyof jsPDF]);
            expect(typeof base[name as keyof jsPDF], name).toBe('function');
        }
        expect('context2d' in doc).toBe(false);
        expect('canvas' in doc).toBe(false);
        expect('html' in doc).toBe(false);
        expect('addField' in doc).toBe(false);
        expect('AcroForm' in doc).toBe(false);
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
