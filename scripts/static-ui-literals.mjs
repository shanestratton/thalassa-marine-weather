/** The existing UI candidate grammar, shared by the two build-only collectors.
 * Reading compiler-cooked JSX text preserves its whitespace/entity semantics. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

// Build-only and content-addressed, never a file-time or application cache.
// At most two exact source cohorts are retained; callers get isolated Maps.
const snapshots = new Map();

export const isUiSourceFile = (name) =>
    /^(?:App\.tsx|(?:components|pages)\/.*\.tsx)$/.test(name) &&
    !/(?:^|\/)(?:__tests__|fixtures)\/|\.(?:test|spec)\.tsx$/.test(name);

export function uiSourceFiles(root) {
    return ['App.tsx', ...fs.globSync(['components/**/*.tsx', 'pages/**/*.tsx'], { cwd: root })]
        .sort()
        .filter((file) => isUiSourceFile(file.replaceAll('\\', '/')) && fs.existsSync(path.join(root, file)));
}

export function collectUiLiteralCounts(root) {
    const sources = uiSourceFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
    const digest = createHash('sha256');
    for (const row of sources) digest.update(JSON.stringify(row));
    const key = digest.digest('hex');
    const cached = snapshots.get(key);
    if (cached) return new Map(cached);
    const counts = new Map();
    for (const [file, code] of sources) {
        const compiled = ts.transpileModule(code, {
            fileName: file,
            compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText;
        const source = ts.createSourceFile(file, compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        function visit(node) {
            if (ts.isStringLiteral(node)) {
                const parent = node.parent;
                const symbol =
                    (ts.isPropertyAssignment(parent) && parent.name === node) ||
                    ts.isLiteralTypeNode(parent) ||
                    ts.isImportDeclaration(parent) ||
                    ts.isExportDeclaration(parent) ||
                    ts.isExternalModuleReference(parent) ||
                    ts.isTaggedTemplateExpression(parent) ||
                    (ts.isNewExpression(parent) &&
                        ['URL', 'Worker', 'SharedWorker'].includes(parent.expression.getText(source)));
                if (!symbol && node.text.length >= 20) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    if (snapshots.size >= 2) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(key, counts);
    return new Map(counts);
}
