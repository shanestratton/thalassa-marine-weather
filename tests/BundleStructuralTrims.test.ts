// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
    COMPILED_OFF_CODE,
    PARKED_LAZY_PAGES,
    parkedFlagState,
    parkedPagesInBundle,
} from '../scripts/parked-lazy-pages.mjs';
import { publicBetaFeatureDefines, readPublicBetaFeatureProfile } from '../scripts/public-beta-feature-profile.mjs';

/**
 * Two structural JavaScript-budget trims (build 123, 2026-10-08). The budget in
 * scripts/check-bundle-size.js counts every .js file in dist/, because all of
 * it ships inside the iOS app, so these remove bytes rather than move them.
 *
 * 1. rollupOptions.output.hoistTransitiveImports = false: Rollup stops copying
 *    every transitive static import into each chunk as `import"./x.js"` glue.
 *    Vite's modulepreload lists still name every chunk a lazy chunk needs, so
 *    the web app does not load them one after another.
 * 2. Build-time feature gates Rollup can fold: production builds define each
 *    public-beta profile flag as exactly "true" or "false", so a gate written
 *    `import.meta.env.FLAG === 'true'` becomes a constant and the code behind a
 *    false one is dropped. `String(x ?? 'false').toLowerCase() === 'true'`, or
 *    a read through a lookup helper, cannot fold, which is how the switched-off
 *    CMEMS waves, sea-ice and mixed-layer renderers, the protected-areas layer
 *    and the Blitzortung strike feed all still shipped in build 122.
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('hoisted import glue stays off', () => {
    const viteConfig = read('vite.config.ts');
    const output = viteConfig.slice(viteConfig.indexOf('output: {'), viteConfig.indexOf('manualChunks('));

    it('sets output.hoistTransitiveImports to false, with the reason beside it', () => {
        expect(output).toMatch(/\n\s*hoistTransitiveImports: false,/);
        expect(output).toMatch(/modulepreload/i);
    });

    it('leaves modulePreload on: dist is shared with the web app, which would then load lazy chunks one by one', () => {
        expect(viteConfig).not.toMatch(/\bmodulePreload:\s*false\b/);
    });
});

/** Each gate, and the exact literal comparison that lets the build fold it. */
const FOLDABLE_GATES = [
    [
        'components/map/useOceanWaveParticleLayer.ts',
        "const FEATURE_ENABLED = import.meta.env.VITE_CMEMS_WAVES_ENABLED === 'true';",
    ],
    [
        'components/map/useSeaIceRasterLayer.ts',
        "const FEATURE_ENABLED = import.meta.env.VITE_CMEMS_SEAICE_ENABLED === 'true';",
    ],
    [
        'components/map/useMldRasterLayer.ts',
        "const FEATURE_ENABLED = import.meta.env.VITE_CMEMS_MLD_ENABLED === 'true';",
    ],
    ['components/map/useMpaLayer.ts', "const FEATURE_ENABLED = import.meta.env.VITE_MPA_ENABLED === 'true';"],
    ['services/weather/api/lightningLicence.ts', "return import.meta.env.VITE_BLITZORTUNG_ENABLED === 'true';"],
    ['components/map/cmemsFeatureAvailability.ts', "const flag = (value: unknown): boolean => value === 'true';"],
    // The flag goes first, so a false flag short-circuits before the prop is read.
    ['components/map/useLightningLayer.ts', 'const visible = isBlitzortungEnabled() && requested;'],
    ['components/map/ThreatBanner.tsx', 'const lightningActive = isBlitzortungEnabled() && lightningRequested;'],
    [
        'components/map/useMapHubLayerVisibility.ts',
        'const browseLightningVisible = isBlitzortungEnabled() && lightningVisible && !planningSurface;',
    ],
    // Not a gate that drops code, but it must read the flags the same way the
    // renderer hooks do, or the two disagree in dev (see the sweep below).
    [
        'components/map/useWeatherLayers.ts',
        "const cmemsCurrentsEnabled = import.meta.env.VITE_CMEMS_CURRENTS_ENABLED === 'true';",
    ],
    // Held capabilities (W1-FX): both are false in the public-beta profile, so
    // the dev override and the demo-chart import fold out of production.
    ['hooks/useEntitlement.ts', "const DEV_GRANT_ALL = import.meta.env.VITE_GRANT_ALL_FEATURES === 'true';"],
    [
        'services/enc/bootstrapEncSamples.ts',
        "const explicit = import.meta.env.VITE_ENABLE_ENC_DEMO_SAMPLES === 'true';",
    ],
] as const;

