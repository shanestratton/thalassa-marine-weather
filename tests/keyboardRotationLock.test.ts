/**
 * The north-up lock has no keyboard hole (127-11a, Decision 4).
 *
 * Shane 2026-05-18: "prevent the earth from rotating on the chart page"
 * (22cddd47c locked every gesture). Mapbox's keyboard handler is on by
 * default and turns a map 15° per Shift+left/right unless
 * `map.keyboard.disableRotation()` is called, and no map called it: on the
 * desktop web chart, click the map, press Shift+left, and the chart turned
 * with nothing on screen to turn it back. Every map that locks the twist now
 * locks the keyboard beside it.
 *
 * Behavioural checks: tests/logMap.test.ts (the Log maps) and
 * tests/chartTurnsMapInit.test.tsx (the chart). This walks the rest: any
 * file that calls touchZoomRotate.disableRotation() must also call
 * keyboard.disableRotation(), once per map.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['components', 'hooks', 'src', 'pages'];
/** Not yet, and why. */
const LATER = new Map<string, string>([
    [
        'components/autorouting/AutoroutingTrialWorkspace.tsx',
        '127-11b: its one line lands after 127-PYD-3 rewrites the day-plan mode (schedule, lane 3)',
    ],
]);

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** Calls in code only: a comment that names the lock is not a lock. */
const count = (text: string, re: RegExp) =>
    [
        ...text
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '')
            .matchAll(re),
    ].length;
const TWIST = /\btouchZoomRotate\??\.disableRotation\(\)/g;
const KEYS = /\bkeyboard\??\.disableRotation\(\)/g;

describe('every map that locks the twist locks Shift+arrows too', () => {
    const files = ROOTS.flatMap((root) => walk(root)).filter((file) => count(fs.readFileSync(file, 'utf8'), TWIST) > 0);

    it('finds the maps: the chart, the Log maps, the Ocean page and the chat pin viewer', () => {
        for (const file of [
            'components/map/useMapInit.ts',
            'components/map/logMap.ts',
            'src/ocean/OceanMap.tsx',
            'components/chat/PinMapViewer.tsx',
        ]) {
            expect(files).toContain(file);
        }
    });

    it('each locks the keyboard’s turn as often as the twist', () => {
        const holes = files
            .filter((file) => !LATER.has(file))
            .filter((file) => {
                const text = fs.readFileSync(file, 'utf8');
                return count(text, KEYS) < count(text, TWIST);
            });
        expect(holes).toEqual([]);
    });
});
