/** Exact authored CSS data only. No stylesheet is installed here; the original
 * assignment/render remains in its original lazy module and evaluation order. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parse as parseJs } from 'acorn';
import { analyze } from 'eslint-scope';
import { STATIC_CSS_SOURCES142 } from './static-css-sources142.mjs';

const valid = (value) =>
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 8192 &&
    !value.split(' ').some((word) => word.length > 4096);
const forbidden = /(?:^|\/)(?:readPackedUiData|readPreloadData|decodeClassNames)\.[cm]?[jt]s$|(?:^|\/)ChatPage\.tsx$/;

/** Resolve a lexical const, including repeated `style` names in other blocks. */
function sourceStyleVariable(id, source) {
    for (let current = id.parent; current; current = current.parent) {
        if (ts.isBlock(current) || ts.isSourceFile(current)) {
            for (const statement of current.statements) {
                if (!ts.isVariableStatement(statement)) continue;
                for (const declaration of statement.declarationList.declarations) {
                    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== id.text) continue;
                    const init = declaration.initializer;
                    return !!(
                        statement.declarationList.flags & ts.NodeFlags.Const &&
                        init &&
                        ts.isCallExpression(init) &&
                        init.expression.getText(source) === 'document.createElement' &&
                        init.arguments[0] &&
                        ts.isStringLiteral(init.arguments[0]) &&
                        init.arguments[0].text === 'style'
                    );
                }
            }
        }
        if (
            ts.isFunctionLike(current) &&
            current.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === id.text)
        )
            return false;
    }
    return false;
}

/** Compiler-cooked CSS literals/quasis. Dynamic expressions are never visited. */
export function staticCssSourceRows(code, file) {
    const source = ts.createSourceFile(
        file,
        code,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const rows = [];
    const add = (node) => {
        if (valid(node.text)) rows.push({ value: node.text, literal: ts.isStringLiteral(node) });
    };
    const fragments = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node);
        else if (ts.isTemplateExpression(node)) {
            add(node.head);
            for (const span of node.templateSpans) add(span.literal);
        }
    };
    function visit(node) {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(node.left)
        ) {
            const left = node.left;
            if (
                (left.name.text === 'cssText' &&
                    ts.isPropertyAccessExpression(left.expression) &&
                    left.expression.name.text === 'style') ||
                (left.name.text === 'textContent' &&
                    ts.isIdentifier(left.expression) &&
                    sourceStyleVariable(left.expression, source))
            )
                fragments(node.right);
        }
        if (
            ts.isJsxExpression(node) &&
            node.expression &&
            ts.isJsxElement(node.parent) &&
            node.parent.openingElement.tagName.getText(source) === 'style'
        )
            fragments(node.expression);
        ts.forEachChild(node, visit);
    }
    visit(source);
    return rows;
}

export function collectStaticCssCounts(root) {
    const counts = new Map();
    for (const [file, spec] of Object.entries(STATIC_CSS_SOURCES142)) {
        if (forbidden.test(file)) throw Error('A bootstrap/private source cannot own packed CSS');
        const target = path.join(root, file);
        if (!fs.existsSync(target)) continue; // Isolated test roots need no application sources.
        const code = assertStaticCssSource(root, file);
        const rows = staticCssSourceRows(code, file);
        if (rows.length !== spec.literals) throw Error(`Unreviewed static CSS inventory: ${file}`);
        for (const row of rows) {
            // Ordinary TSX string literals already occur in the original UI
            // count; expression-free templates/quasis and .ts CSS are new.
            if (!row.literal || !file.endsWith('.tsx')) counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
        }
    }
    return counts;
}

export function isStaticCssSource(file) {
    return !forbidden.test(file) && Object.hasOwn(STATIC_CSS_SOURCES142, file);
}

export function assertStaticCssSource(root, file) {
    if (!isStaticCssSource(file)) throw Error('Unreviewed static CSS owner');
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    if (createHash('sha256').update(code.replaceAll('\r\n', '\n')).digest('hex') !== STATIC_CSS_SOURCES142[file].sha256)
        throw Error(`Unreviewed static CSS source: ${file}`);
    return code;
}

