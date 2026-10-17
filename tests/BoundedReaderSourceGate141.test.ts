// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveBoundedReaderSource } from '../scripts/bounded-reader-source-policy.mjs';
const read = (file: string) => readFileSync(file, 'utf8');
const gate = read('scripts/check-beta-readiness.mjs');
const ast = ts.createSourceFile('gate.mjs', gate, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const label = 'CMEMS maps fetch one verified frame with bounded ownership while routing remains no-network';
const predicate = ast.statements
    .find(
        (node) =>
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            node.expression.arguments[0] &&
            ts.isStringLiteral(node.expression.arguments[0]) &&
            node.expression.arguments[0].text === label,
    )!
    .getText(ast);
const variables = new Set([
    'cmemsGridTrust',
    'cmemsGridWrapperEntries',
    'cmemsLayerSources',
    'cmemsGridRefresh',
    'cmemsPlaybackSource',
    'useWeatherLayersSource',
    'mapHubSource',
    'mapWeatherControlsSource',
    'marinePublisherTrustTest',
    'cmemsGridRefreshTest',
    'restoreActiveLayersTest',
    'cmemsCurrentFieldSource',
    'cmemsCurrentFieldTest',
    'cmemsBoundedReadBinding',
    'cmemsBoundedReadBoundary',
    'cmemsHashBoundary',
    'cmemsFrameFetchBoundary',
    'cmemsTimingBoundary',
    'cmemsExclusivityBoundary',
    'cmemsRoutingRemoteBoundary',
]);
const declarations = ast.statements
    .filter(
        (node) =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && variables.has(d.name.text)),
    )
    .map((node) => node.getText(ast));
const helpers = ast.statements
    .filter(
        (node) => ts.isFunctionDeclaration(node) && ['includesAll', 'includesInOrder'].includes(node.name?.text ?? ''),
    )
    .map((node) => node.getText(ast));
function evaluate(changes: Record<string, string> = {}) {
    let passed: unknown;
    runInNewContext([...helpers, ...declarations, predicate].join('\n'), {
        read: (file: string) => changes[file] ?? read(file),
        resolveBoundedReaderSource,
        check: (name: string, ok: unknown) => {
            expect(name).toBe(label);
            passed = ok;
        },
    });
    return passed;
}
const cmems = 'services/weather/api/cmemsGridTrust.ts',
    body = 'services/weather/api/boundedPublisherResponse.ts';
describe('actual CMEMS source predicate follows the bounded runtime reader', () => {
    it('passes the actual complete predicate and exact import/re-export binding', () => {
        expect(evaluate()).toBe(true);
        expect(resolveBoundedReaderSource(read(cmems), read).bound).toBe(true);
    });
    it.each([
        ["from './boundedPublisherResponse.ts'", "from './unreviewedResponse.ts'"],
        ['export { MarineDataTrustError, readBoundedResponse }', 'export { MarineDataTrustError }'],
        [
            'const bytes = await readBoundedResponse(response, maxBytes, controller.signal);',
            'const bytes = await unsafeRead(response, maxBytes, controller.signal);',
        ],
        [
            'const bytes = await readBoundedResponse(response, maxBytes, controller.signal);',
            'const readBoundedResponse = () => new Uint8Array(); const bytes = await readBoundedResponse(response, maxBytes, controller.signal);',
        ],
        [
            'const bytes = await readBoundedResponse(response, maxBytes, controller.signal);',
            'const bytes = await readBoundedResponse(response, maxBytes);',
        ],
    ])('refuses a lost or replaced runtime binding: %s', (before, after) => {
        const source = read(cmems);
        expect(source).toContain(before);
        expect(evaluate({ [cmems]: source.replace(before, after) })).toBe(false);
    });
    it.each([
        'export async function readBoundedResponse',
        'Number.isSafeInteger(maxBytes)',
        'maxBytes <= 0',
        "response.headers.get('content-length')",
        'Number(declared) > maxBytes',
        'const output = new Uint8Array(maxBytes)',
        'requireTrust(total + value.byteLength <= maxBytes',
        'output.set(value, total)',
        'return total === output.byteLength ? output : output.slice(0, total)',
        'signal?.throwIfAborted()',
        'await waitForPublisherRead(reader.read(), signal,',
        'void cancelOnce()',
        'if (signal?.aborted) void cancelOnce()',
        'else await waitForPublisherRead(cancelOnce(), signal)',
        'reader.releaseLock()',
        "signal.addEventListener('abort', abort, { once: true })",
        "signal.removeEventListener('abort', abort)",
        'onAbort?.()',
        'if (signal.aborted) abort()',
    ])('keeps the actual predicate closed when a bound/allocation/cancellation clause is removed: %s', (clause) => {
        const source = read(body);
        expect(source).toContain(clause);
        expect(evaluate({ [body]: source.replaceAll(clause, 'REMOVED_CONTRACT') })).toBe(false);
    });
    it.each(['const chunks', 'new Uint8Array(total)'])(
        'retains original additional-allocation refusal: %s',
        (allocation) => {
            expect(
                evaluate({
                    [body]: read(body).replace(
                        'const output = new Uint8Array(maxBytes)',
                        `/* ${allocation} */ const output = new Uint8Array(maxBytes)`,
                    ),
                }),
            ).toBe(false);
        },
    );
});
