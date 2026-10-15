// @vitest-environment node
/**
 * Build 131, package 131-01: what a phone loads to start, and what waits until
 * it is used. Lazy loading changes start-up, not the JavaScript total (every
 * .js file ships), so these pins guard the import graph, not the bundle size.
 *
 *  - The boat link (services/boatLink/BoatLinkService) is reached through its
 *    gate only, which loads it for a boat with a Pi paired or a gateway saved,
 *    or when a screen about it opens. Before this package seven modules
 *    imported it statically, and the System status button in the header
 *    started its 2 s tick on every phone.
 *  - The passage pane loads when it has something to show.
 *  - The Diary's video trimmer (and mp4box with it) loads when a movie needs it.
 *
 * It walks the source rather than a list of the files that were changed, so a
 * new static importer fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['components', 'services', 'utils', 'hooks', 'stores', 'pages', 'context', 'contexts', 'src'];

function sourceFiles(dir: string, out: string[] = []): string[] {
    let entries: string[] = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const entry of entries) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) sourceFiles(p, out);
        else if (/\.(ts|tsx)$/.test(p) && !/\.test\.|\.spec\./.test(p)) out.push(p.split(sep).join('/'));
    }
    return out;
}

/** Code without its comments: the explanations name the modules on purpose. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const files = [
    ...ROOTS.flatMap((root) => sourceFiles(root)),
    'App.tsx',
    'ApplicationShell.tsx',
    'index.tsx',
    'viewRegistry.tsx',
]
    .filter((path, i, all) => all.indexOf(path) === i)
    .map((path) => ({ path, text: code(readFileSync(path, 'utf8')) }));
const read = (path: string) => readFileSync(path, 'utf8');

/** Static value imports of a module (`import type` is erased and does not count). */
function staticImporters(module: RegExp): string[] {
    return files
        .filter((f) =>
            [...f.text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].some((m) =>
                module.test(m[1]),
            ),
        )
        .map((f) => f.path)
        .sort();
}

describe('the boat link loads only when there is a boat (131-01)', () => {
    it('finds the source it is guarding', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(files.some((f) => f.path === 'services/boatLink/boatLinkGate.ts')).toBe(true);
    });

    it('no module imports BoatLinkService statically', () => {
        expect(staticImporters(/(^|\/)BoatLinkService$/)).toEqual([]);
    });

    it('only the gate loads it, and the voyage log at a voyage start, both by dynamic import', () => {
        const loaders = files
            .filter((f) => /import\(\s*['"][^'"]*\/BoatLinkService['"]\s*\)/.test(f.text))
            .map((f) => f.path)
            .sort();
        expect(loaders).toEqual(['services/ShipLogService.ts', 'services/boatLink/boatLinkGate.ts']);
    });

    it('the seven that imported it statically on build 130 read it through the gate', () => {
        for (const path of [
            'components/SystemStatusButton.tsx',
            'services/InstrumentSourcePolicy.ts',
            'services/shiplog/trackSourceInputs.ts',
            'components/map/MapboxVelocityOverlay.tsx',
            'hooks/useBoatLink.ts',
        ]) {
            expect(read(path), path).toMatch(/from '[./]*(services\/)?boatLink\/boatLinkGate'/);
        }
        // The hook's four screens: Vessel, the Instrument Panel, Remote Access, the NMEA Gateway page.
        for (const path of [
            'components/VesselHub.tsx',
            'components/nmea/TheGlassPage.tsx',
            'components/settings/RemoteAccessSection.tsx',
            'components/vessel/NmeaPage.tsx',
        ]) {
            expect(read(path), path).toContain("hooks/useBoatLink'");
        }
    });

    it('the under-way watch reaches the boat link through the gate, by dynamic import', () => {
        const watch = code(read('services/underway/UnderwayAlarmWatch.ts'));
        expect(watch).toContain("import('../boatLink/boatLinkGate')");
        expect(watch).toContain('const boatLink = gate?.boatLinkIfConfigured();');
    });

    it('Smart Polars asks the same "boat link set up" question (126-B6a’s follow-up)', () => {
        const polars = code(read('components/settings/SmartPolarsSetting.tsx'));
        expect(polars).toContain('const blocked = !enabled && !boatLinkConfigured();');
        expect(polars).not.toMatch(/getPairing\(\) !== null \|\|/);
    });

    it('the screens say "Checking…" while it loads, never a word of their own', () => {
        expect(read('components/VesselHub.tsx')).toContain('const boatLink = useBoatLink() ?? BOAT_LINK_CHECKING;');
        expect(read('components/vessel/NmeaPage.tsx')).toContain('const link = snapshot ?? BOAT_LINK_CHECKING;');
        expect(read('components/SystemStatusButton.tsx')).toContain(
            "linkAbsent: link ? undefined : boatLinkConfigured() ? 'checking' : 'not-set-up',",
        );
    });
});

describe('the passage pane and the video trimmer load when used (131-01)', () => {
    it('nothing imports the passage pane statically; the shell loads it through lazyRetry', () => {
        expect(staticImporters(/components\/passage\/PassageHudPane$|^\.\/PassageHudPane$/)).toEqual([]);
        expect(code(read('App.tsx'))).toContain("import('./components/passage/PassageHudPane')");
    });

    it('nothing imports the video trimmer or the remuxer statically but the trimmer itself', () => {
        expect(staticImporters(/diary\/VideoTrimmer$/)).toEqual([]);
        expect(staticImporters(/services\/videoTrim$/)).toEqual(['components/diary/VideoTrimmer.tsx']);
        expect(staticImporters(/^mp4box$/)).toEqual(['services/videoTrim.ts']);
        const diary = code(read('components/DiaryPage.tsx'));
        expect(diary.replace(/\s+/g, ' ')).toContain(
            "const VideoTrimmer = lazyRetry( () => import('./diary/VideoTrimmer').then((m) => ({ default: m.VideoTrimmer })), 'VideoTrimmer', );",
        );
        expect(diary).toMatch(/<Suspense fallback=\{null\}>\s*<VideoTrimmer/);
    });
});