describe('switched-off features use gates the build can fold', () => {
    it.each(FOLDABLE_GATES)('%s reads its flag as a literal comparison', (file, gate) => {
        const source = read(file);
        expect(source).toContain(gate);
        expect(source).not.toMatch(/toLowerCase\(\)\s*===\s*'true'/);
    });

    it('the CMEMS renderer hooks for compiled-off products no longer ask isCmemsFeatureEnabled', () => {
        for (const file of FOLDABLE_GATES.slice(0, 3).map(([path]) => path)) {
            expect(read(file)).not.toMatch(/isCmemsFeatureEnabled\(/);
        }
    });
});

/** A read of one of the map-layer flags in app code. */
const LAYER_FLAG_READ = /import\.meta\.env\??\.(VITE_(?:CMEMS_[A-Z]+|MPA|BLITZORTUNG)_ENABLED)\b/g;
const NOT_APP_SOURCE = new Set(['node_modules', 'dist', 'tests', 'ios', 'android', 'coverage']);

function appSourceFiles(dir = ROOT): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith('.') || NOT_APP_SOURCE.has(entry.name)) return [];
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return appSourceFiles(full);
        return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
}

describe('every reader of a map-layer flag agrees with the folded gates', () => {
    it("compares it to exactly 'true', so a dev .env value such as TRUE cannot switch one reader on and leave another off", () => {
        const loose: string[] = [];
        const readers = new Set<string>();
        for (const file of appSourceFiles()) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(LAYER_FLAG_READ)) {
                const at = match.index ?? 0;
                const after = source.slice(at + match[0].length);
                const literal =
                    /^\s*===\s*'true'/.test(after) || (source.slice(0, at).endsWith('flag(') && after.startsWith(')'));
                const rel = relative(ROOT, file).replaceAll('\\', '/');
                readers.add(rel);
                if (!literal) loose.push(`${rel}:${source.slice(0, at).split('\n').length} ${match[1]}`);
            }
        }
        expect(loose).toEqual([]);
        // The sweep really reached the readers, so a moved directory cannot pass it by seeing nothing.
        expect([...readers]).toEqual(
            expect.arrayContaining([
                'components/map/useWeatherLayers.ts',
                'components/map/cmemsFeatureAvailability.ts',
                'components/map/useOceanWaveParticleLayer.ts',
                'components/map/useMpaLayer.ts',
                'services/weather/api/lightningLicence.ts',
            ]),
        );
    });
});

