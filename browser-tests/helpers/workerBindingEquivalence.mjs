/** Independent test-only AST proof. Acorn + ESLint's scope resolver permit
 * lexical binding renames only; executable structure/properties/literals and
 * free/global names remain exact. No transformed code is ever executed here. */
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function normalize(code) {
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', ranges: true });
    const manager = analyze(ast, { ecmaVersion: 2022, sourceType: 'script', optimistic: false, ignoreEval: false });
    const bindings = new WeakMap(),
        labels = new WeakMap(),
        names = [];
    for (const [scopeIndex, scope] of manager.scopes.entries()) {
        for (const [variableIndex, variable] of scope.variables.entries()) {
            // Script-level bindings can be visible as global properties.
            if (scope.type === 'global') continue;
            const token = `@scope${scopeIndex}:binding${variableIndex}`;
            names.push({ token, name: variable.name });
            for (const id of variable.identifiers) bindings.set(id, token);
            for (const reference of variable.references)
                if (reference.resolved === variable) bindings.set(reference.identifier, token);
        }
    }
    let labelIndex = 0;
    function labelWalk(node, stack = []) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach((value) => labelWalk(value, stack));
        if (
            node.type === 'WithStatement' ||
            (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'eval')
        )
            throw Error('Dynamic scope cannot be certified');
        let nested = stack;
        if (node.type === 'LabeledStatement') {
            const token = `@label${labelIndex++}`;
            labels.set(node.label, token);
            nested = [...stack, { name: node.label.name, token }];
        } else if (['BreakStatement', 'ContinueStatement'].includes(node.type) && node.label) {
            const target = [...stack].reverse().find((value) => value.name === node.label.name);
            if (!target) throw Error('Unresolved lexical label');
            labels.set(node.label, target.token);
        }
        for (const [key, value] of Object.entries(node))
            if (!['start', 'end', 'range', 'loc'].includes(key)) labelWalk(value, nested);
    }
    labelWalk(ast);
    function canonical(node, parent, key) {
        if (typeof node === 'bigint') return { bigintValue: node.toString() };
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map((value) => canonical(value, parent, key));
        const output = {};
        for (const field of Object.keys(node).sort()) {
            if (['start', 'end', 'range', 'loc'].includes(field)) continue;
            if (node.type === 'Literal' && field === 'raw') continue;
            // Shorthand syntax may expand when its value binding is renamed;
            // its original uncomputed property key is still compared exactly.
            if (node.type === 'Property' && field === 'shorthand') continue;
            if (node.type === 'Identifier' && field === 'name') {
                const propertyKey =
                    key === 'key' &&
                    parent &&
                    ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) &&
                    !parent.computed;
                const memberKey = key === 'property' && parent?.type === 'MemberExpression' && !parent.computed;
                output[field] =
                    propertyKey || memberKey ? node.name : (labels.get(node) ?? bindings.get(node) ?? node.name);
            } else output[field] = canonical(node[field], node, field);
        }
        return output;
    }
    const tree = JSON.stringify(canonical(ast, undefined, undefined));
    return { tree, hash: hash(tree), names };
}
/** @param {string} original @param {string} packed */
export function compareWorkerBindings(original, packed) {
    const left = normalize(original),
        right = normalize(packed);
    return {
        equivalent: left.tree === right.tree,
        byteIdentical: original === packed,
        originalSha256: hash(original),
        packedSha256: hash(packed),
        originalAstSha256: left.hash,
        packedAstSha256: right.hash,
        bindings: left.names.length,
        renamedBindings: left.names.filter((value, index) => value.name !== right.names[index]?.name).length,
    };
}
