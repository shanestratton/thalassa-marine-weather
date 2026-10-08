/**
 * No camera move leaves its padding on the map (build 124, Obs camera centring).
 *
 * Shane 2026-10-08: "can we look at the obs page gps again, it is still not
 * quite right ... when i click the locate fab, it goes to the first image
 * which is not centred". Plan's route fit (fitTraceBounds) passed a padding
 * of {left 300, right 40, top 90, bottom 130} to clear its route card, and
 * Mapbox GL 3 KEEPS a camera call's padding on the map unless the call says
 * `retainPadding: false`. Plan and Obs share one map, so every later Obs
 * flight that names no padding of its own reused it: find-boat put the boat
 * at the padded centre, 130 pt right of the canvas centre on any phone, and
 * getBounds() shrank to the strip right of the card (AIS, ENC, wind and the
 * seamarks all bound their work by it).
 *
 * A guard against "someone forgot a call site" cannot be a list of the call
 * sites someone remembered (tests/PiTransportCompleteness.test.ts), so this
 * walks the tree with the TypeScript parser: every fitBounds, flyTo, easeTo
 * and jumpTo whose options carry `padding` must also say `retainPadding:
 * false`, and nothing may set a non-zero padding with setPadding. The
 * exemptions are named, with their reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
/** The app's own source. src/ is the public voyage page, its own maps on its own page. */
const SCAN_DIRS = [
    'components',
    'hooks',
    'services',
    'pages',
    'context',
    'contexts',
    'stores',
    'utils',
    'managers',
    'modules',
];

/**
 * Files whose padded camera calls may keep their padding, and why. Adding one
 * is a deliberate act: the reason must be a property of the MAP, never a
 * convenience.
 */
const ALLOWED = new Map<string, string>([
    [
        'components/autorouting/AutoroutingTrialWorkspace.tsx',
        'its own map, never the shared chart: the padding it keeps marks the water clear of its header ' +
            'and folded card, so its own + and − buttons zoom about the route the skipper is reviewing',
    ],
]);

const CAMERA_CALLS = new Set(['fitBounds', 'flyTo', 'easeTo', 'jumpTo']);
/** A file with none of these words has no call paddingOffences could flag. */
const CAMERA_CALL_TEXT = /\b(?:fitBounds|flyTo|easeTo|jumpTo|setPadding)\b/;

interface PaddingOffence {
    file: string;
    line: number;
    call: string;
    why: string;
}