describe('no app code reads a build flag in a form the build cannot fold', () => {
    it("never wraps an import.meta.env flag in String(...).toLowerCase() === 'true'", () => {
        // That form survives minification as "false".toLowerCase()==="true",
        // so everything behind a switched-off flag still ships.
        const loose =
            /String\(\s*import\.meta\.env\??\.(VITE_[A-Z0-9_]+)[^;\n]*?\)\s*\.toLowerCase\(\)\s*===\s*'true'/g;
        const offenders: string[] = [];
        for (const file of appSourceFiles()) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(loose)) {
                const line = source.slice(0, match.index ?? 0).split('\n').length;
                offenders.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${line} ${match[1]}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

// The renderers import mapbox-gl, which needs a browser; only the flag readers run here.
vi.mock('mapbox-gl', () => ({ default: {} }));

describe('the dev server and tests still read the env var at run time', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    const readers = [
        [
            'VITE_CMEMS_WAVES_ENABLED',
            () => import('../components/map/useOceanWaveParticleLayer'),
            'isCmemsWavesEnabled',
        ],
        ['VITE_CMEMS_SEAICE_ENABLED', () => import('../components/map/useSeaIceRasterLayer'), 'isCmemsSeaIceEnabled'],
        ['VITE_CMEMS_MLD_ENABLED', () => import('../components/map/useMldRasterLayer'), 'isCmemsMldEnabled'],
        ['VITE_MPA_ENABLED', () => import('../components/map/useMpaLayer'), 'isMpaEnabled'],
        ['VITE_BLITZORTUNG_ENABLED', () => import('../services/weather/api/lightningLicence'), 'isBlitzortungEnabled'],
    ] as const;

    it.each(readers)(
        '%s: vi.stubEnv turns it on with "true" and leaves it off otherwise',
        async (flag, load, reader) => {
            for (const [value, expected] of [
                ['true', true],
                ['false', false],
                ['', false],
                ['yes', false],
            ] as const) {
                vi.resetModules();
                vi.stubEnv(flag, value);
                const module = (await load()) as unknown as Record<string, () => boolean>;
                expect(module[reader](), `${flag}=${JSON.stringify(value)}`).toBe(expected);
            }
        },
    );
});

/** Gate files the fold proof builds, and the layers that are ON in production. */
const GATE_ENTRIES = {
    waves: 'components/map/useOceanWaveParticleLayer.ts',
    seaice: 'components/map/useSeaIceRasterLayer.ts',
    mld: 'components/map/useMldRasterLayer.ts',
    mpa: 'components/map/useMpaLayer.ts',
    lightning: 'components/map/useLightningLayer.ts',
    banner: 'components/map/ThreatBanner.tsx',
    currents: 'components/map/useOceanCurrentParticleLayer.ts',
    sst: 'components/map/useSstRasterLayer.ts',
    chl: 'components/map/useChlRasterLayer.ts',
};
const FOLDED_FLAGS = [
    'VITE_CMEMS_WAVES_ENABLED',
    'VITE_CMEMS_SEAICE_ENABLED',
    'VITE_CMEMS_MLD_ENABLED',
    'VITE_MPA_ENABLED',
    'VITE_BLITZORTUNG_ENABLED',
] as const;
const COMPILED_OFF_MODULES = [
    'components/map/WaveParticleLayer.ts',
    'components/map/SeaIceRasterLayer.ts',
    'components/map/MldRasterLayer.ts',
    'services/weather/api/mpaDataset.ts',
    'components/map/MpaLayer.ts',
];
const SHIPPED_RENDERERS = [
    'components/map/CurrentParticleLayer.ts',
    'components/map/SstRasterLayer.ts',
    'components/map/ChlRasterLayer.ts',
];

interface MiniBuild {
    bundle: Rollup.OutputBundle;
    rendered: (rel: string) => number;
    code: string;
}

const emptyEnvDir = mkdtempSync(join(tmpdir(), 'bundle-trim-env-'));
afterAll(() => rmSync(emptyEnvDir, { recursive: true, force: true }));

/**
 * A production-mode Rollup build of just the gate files with the given defines
 * (npm packages external, no env files read), so the test sees exactly what
 * the real build's tree-shaker keeps.
 */
async function miniBuild(define: Record<string, string>): Promise<MiniBuild> {
    let bundle: Rollup.OutputBundle = {};
    await build({
        configFile: false,
        root: ROOT,
        envDir: emptyEnvDir,
        publicDir: false,
        logLevel: 'silent',
        mode: 'production',
        define,
        build: {
            write: false,
            // Minified like the real build, so the guard reads the code it would see there.
            minify: 'esbuild',
            modulePreload: false,
            copyPublicDir: false,
            rollupOptions: {
                input: Object.fromEntries(
                    Object.entries(GATE_ENTRIES).map(([name, rel]) => [name, resolve(ROOT, rel)]),
                ),
                preserveEntrySignatures: 'exports-only',
                external: (id) => !/^[./\0]/.test(id) && !id.startsWith('@/'),
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
    const id = (rel: string) => `${ROOT.replaceAll('\\', '/')}/${rel}`;
    return {
        bundle,
        rendered: (rel) => chunks.reduce((sum, chunk) => sum + (chunk.modules[id(rel)]?.renderedLength ?? 0), 0),
        code: chunks.map((chunk) => chunk.code).join('\n'),
    };
}

const profile = readPublicBetaFeatureProfile(ROOT);
const committedDefines = publicBetaFeatureDefines(profile);
const flippedOnDefines = {
    ...committedDefines,
    ...Object.fromEntries(FOLDED_FLAGS.map((flag) => [`import.meta.env.${flag}`, JSON.stringify('true')])),
};

describe('the committed profile compiles the switched-off layers out, and flipping a flag brings them back', () => {
    it('folds exactly the flags the committed public-beta profile has off', () => {
        for (const flag of FOLDED_FLAGS) expect(profile.featureFlags[flag]).toBe(false);
        expect(profile.featureFlags.VITE_CMEMS_CURRENTS_ENABLED).toBe(true);
        expect(profile.featureFlags.VITE_CMEMS_SST_ENABLED).toBe(true);
        expect(profile.featureFlags.VITE_CMEMS_CHL_ENABLED).toBe(true);
    });

    it('as committed: the renderers behind false flags are gone, the ones that are on still ship', async () => {
        const committed = await miniBuild(committedDefines);
        for (const rel of COMPILED_OFF_MODULES) expect(committed.rendered(rel), rel).toBe(0);
        for (const rel of SHIPPED_RENDERERS) expect(committed.rendered(rel), rel).toBeGreaterThan(1_000);
        // No path in the gated code can reach Blitzortung's socket.
        expect(committed.code).not.toContain('.blitzortung.org/');
        // And the build guard agrees.
        expect(parkedPagesInBundle(ROOT, committed.bundle)).toEqual([]);
    });

    it('flipped on: every one of them comes back, and the guard would name each while the profile still says false', async () => {
        const flipped = await miniBuild(flippedOnDefines);
        for (const rel of [...COMPILED_OFF_MODULES, ...SHIPPED_RENDERERS]) {
            expect(flipped.rendered(rel), rel).toBeGreaterThan(1_000);
        }
        expect(flipped.code).toContain('.blitzortung.org/');
        const offenders = parkedPagesInBundle(ROOT, flipped.bundle).join('\n');
        for (const entry of PARKED_LAZY_PAGES.filter((parked) => 'gate' in parked)) {
            expect(offenders).toContain(`${entry.page} shipped in`);
        }
        expect(offenders).toMatch(/strike socket .* shipped in \S+ although VITE_BLITZORTUNG_ENABLED is false/);
        // Flipping the profile itself lifts the check.
        expect(parkedPagesInBundle(ROOT, flipped.bundle, () => 'live')).toEqual([]);
    });
});

describe('the build guard covers the compiled-off renderers', () => {
    const guarded = PARKED_LAZY_PAGES.filter((entry) => 'gate' in entry);

    it('registers each renderer with its profile flag and the gate that must fold', () => {
        expect(guarded.map((entry) => [entry.page, entry.flag, 'gate' in entry ? entry.gate : null]).sort()).toEqual([
            ['components/map/MldRasterLayer.ts', 'VITE_CMEMS_MLD_ENABLED', 'components/map/useMldRasterLayer.ts'],
            [
                'components/map/SeaIceRasterLayer.ts',
                'VITE_CMEMS_SEAICE_ENABLED',
                'components/map/useSeaIceRasterLayer.ts',
            ],
            [
                'components/map/WaveParticleLayer.ts',
                'VITE_CMEMS_WAVES_ENABLED',
                'components/map/useOceanWaveParticleLayer.ts',
            ],
            ['services/weather/api/mpaDataset.ts', 'VITE_MPA_ENABLED', 'components/map/useMpaLayer.ts'],
        ]);
    });

    it('reads each flag from config/public-beta-features.json, the file production builds take them from', () => {
        expect(guarded).toHaveLength(4);
        for (const entry of guarded) {
            expect(entry.flagFile).toBe('config/public-beta-features.json');
            const expected = profile.featureFlags[entry.flag as keyof typeof profile.featureFlags] ? 'live' : 'parked';
            expect(parkedFlagState(ROOT, entry)).toBe(expected);
        }
    });

    it('says which gate to look at when a renderer comes back', () => {
        const wave = guarded.find((entry) => entry.page === 'components/map/WaveParticleLayer.ts')!;
        const id = `${ROOT.replaceAll('\\', '/')}/${wave.page}`;
        const bundle = {
            'assets/MapHub-x.js': {
                type: 'chunk',
                fileName: 'assets/MapHub-x.js',
                facadeModuleId: null,
                modules: { [id]: { renderedLength: 120 } },
            },
        };
        expect(parkedPagesInBundle(ROOT, bundle, () => 'parked')).toEqual([
            expect.stringMatching(
                /WaveParticleLayer\.ts shipped in assets\/MapHub-x\.js although VITE_CMEMS_WAVES_ENABLED is false in config\/public-beta-features\.json\. .*useOceanWaveParticleLayer\.ts.*=== 'true'/,
            ),
        ]);
    });
});

describe("the build guard covers Blitzortung's strike socket", () => {
    // blitzortungLightning.ts still ships a small part PerfOverlay reads, so
    // the guard looks for the socket address only the strike feed builds.
    const chunkWith = (code: string) => ({
        'assets/MapHub-x.js': {
            type: 'chunk',
            fileName: 'assets/MapHub-x.js',
            facadeModuleId: null,
            modules: {},
            code,
        },
    });

    it('registers the socket with its profile flag, its gate, and a marker the source really builds', () => {
        expect(COMPILED_OFF_CODE).toHaveLength(1);
        const [socket] = COMPILED_OFF_CODE;
        expect([socket.code, socket.flag, socket.flagFile, socket.gate]).toEqual([
            'services/weather/api/blitzortungLightning.ts',
            'VITE_BLITZORTUNG_ENABLED',
            'config/public-beta-features.json',
            'services/weather/api/lightningLicence.ts',
        ]);
        expect(parkedFlagState(ROOT, socket)).toBe(profile.featureFlags.VITE_BLITZORTUNG_ENABLED ? 'live' : 'parked');
        expect(read(socket.code)).toMatch(socket.marker);
    });

    it.each([
        // What esbuild's minifier makes of pickServerUrl() for this build's targets.
        ['minified template', 'return`wss://ws${h[Math.floor(Math.random()*h.length)]}.blitzortung.org/`'],
        [
            'template literals lowered',
            'return"wss://ws".concat(h[Math.floor(Math.random()*h.length)],".blitzortung.org/")',
        ],
        ['concatenation', 'const u=e=>"wss://ws"+e+".blitzortung.org/";'],
        ['a fixed host', 'const u="wss://ws1.blitzortung.org/";'],
    ])('fails the build when the socket ships while the flag is false (%s)', (_shape, code) => {
        expect(parkedPagesInBundle(ROOT, chunkWith(code), () => 'parked')).toEqual([
            expect.stringMatching(
                /strike socket \(services\/weather\/api\/blitzortungLightning\.ts\) shipped in assets\/MapHub-x\.js although VITE_BLITZORTUNG_ENABLED is false in config\/public-beta-features\.json\. .*isBlitzortungEnabled\(\) first.*lightningLicence\.ts/,
            ),
        ]);
        // Turning the flag on in the profile lifts the check.
        expect(parkedPagesInBundle(ROOT, chunkWith(code), () => 'live')).toEqual([]);
    });

    it('leaves the attribution link, and comments naming the servers, alone', () => {
        for (const code of [
            'm.jsx("a",{href:"https://www.blitzortung.org",target:"_blank",rel:"noopener"})',
            '// wss://ws[1,2,7,8].blitzortung.org/ and wss://ws*.blitzortung.org',
        ]) {
            expect(parkedPagesInBundle(ROOT, chunkWith(code), () => 'parked')).toEqual([]);
        }
    });
});
