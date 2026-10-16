import { readFileSync } from 'node:fs';
import ts from 'typescript';

export const mapInitSource = ts.createSourceFile(
    'useMapInit.ts',
    readFileSync('components/map/useMapInit.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);

export function mapInitNodes<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node) => {
        if (predicate(node)) found.push(node);
        ts.forEachChild(node, visit);
    };
    visit(mapInitSource);
    return found;
}

export function mapInitVariable(name: string): ts.Expression {
    const matches = mapInitNodes(ts.isVariableDeclaration).filter((node) => node.name.getText(mapInitSource) === name);
    if (matches.length !== 1 || !matches[0].initializer) throw Error(`Expected one initialized ${name}`);
    return matches[0].initializer;
}

export function dependencyNames(node: ts.Node | undefined): string[] {
    if (!node || !ts.isArrayLiteralExpression(node)) throw Error('Expected explicit dependency array');
    return node.elements.map((element) => element.getText(mapInitSource));
}

export { ts };
