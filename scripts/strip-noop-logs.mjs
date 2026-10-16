/**
 * strip-noop-logs — production builds drop the app logger's info() and debug() calls.
 *
 * utils/createLogger.ts makes debug() and info() one shared no-op when
 * import.meta.env.PROD is true: no console, no Sentry breadcrumb, no buffer,
 * nothing a "send logs" screen could read (services/sentry.ts drops console
 * breadcrumbs in production too). Yet every call site still shipped its
 * message strings and template literals: about 9.9 KB in the chart chunk alone
 * (measured in 127). esbuild's `pure` list (vite.config.ts) cannot reach them,
 * because it only matches globals like `console.info`, and `log` is a module
 * binding.
 *
 * So this marks each `log.info(...)` / `log.debug(...)` call /* @__PURE__ *\/,
 * where `log` is a module-level `const log = createLogger(...)` imported from
 * the app's own utils/createLogger (not pi-cache's, not anything else), and
 * the name is bound nowhere else in the file. A pure call whose value is
 * unused is removed, but any argument that could have a side effect (a call,
 * a property read) is kept and still runs, so behaviour cannot change: the
 * call itself did nothing. warn() and error() are never touched; device
 * failures rely on warn(). The createLogger(...) call is marked too, so a
 * logger left with nothing to do goes as well.
 *
 * tests/StripNoopLogs.test.ts; wired as stripNoopLogs() in vite.config.ts.
 */
import path from 'node:path';

export const NOOP_LOG_METHODS = new Set(['info', 'debug']);
const LOGGER_MODULE = 'utils/createLogger';
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;

function walk(node, visit, parent = null) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parent);
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, node);
        } else if (value && typeof value.type === 'string') {
            walk(value, visit, node);
        }
    }
}

/** Every name a pattern binds: `a`, `{ a, b: c }`, `[a, ...b]`, `a = 1`. */
function patternNames(pattern, out) {
    if (!pattern) return;
    switch (pattern.type) {
        case 'Identifier':
            out.push(pattern.name);
            break;
        case 'ObjectPattern':
            for (const property of pattern.properties)
                patternNames(property.type === 'RestElement' ? property.argument : property.value, out);
            break;
        case 'ArrayPattern':
            for (const element of pattern.elements) patternNames(element, out);
            break;
        case 'RestElement':
            patternNames(pattern.argument, out);
            break;
        case 'AssignmentPattern':
            patternNames(pattern.left, out);
            break;
        default:
            break;
    }
}

