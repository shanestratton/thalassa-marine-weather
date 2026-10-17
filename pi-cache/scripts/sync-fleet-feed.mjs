/** One dependency-free wire for phone, Pi and ingest; no runtime activation. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw Error('Unsupported AIS fleet mirror argument');
const source = fs.readFileSync(path.join(root, 'utils/aisFleetForwarding.ts'), 'utf8').replaceAll('\r\n', '\n');
const tree = ts.createSourceFile('aisFleetForwarding.ts', source, ts.ScriptTarget.Latest, true);
function visit(node) {
    if (
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
        (ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
    )
        throw Error('AIS fleet wire must be dependency free');
    ts.forEachChild(node, visit);
}
visit(tree);
for (const file of ['pi-cache/src/fleetFeedWire.ts', 'workers/ais-ingest/fleetForwardingWire.ts']) {
    const target = path.join(root, file);
    if (process.argv.includes('--check')) {
        if (fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== source)
            throw Error('AIS fleet wire mirror drift: ' + file);
    } else fs.writeFileSync(target, source);
}
console.info(
    JSON.stringify({ mirrorSha256: createHash('sha256').update(source).digest('hex'), files: 3, activated: false }),
);