/** Post-JSX grammar counterpart. Scope identity proves actual style-element
 * variables and imported React helpers; similarly named/shadowed values stay. */
export function compiledCssRanges(code) {
    const program = parseJs(code, { ecmaVersion: 'latest', sourceType: 'module', ranges: true });
    const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false });
    const resolved = new WeakMap();
    for (const scope of scopes.scopes)
        for (const reference of scope.references) resolved.set(reference.identifier, reference.resolved);
    const helperVariables = new Set();
    for (const scope of scopes.scopes)
        for (const variable of scope.variables)
            for (const definition of variable.defs) {
                if (
                    definition.type === 'ImportBinding' &&
                    definition.parent?.source?.value === 'react/jsx-runtime' &&
                    definition.node.type === 'ImportSpecifier' &&
                    ['jsx', 'jsxs'].includes(definition.node.imported.name)
                )
                    helperVariables.add(variable);
            }
    const styleVariable = (node) => {
        const variable = resolved.get(node);
        if (!variable || variable.defs.length !== 1 || variable.references.some((r) => r.isWrite() && !r.init))
            return false;
        const definition = variable.defs[0],
            init = definition.node.init;
        return (
            definition.type === 'Variable' &&
            definition.parent.kind === 'const' &&
            init?.type === 'CallExpression' &&
            init.callee.type === 'MemberExpression' &&
            !init.callee.computed &&
            init.callee.object.type === 'Identifier' &&
            init.callee.object.name === 'document' &&
            !resolved.get(init.callee.object) &&
            init.callee.property.name === 'createElement' &&
            init.arguments.length === 1 &&
            init.arguments[0].type === 'Literal' &&
            init.arguments[0].value === 'style'
        );
    };
    const ranges = [];
    const fragments = (node) => {
        if (node?.type === 'Literal' && valid(node.value))
            ranges.push({ start: node.start, end: node.end, value: node.value, quasi: false });
        else if (node?.type === 'TemplateLiteral') {
            if (!node.expressions.length) {
                const value = node.quasis[0].value.cooked;
                if (valid(value)) ranges.push({ start: node.start, end: node.end, value, quasi: false });
            } else
                for (const quasi of node.quasis) {
                    if (valid(quasi.value.cooked))
                        ranges.push({ start: quasi.start, end: quasi.end, value: quasi.value.cooked, quasi: true });
                }
        }
    };
    function visit(node) {
        if (!node || typeof node.type !== 'string' || node.type === 'TaggedTemplateExpression') return;
        if (
            node.type === 'AssignmentExpression' &&
            node.operator === '=' &&
            node.left.type === 'MemberExpression' &&
            !node.left.computed
        ) {
            const left = node.left;
            if (
                (left.property.name === 'cssText' &&
                    left.object.type === 'MemberExpression' &&
                    !left.object.computed &&
                    left.object.property.name === 'style') ||
                (left.property.name === 'textContent' &&
                    left.object.type === 'Identifier' &&
                    styleVariable(left.object))
            )
                fragments(node.right);
        }
        if (
            node.type === 'CallExpression' &&
            !node.optional &&
            node.callee.type === 'Identifier' &&
            helperVariables.has(resolved.get(node.callee)) &&
            node.arguments[0]?.type === 'Literal' &&
            node.arguments[0].value === 'style' &&
            node.arguments[1]?.type === 'ObjectExpression'
        ) {
            const properties = node.arguments[1].properties;
            if (
                properties.every((p) => p.type === 'Property' && !p.computed && !p.method && p.kind === 'init') &&
                new Set(properties.map((p) => p.key.name ?? p.key.value)).size === properties.length
            )
                for (const property of properties)
                    if ((property.key.name ?? property.key.value) === 'children') fragments(property.value);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) for (const child of value) visit(child);
            else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(program);
    return ranges;
}
