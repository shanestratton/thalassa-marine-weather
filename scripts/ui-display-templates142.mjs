/** Cooked display data only. Original expressions, tags, event handlers and
 * asset/program/protocol text remain source, in their original order. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import MagicString from 'magic-string';
import { isUiSourceFile, uiSourceFiles } from './static-ui-literals.mjs';

const snapshots = new Map();
const attributes = new Set([
    'className',
    'title',
    'label',
    'description',
    'placeholder',
    'aria-label',
    'aria-description',
    'alt',
]);
const forbiddenFile =
    /(?:^|\/)(?:ChatPage|readPackedUiData|readPreloadData|decodeClassNames)\.[cm]?[jt]sx?$|(?:^|\/)(?:workers?|fixtures|__tests__)\/|(?:[.-]worker|Worker)\.tsx$/;
const programOrTransport =
    /https?:\/\/|wss?:\/\/|<script|javascript:|gl_FragColor|gl_Position|#version|precision\s+(?:highp|mediump)|void\s+main\s*\(|\b(?:uniform|attribute|varying)\s+(?:vec|mat|sampler|float|int)|\b(?:const|let|var)\s+\w+\s*=|\bfunction\s*\w*\s*\(|\b(?:CREATE\s+TABLE|INSERT\s+INTO|SELECT\s+.+\s+FROM)\b|<\/?(?:gpx|trk|rte|xml)(?:\s|>)/i;

export const isUiDisplayTemplateSource = (file) => isUiSourceFile(file) && !forbiddenFile.test(file);

export function uiDisplayTemplateRows(code, file) {
    if (!isUiDisplayTemplateSource(file)) return [];
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (source.parseDiagnostics.length) return [];
    const rows = [];
    const context = (node) => {
        for (let current = node, depth = 0; current && depth < 14; current = current.parent, depth++) {
            if (ts.isTaggedTemplateExpression(current) || ts.isThrowStatement(current)) return null;
            // Callees can interpret ordinary prose as prompt/program data.
            // Qualify only the JSX sink, never a call inferred from its name.
            if (ts.isCallExpression(current) || ts.isNewExpression(current)) return null;
            if (ts.isJsxExpression(current)) {
                if (ts.isJsxAttribute(current.parent)) {
                    const name = current.parent.name.getText(source);
                    return attributes.has(name) ? `attribute:${name}` : null;
                }
                return 'children';
            }
            if (ts.isPropertyAssignment(current)) return null;
        }
        return null;
    };
    function visit(node) {
        if (
            ts.isImportDeclaration(node) ||
            ts.isExportDeclaration(node) ||
            ts.isTaggedTemplateExpression(node) ||
            (ts.isJsxAttribute(node) && !attributes.has(node.name.getText(source)))
        )
            return;
        if (ts.isJsxElement(node) && /^(?:script|style)$/i.test(node.openingElement.tagName.getText(source))) return;
        if (
            (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
            /^(?:URL|Worker|SharedWorker|importScripts|import|import\.meta\.glob(?:Eager)?)$/.test(
                node.expression.getText(source),
            )
        )
            return;
        if (
            (ts.isNoSubstitutionTemplateLiteral(node) ||
                ts.isTemplateHead(node) ||
                ts.isTemplateMiddle(node) ||
                ts.isTemplateTail(node)) &&
            node.text.length >= 40 &&
            node.text.length <= 4096 &&
            !programOrTransport.test(node.text)
        ) {
            const usage = context(node);
            if (usage) {
                const quasi = !ts.isNoSubstitutionTemplateLiteral(node);
                rows.push({
                    value: node.text,
                    start: node.getStart(source) + (quasi ? 1 : 0),
                    end: node.end - (quasi ? (ts.isTemplateTail(node) ? 1 : 2) : 0),
                    quasi,
                    context: usage,
                });
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return rows;
}

export function collectUiDisplayTemplateCounts(root) {
    const sources = uiSourceFiles(root)
        .map((file) => file.replaceAll('\\', '/'))
        .filter(isUiDisplayTemplateSource)
        .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
    const hash = createHash('sha256');
    for (const row of sources) hash.update(JSON.stringify(row));
    const key = hash.digest('hex');
    if (snapshots.has(key)) return new Map(snapshots.get(key));
    const counts = new Map();
    for (const [file, code] of sources)
        for (const row of uiDisplayTemplateRows(code, file)) counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
    if (snapshots.size >= 2) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(key, counts);
    return new Map(counts);
}

export function rewriteUiDisplayTemplates(code, file, values) {
    const rows = uiDisplayTemplateRows(code, file);
    if (!rows.length) return null;
    const indexes = new Map(values.map((value, index) => [value, index]));
    const output = new MagicString(code),
        rewrites = [];
    const identifiers = new Set();
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
        if (ts.isIdentifier(node)) identifiers.add(node.text);
        ts.forEachChild(node, visit);
    };
    visit(source);
    let binding = '__thalassaUiDisplayTemplates';
    while (code.includes(binding) || identifiers.has(binding)) binding += '_';
    for (const row of rows) {
        const index = indexes.get(row.value);
        if (index === undefined) continue;
        const expression = `${binding}[${index}]`;
        const replacement = row.quasi ? '${' + expression + '}' : expression;
        output.overwrite(row.start, row.end, replacement);
        rewrites.push({ ...row, original: code.slice(row.start, row.end), replacement });
    }
    if (!rewrites.length) return null;
    const prelude = `import {values as ${binding}} from 'virtual:thalassa-ui-strings';\n`;
    output.prepend(prelude);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        prelude,
        rewrites,
        binding,
    };
}