const propertyName = (p: ts.ObjectLiteralElementLike): string | null =>
    (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
        ? p.name.text
        : null;

const isZero = (node: ts.Expression): boolean => ts.isNumericLiteral(node) && Number(node.text) === 0;

/** A padding that is all zero: setPadding(0), setPadding(NO_CAMERA_PADDING) or a literal with every side 0. */
function zeroPadding(arg: ts.Expression | undefined): boolean {
    if (!arg) return false;
    if (isZero(arg)) return true;
    if (ts.isIdentifier(arg) && arg.text === 'NO_CAMERA_PADDING') return true;
    if (ts.isObjectLiteralExpression(arg)) {
        return arg.properties.every((p) => {
            if (ts.isSpreadAssignment(p))
                return ts.isIdentifier(p.expression) && p.expression.text === 'NO_CAMERA_PADDING';
            return ts.isPropertyAssignment(p) && isZero(p.initializer);
        });
    }
    return false;
}

/** Leaflet's fitBounds takes a [x, y] padding and keeps nothing: its files are not Mapbox's. */
function isLeafletFile(source: ts.SourceFile): boolean {
    const modules = source.statements
        .filter(ts.isImportDeclaration)
        .map((d) => (ts.isStringLiteral(d.moduleSpecifier) ? d.moduleSpecifier.text : ''));
    return modules.some((m) => m === 'leaflet' || m === 'react-leaflet') && !modules.some((m) => /mapbox/.test(m));
}

/** Every padded camera call in one file that would leave its padding behind. */
function paddingOffences(file: string, text: string): PaddingOffence[] {
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    if (isLeafletFile(source)) return [];
    const found: PaddingOffence[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const call = node.expression.name.text;
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            if (call === 'setPadding' && !zeroPadding(node.arguments[0])) {
                found.push({ file, line, call, why: 'sets a non-zero padding that stays on the map' });
            } else if (CAMERA_CALLS.has(call)) {
                const options = node.arguments[call === 'fitBounds' ? 1 : 0];
                if (options && ts.isObjectLiteralExpression(options)) {
                    const names = options.properties.map(propertyName);
                    const retain = options.properties.find((p) => propertyName(p) === 'retainPadding');
                    const released =
                        !!retain &&
                        ts.isPropertyAssignment(retain) &&
                        retain.initializer.kind === ts.SyntaxKind.FalseKeyword;
                    if (names.includes('padding') && !released) {
                        found.push({ file, line, call, why: 'passes padding without retainPadding: false' });
                    }
                    if (!names.includes('padding') && options.properties.some(ts.isSpreadAssignment)) {
                        found.push({ file, line, call, why: 'spreads its options, so a padding cannot be seen' });
                    }
                } else if (options) {
                    // A variable (`map.easeTo(cam)`) may carry a padding the parser cannot see.
                    found.push({ file, line, call, why: 'options are not a literal, so a padding cannot be seen' });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

function sourceFiles(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            out.push(...sourceFiles(rel));
        } else if (
            /\.tsx?$/.test(entry.name) &&
            !/\.(test|spec|stories)\.tsx?$/.test(entry.name) &&
            !entry.name.endsWith('.d.ts')
        ) {
            out.push(rel);
        }
    }
    return out;
}

/** The app's own files at the repo root (App.tsx, utils.ts ...): not its config. */
function rootFiles(): string[] {
    return fs
        .readdirSync(ROOT, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isFile() &&
                /\.tsx?$/.test(entry.name) &&
                !/\.(test|spec|stories|config)\.tsx?$/.test(entry.name) &&
                !entry.name.endsWith('.d.ts'),
        )
        .map((entry) => entry.name);
}

const files = [...rootFiles(), ...SCAN_DIRS.flatMap(sourceFiles)];
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('no camera move leaves its padding on the map', () => {
    it('walks the app (the Plan fit and the Obs flights are in what it reads)', () => {
        expect(files.length).toBeGreaterThan(300);
        expect(files).toContain('components/map/mapHubHelpers.ts');
        expect(files).toContain('components/map/obsCentre.ts');
        expect(files).toContain('components/map/useObsStartupCamera.ts');
        // The root and the smaller trees too (review 2026-10-08).
        expect(files).toContain('App.tsx');
        expect(files).toContain('utils.ts');
        expect(files.some((file) => file.startsWith('managers/'))).toBe(true);
        expect(files.some((file) => file.startsWith('modules/'))).toBe(true);
        expect(files).not.toContain('vite.config.ts');
    });

    // Only files that name a camera call can offend (paddingOffences flags
    // nothing else), so the TypeScript parse is skipped for the rest. Parsing
    // every file timed out at 20 s on a loaded CI runner (run 37836431282).
    it('every padded fitBounds/flyTo/easeTo/jumpTo says retainPadding: false, and nothing sets a padding', () => {
        const offences = files
            .filter((file) => !ALLOWED.has(file))
            .map((file) => [file, read(file)] as const)
            .filter(([, text]) => CAMERA_CALL_TEXT.test(text))
            .flatMap(([file, text]) => paddingOffences(file, text))
            .map((o) => `${o.file}:${o.line} ${o.call} ${o.why}`);
        expect(offences).toEqual([]);
    }, 60_000);

    it('each exemption still has a padded call to exempt', () => {
        for (const file of ALLOWED.keys()) {
            expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
            expect(paddingOffences(file, read(file)).length, `${file} no longer needs its exemption`).toBeGreaterThan(
                0,
            );
        }
    });

    it('catches the shape that leaked, and lets the released one through', () => {
        const leak = `map.fitBounds(b, { padding: { top: 90, bottom: 130, left: 300, right: 40 }, maxZoom: 15 });`;
        expect(paddingOffences('x.ts', leak)).toEqual([
            { file: 'x.ts', line: 1, call: 'fitBounds', why: 'passes padding without retainPadding: false' },
        ]);
        expect(paddingOffences('x.ts', `map.fitBounds(b, { padding: 40, retainPadding: false });`)).toEqual([]);
        expect(paddingOffences('x.ts', `map.fitBounds(b, { padding, retainPadding: true });`)).toHaveLength(1);
        expect(paddingOffences('x.ts', `m?.flyTo({ center: c, padding: 20 });`)).toHaveLength(1);
        expect(paddingOffences('x.ts', `map.easeTo({ zoom: 3, duration: 600 });`)).toEqual([]);
        expect(paddingOffences('x.ts', `map.setPadding({ left: 300 });`)).toHaveLength(1);
        expect(paddingOffences('x.ts', `map.setPadding({ ...NO_CAMERA_PADDING });`)).toEqual([]);
        expect(paddingOffences('x.ts', `map.fitBounds(b, opts);`)).toHaveLength(1);
        // Options in a variable, on any camera call (review 2026-10-08).
        const cam = `const cam = { center, zoom, padding: cardPadding };\nmap.easeTo(cam);`;
        expect(paddingOffences('x.ts', cam)).toEqual([
            { file: 'x.ts', line: 2, call: 'easeTo', why: 'options are not a literal, so a padding cannot be seen' },
        ]);
        expect(paddingOffences('x.ts', `map.flyTo(opts);`)).toHaveLength(1);
        expect(paddingOffences('x.ts', `mapRef.current?.jumpTo(camera);`)).toHaveLength(1);
        // Leaflet's own fitBounds, in a Leaflet file.
        expect(
            paddingOffences(
                'x.tsx',
                `import L from 'leaflet';\nmap.fitBounds(L.latLngBounds(p), { padding: [16, 16] });`,
            ),
        ).toEqual([]);
    });
});