/** How many times each name is declared anywhere in the module. */
export function bindingCounts(program) {
    const counts = new Map();
    const add = (names) => {
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    walk(program, (node) => {
        const names = [];
        switch (node.type) {
            case 'VariableDeclarator':
                patternNames(node.id, names);
                break;
            case 'FunctionDeclaration':
            case 'FunctionExpression':
            case 'ArrowFunctionExpression':
                if (node.id) names.push(node.id.name);
                for (const param of node.params) patternNames(param, names);
                break;
            case 'ClassDeclaration':
            case 'ClassExpression':
                if (node.id) names.push(node.id.name);
                break;
            case 'CatchClause':
                patternNames(node.param, names);
                break;
            case 'ImportSpecifier':
            case 'ImportDefaultSpecifier':
            case 'ImportNamespaceSpecifier':
                names.push(node.local.name);
                break;
            default:
                break;
        }
        add(names);
    });
    return counts;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value) {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1;
    let out = '';
    do {
        let digit = rest & 31;
        rest >>>= 5;
        if (rest > 0) digit |= 32;
        out += BASE64[digit];
    } while (rest > 0);
    return out;
}

/**
 * Insert `text` at each offset (none spans a newline) and say where every
 * token went: a source map with a segment at each token boundary, as
 * MagicString's hires 'boundary' gives, so Sentry's columns stay exact.
 */
export function insertAt(code, offsets, text, source) {
    const sorted = [...new Set(offsets)].sort((a, b) => a - b);
    let out = '';
    let last = 0;
    for (const offset of sorted) {
        out += code.slice(last, offset) + text;
        last = offset;
    }
    out += code.slice(last);

    const lines = code.split('\n');
    const mappings = [];
    let lineStart = 0;
    let next = 0;
    let previousColumn = 0;
    let previousLine = 0;
    lines.forEach((line, lineIndex) => {
        const segments = [];
        let shift = 0;
        let generatedColumn = 0;
        for (let column = 0; column < line.length; column++) {
            while (next < sorted.length && sorted[next] === lineStart + column) {
                shift += text.length;
                next++;
            }
            const char = line[column];
            const word = /[\w$]/.test(char);
            const boundary =
                column === 0 || (char !== ' ' && char !== '\t' && !(word && /[\w$]/.test(line[column - 1])));
            if (!boundary) continue;
            const generated = column + shift;
            segments.push(
                vlq(generated - generatedColumn) + 'A' + vlq(lineIndex - previousLine) + vlq(column - previousColumn),
            );
            generatedColumn = generated;
            previousLine = lineIndex;
            previousColumn = column;
        }
        while (next < sorted.length && sorted[next] <= lineStart + line.length) next++;
        mappings.push(segments.join(','));
        lineStart += line.length + 1;
    });
    return { code: out, map: { version: 3, sources: [source], names: [], mappings: mappings.join(';') } };
}

function isAppLogger(source, id, root) {
    if (source === `@/${LOGGER_MODULE}`) return true;
    if (!source.startsWith('.')) return false;
    // Both sides through path.resolve, so a POSIX-style root on Windows gets the same drive letter.
    const slashed = (file) => file.replaceAll('\\', '/');
    const resolved = slashed(path.resolve(path.dirname(id), source)).replace(SOURCE, '');
    return resolved === slashed(path.resolve(root, LOGGER_MODULE));
}

/**
 * Mark the module's no-op logger calls pure. `parse` is Rollup's (the plugin
 * passes this.parse; tests pass rollup/parseAst). Returns null when nothing
 * changes.
 *
 * @param {string} code JavaScript, after TypeScript and JSX are compiled away
 * @param {string} id the module's file path (a ?query is ignored)
 * @param {{ parse: (code: string) => any, root: string }} options
 * @returns {{ code: string, map: { version: number, sources: string[], names: string[], mappings: string }, calls: number } | null}
 */
export function markNoopLogCalls(code, id, { parse, root }) {
    const file = id.split('?')[0];
    if (!code.includes('createLogger') || !SOURCE.test(file) || file.includes('/node_modules/')) return null;
    const program = parse(code);

    const factories = new Set();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration' || !isAppLogger(String(node.source.value), file, root)) continue;
        for (const specifier of node.specifiers) {
            if (
                specifier.type === 'ImportSpecifier' &&
                (specifier.imported.name ?? specifier.imported.value) === 'createLogger'
            ) {
                factories.add(specifier.local.name);
            }
        }
    }
    if (factories.size === 0) return null;

    const loggers = new Map();
    for (const statement of program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
        for (const declarator of declaration.declarations) {
            const init = declarator.init;
            if (
                declarator.id.type === 'Identifier' &&
                init?.type === 'CallExpression' &&
                init.callee.type === 'Identifier' &&
                factories.has(init.callee.name)
            ) {
                loggers.set(declarator.id.name, init);
            }
        }
    }
    const counts = bindingCounts(program);
    for (const name of [...loggers.keys()]) {
        // Shadowed anywhere (a parameter, a local, a catch): leave the file's
        // calls on that name alone rather than guess which binding they mean.
        if ((counts.get(name) ?? 0) !== 1) loggers.delete(name);
    }
    if (loggers.size === 0) return null;

    const offsets = [];
    walk(program, (node) => {
        if (node.type !== 'CallExpression' || node.optional) return;
        const callee = node.callee;
        if (
            callee.type === 'MemberExpression' &&
            !callee.computed &&
            !callee.optional &&
            callee.object.type === 'Identifier' &&
            loggers.has(callee.object.name) &&
            callee.property.type === 'Identifier' &&
            NOOP_LOG_METHODS.has(callee.property.name)
        ) {
            offsets.push(node.start);
        }
    });
    const calls = offsets.length;
    if (calls === 0) return null;
    for (const init of loggers.values()) offsets.push(init.start);
    return { ...insertAt(code, offsets, '/* @__PURE__ */ ', file), calls };
}

/**
 * The Vite plugin: production builds only, where createLogger's info() and
 * debug() are the no-op (import.meta.env.PROD is true exactly when
 * config.isProduction is).
 *
 * @param {string} root the app's root directory
 * @returns {import('vite').Plugin}
 */
export function stripNoopLogs(root) {
    let enabled = false;
    let total = 0;
    return {
        name: 'strip-noop-logs',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            enabled = config.isProduction;
        },
        transform(code, id) {
            if (!enabled) return null;
            const result = markNoopLogCalls(code, id, { parse: (source) => this.parse(source), root });
            if (!result) return null;
            total += result.calls;
            return { code: result.code, map: result.map };
        },
        buildEnd() {
            if (enabled) this.info(`marked ${total} no-op log.info/log.debug calls pure`);
        },
    };
}
