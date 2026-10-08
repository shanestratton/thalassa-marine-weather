/**
 * The debug AIS injector (125-01 scope item 11) exists only for the 125-11
 * locked-phone + Focus smoke: it feeds a fictional crossing target through
 * the real receiver path. It must be provably absent from a release build.
 *
 *  - The only way in is a gate on the build-time constant
 *    __THALASSA_DEBUG_AIS_INJECTOR__, which vite.config.ts sets false unless
 *    THALASSA_DEBUG_AIS_INJECTOR=1 is in the build's environment.
 *  - Bundled with the constant false, the gate carries none of the injector
 *    (proved here with esbuild, the same dead-branch folding Vite relies on).
 *  - The production build fails outright if the injector's marker reaches any
 *    chunk while the flag is off (releaseDebugAisInjectorFence).
 */
// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import {
    DEBUG_AIS_INJECTOR_MARKER,
    debugAisInjectorFenceError,
    filesCarryingDebugAisInjector,
} from '../scripts/debug-ais-injector-fence.mjs';

const ROOT = process.cwd();
const GATE = resolve(ROOT, 'components/settings/debugAisInjectorGate.ts');
/** The gate, the debug panel and the injector are built; everything they import is left external. */
const BUILT =
    /(components\/settings\/(debugAisInjectorGate|DebugAisInjectorSection)|services\/debug\/aisInjector)(\.tsx?)?$/;

const emptyEnvDir = mkdtempSync(join(tmpdir(), 'ais-injector-env-'));
afterAll(() => rmSync(emptyEnvDir, { recursive: true, force: true }));

/**
 * A production-mode Rollup build of the gate alone, minified like the real
 * build, with the flag defined as the real vite.config.ts defines it. Shows
 * exactly what the release tree-shaker keeps (the same proof
 * tests/BundleStructuralTrims.test.ts uses for the compiled-off layers).
 */
async function buildGate(flag: boolean): Promise<{ code: string; chunks: string[] }> {
    let bundle: Rollup.OutputBundle = {};
    await build({
        configFile: false,
        root: ROOT,
        envDir: emptyEnvDir,
        publicDir: false,
        logLevel: 'silent',
        mode: 'production',
        define: { __THALASSA_DEBUG_AIS_INJECTOR__: JSON.stringify(flag) },
        build: {
            write: false,
            minify: 'esbuild',
            modulePreload: false,
            copyPublicDir: false,
            rollupOptions: {
                input: { gate: GATE },
                preserveEntrySignatures: 'exports-only',
                external: (id, importer) => {
                    if (!importer || id.startsWith('\0')) return false;
                    if (!/^[./]/.test(id)) return true;
                    return !BUILT.test(id.startsWith('.') ? resolve(importer, '..', id) : id);
                },
                onwarn: () => {},
            },
        },
        plugins: [
            {
                name: 'capture-bundle',
                generateBundle(_options, output) {
                    bundle = { ...output };
                },
            },
        ],
    });
    const chunks = Object.values(bundle).filter((output): output is Rollup.OutputChunk => output.type === 'chunk');
    return { code: chunks.map((chunk) => chunk.code).join('\n'), chunks: chunks.map((chunk) => chunk.fileName) };
}

