import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
it('mounts community controls inside the real Obs clear-view frame, alongside the map', () => {
    const source = ts.createSourceFile(
        'MapHub.tsx',
        readFileSync('components/map/MapHub.tsx', 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    let frame: ts.JsxElement | undefined;
    const controls: ts.Node[] = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isJsxElement(node) &&
            node.openingElement.attributes.properties.some(
                (p) =>
                    ts.isJsxAttribute(p) &&
                    p.name.getText(source) === 'ref' &&
                    p.initializer &&
                    ts.isJsxExpression(p.initializer) &&
                    p.initializer.expression?.getText(source) === 'obsFrameRef',
            )
        )
            frame = node;
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'CommunityChartNotesLayer')
            controls.push(node);
        ts.forEachChild(node, visit);
    };
    visit(source);
    expect(frame).toBeDefined();
    expect(controls).toHaveLength(1);
    expect(controls[0].pos).toBeGreaterThan(frame!.openingElement.end);
    expect(controls[0].end).toBeLessThan(frame!.closingElement.pos);
    expect(frame!.openingElement.getText(source)).toContain('data-obs-clear-view');
});
