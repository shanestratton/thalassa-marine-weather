// @vitest-environment node
/**
 * Every map that draws the ENC chart builds it with the main chart's
 * collision settings (build 123, package HM review).
 *
 * The chart's guarantees that a label never takes a mark off the chart (W1-FX
 * for lights and buoys, HM for wrecks, rocks and obstructions) are made by
 * stacking order WITHIN one source: a mark and the names that must give way to
 * it share a source, and the mark sits higher. That only holds when each
 * source has its own collision graph, i.e. the map was built with
 * crossSourceCollisions off. With Mapbox's default (on), every text layer from
 * another source that sits above the hazards (navaid names, lead names, VHF
 * badges, a planner's waypoint numbers) is placed first and can cull a
 * hazard mark. Measured on the auto-route trial map, which kept the default:
 * a fictional buoy's name took a 2 m rock off the chart in Chromium and WebKit
 * at z13 to z16.
 *
 * So: find every production file that mounts the ENC layers, follow it to the
 * file that constructs its map, and require that construction to pass
 * crossSourceCollisions: false and fadeDuration: 0 (useMapInit's settings). A
 * new map that mounts the chart fails here until it does the same.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

/** The ENC layer implementation itself: it mounts on a map it is handed. */
const ENC_IMPLEMENTATION = new Set(['components/map/EncVectorLayer.ts', 'components/map/useEncVectorLayer.ts']);

/** Mount sites whose map is constructed in another file. */
const MAP_BUILT_ELSEWHERE: Record<string, string> = {
    'components/map/MapHub.tsx': 'components/map/useMapInit.ts',
};

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.claude',
    'ios',
    'android',
    'dist',
    'public',
    'tests',
    'e2e',
    'browser-tests',
    'stories',
    'supabase',
    'output',
    'test-results',
    'coverage',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (!SKIP_DIRS.has(name) && !name.startsWith('.')) sourceFiles(path, out);
        } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
            out.push(relative(ROOT, path));
        }
    }
    return out;
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The argument text of every `new mapboxgl.Map(...)` in a file. */
function mapConstructions(text: string): string[] {
    const out: string[] = [];
    const opener = /new\s+mapboxgl\.Map\s*\(/g;
    for (let m = opener.exec(text); m; m = opener.exec(text)) {
        let depth = 1;
        let i = m.index + m[0].length;
        for (; i < text.length && depth > 0; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') depth--;
        }
        out.push(text.slice(m.index + m[0].length, i - 1));
    }
    return out;
}

const files = sourceFiles(ROOT);
const mountSites = files
    .filter((file) => !ENC_IMPLEMENTATION.has(file))
    .filter((file) => /\b(useEncVectorLayer|mountEncVectorLayer)\s*\(/.test(withoutComments(read(file))));

describe('every map that draws the ENC chart collides by source', () => {
    it('finds the chart’s mount sites (the walk is not empty)', () => {
        expect(mountSites).toEqual(
            expect.arrayContaining([
                'components/map/MapHub.tsx',
                'components/autorouting/AutoroutingTrialWorkspace.tsx',
            ]),
        );
    });

    it('each mount site is traced to the file that builds its map', () => {
        for (const site of mountSites) {
            const builder = MAP_BUILT_ELSEWHERE[site] ?? site;
            expect(
                mapConstructions(withoutComments(read(builder))).length,
                `${site}: map built in ${builder}`,
            ).toBeGreaterThan(0);
        }
        // No stale entry: every listed builder is still a mount site's.
        for (const site of Object.keys(MAP_BUILT_ELSEWHERE)) expect(mountSites, site).toContain(site);
    });

    it('that map turns cross-source collisions off and the fade with them, as the main chart does', () => {
        for (const site of mountSites) {
            const builder = MAP_BUILT_ELSEWHERE[site] ?? site;
            for (const options of mapConstructions(withoutComments(read(builder)))) {
                expect(options, `${builder} (mounts the chart via ${site})`).toMatch(
                    /\bcrossSourceCollisions\s*:\s*false\b/,
                );
                expect(options, `${builder} (mounts the chart via ${site})`).toMatch(/\bfadeDuration\s*:\s*0\b/);
            }
        }
    });
});
