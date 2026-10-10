/**
 * Every fit on the chart keeps its orientation (127-11a, audit A8).
 *
 * Mapbox's cameraForBounds, and so fitBounds, turns the chart to bearing 0
 * unless the call names one. On a chart turned to Course, Track or Heading up
 * that is a snap north, and the mode turns it straight back; the passage
 * overview, which re-fits on a settle, would ping-pong with it. So every
 * fitBounds and cameraForBounds in components/map names its bearing through
 * chartFitBearing (the mode's target, else the chart's own bearing).
 *
 * This guard walks the source with the TypeScript parser. It is on top of the
 * behavioural tests (tests/usePassageRouteFrame.test.tsx's ping-pong case,
 * tests/mapHubHelpers.test.ts, tests/useMapFitRequestBearing.test.tsx), never
 * instead of them. The exemptions are maps that never turn (Decision 4).
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = 'components/map';
/** Maps locked north-up for good, and why. */
const NORTH_UP_ONLY = new Map<string, string>([
    ['components/map/logMap.ts', 'the Log page’s card and track maps: north-up pictures, never the chart'],
]);

interface Fit {
    file: string;
    line: number;
    ok: boolean;
}

function fits(): Fit[] {
    const out: Fit[] = [];
    for (const name of fs.readdirSync(DIR)) {
        if (!/\.tsx?$/.test(name)) continue;
        const file = path.join(DIR, name);
        const text = fs.readFileSync(file, 'utf8');
        if (!/\b(?:fitBounds|cameraForBounds)\(/.test(text)) continue;
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                ['fitBounds', 'cameraForBounds'].includes(node.expression.name.text)
            ) {
                const options = node.arguments[1];
                const bearing =
                    options && ts.isObjectLiteralExpression(options)
                        ? options.properties.find(
                              (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'bearing',
                          )
                        : undefined;
                out.push({
                    file,
                    line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    ok:
                        !!bearing &&
                        ts.isPropertyAssignment(bearing) &&
                        /^chartFitBearing\(/.test(bearing.initializer.getText()),
                });
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return out;
}

describe('every fit on the chart names chartFitBearing', () => {
    const all = fits();
    const chartFits = all.filter((f) => !NORTH_UP_ONLY.has(f.file));

    it('finds the chart’s fits (route, trace, cell, chart catalogue, local, AvNav, track, two planner fits)', () => {
        expect(chartFits.length).toBeGreaterThanOrEqual(9);
    });

    it('none of them falls back to Mapbox’s bearing 0', () => {
        expect(chartFits.filter((f) => !f.ok).map((f) => `${f.file}:${f.line}`)).toEqual([]);
    });

    it('the north-up-only exemptions still exist, and are still fits', () => {
        for (const file of NORTH_UP_ONLY.keys()) expect(all.some((f) => f.file === file)).toBe(true);
    });
});