describe('debug AIS injector stays out of release builds', () => {
    it('the injector carries the marker the release fence looks for', () => {
        const injector = readFileSync(resolve(ROOT, 'services/debug/aisInjector.ts'), 'utf8');
        expect(injector).toContain(DEBUG_AIS_INJECTOR_MARKER);
    });

    it('with the flag off, the release build keeps nothing of the injector: no code, no chunk', async () => {
        const off = await buildGate(false);
        expect(off.code).not.toContain(DEBUG_AIS_INJECTOR_MARKER);
        expect(off.chunks).toHaveLength(1);
        expect(debugAisInjectorFenceError([{ fileName: 'gate.js', code: off.code }], false)).toBeNull();
    }, 60_000);

    it('with the flag on (smoke builds only), it is there, in its own lazy chunk', async () => {
        const on = await buildGate(true);
        expect(on.code).toContain(DEBUG_AIS_INJECTOR_MARKER);
        expect(on.chunks.length).toBeGreaterThan(1);
    }, 60_000);

    it('nothing else in the app imports the injector directly', () => {
        const general = readFileSync(resolve(ROOT, 'components/settings/GeneralTab.tsx'), 'utf8');
        expect(general).not.toMatch(/from ['"][^'"]*debug\/aisInjector['"]/);
        expect(general).toContain("from './debugAisInjectorGate'");
        const gate = readFileSync(resolve(ROOT, 'components/settings/debugAisInjectorGate.ts'), 'utf8');
        expect(gate).toMatch(/__THALASSA_DEBUG_AIS_INJECTOR__\s*\?/);
    });

    it('the build is wired to the flag and to the fence', () => {
        const vite = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
        expect(vite).toContain('__THALASSA_DEBUG_AIS_INJECTOR__: JSON.stringify(debugAisInjectorEnabled)');
        expect(vite).toContain("process.env.THALASSA_DEBUG_AIS_INJECTOR === '1'");
        expect(vite).toContain('releaseDebugAisInjectorFence(debugAisInjectorEnabled)');
        const vitest = readFileSync(resolve(ROOT, 'vitest.config.ts'), 'utf8');
        expect(vitest).toContain("__THALASSA_DEBUG_AIS_INJECTOR__: 'false'");
    });

    it('the fence fails a release build that carries the marker, and only then', () => {
        const chunks = [
            { fileName: 'assets/a.js', code: 'console.log(1)' },
            { fileName: 'assets/b.js', code: `x("${DEBUG_AIS_INJECTOR_MARKER}")` },
        ];
        expect(debugAisInjectorFenceError(chunks, false)).toMatch(/assets\/b\.js/);
        expect(debugAisInjectorFenceError(chunks.slice(0, 1), false)).toBeNull();
        // A smoke build is allowed to carry it.
        expect(debugAisInjectorFenceError(chunks, true)).toBeNull();
    });

    it('a smoke build synced to iOS is caught before an archive (the archive does not rebuild the JS)', async () => {
        const iosPublic = mkdtempSync(join(tmpdir(), 'ais-injector-ios-'));
        try {
            mkdirSync(join(iosPublic, 'assets'));
            writeFileSync(join(iosPublic, 'assets', 'index.js'), 'console.log(1)');
            expect(await filesCarryingDebugAisInjector(iosPublic)).toEqual([]);
            writeFileSync(join(iosPublic, 'assets', 'smoke.js'), `x("${DEBUG_AIS_INJECTOR_MARKER}")`);
            expect(await filesCarryingDebugAisInjector(iosPublic)).toEqual([join(iosPublic, 'assets', 'smoke.js')]);
        } finally {
            rmSync(iosPublic, { recursive: true, force: true });
        }
        // Wired: an npm check for the iOS copy, and cap sync warns loudly.
        const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
        expect(pkg.scripts['check:ios-injector']).toBe('node scripts/debug-ais-injector-fence.mjs ios/App/App/public');
        const capSync = readFileSync(resolve(ROOT, 'scripts/cap-sync.mjs'), 'utf8');
        expect(capSync).toContain(
            "const { filesCarryingDebugAisInjector } = await import('./debug-ais-injector-fence.mjs');",
        );
        expect(capSync).toContain("(await filesCarryingDebugAisInjector('ios/App/App/public')).length > 0");
    });

    it('a smoke build says so on the version line, behind the same constant', () => {
        const general = readFileSync(resolve(ROOT, 'components/settings/GeneralTab.tsx'), 'utf8');
        expect(general).toMatch(/__THALASSA_DEBUG_AIS_INJECTOR__ && ' · AIS injector smoke build: never upload'/);
    });
});
