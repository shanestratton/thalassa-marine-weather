/**
 * Pages a build-time flag has parked, and map renderers a public-beta profile
 * flag compiles off, must not ship.
 *
 * Each page below is reached only through a lazyRetry() whose result the build
 * discards while its flag is false. utils/lazyRetry.ts is annotated
 * `#__NO_SIDE_EFFECTS__`, which is what lets Rollup drop those calls and the
 * chunks behind them (2026-10-05: about 135 KB of the JavaScript budget). If a
 * toolchain change ever stops honouring the annotation, the pages come back as
 * chunks nothing can load. The vite.config.ts plugin `releaseParkedPagesStayOut`
 * fails the production build when that happens, so it shows up in the build
 * and not only as lost budget.
 *
 * The renderers (entries with a `gate`) work the same way from a different
 * flag: a production build defines every config/public-beta-features.json flag
 * as exactly "true" or "false", and each gate reads its flag as the literal
 * `import.meta.env.FLAG === 'true'`, so Rollup folds it and drops the renderer
 * while the flag is false (2026-10-08: 81,837 B with the Blitzortung gate). A
 * gate rewritten through a helper or `String(x).toLowerCase()` cannot fold, and
 * the renderer would quietly ship again.
 *
 * Blitzortung's strike feed has no module of its own to check:
 * blitzortungLightning.ts still ships a small part that PerfOverlay reads. So
 * COMPILED_OFF_CODE names code only the switched-off part contains (the socket
 * address it builds), and the guard looks for that text in every chunk.
 *
 * Flipping a flag to true lifts its entry's check; the code then ships as normal.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where production builds take the public-beta feature flags from. */
const PROFILE_FILE = 'config/public-beta-features.json';

/** Each parked page or compiled-off renderer, and the flag that keeps it out. */
export const PARKED_LAZY_PAGES = Object.freeze([
    Object.freeze({
        page: 'components/voice/BosunConsole.tsx',
        flagFile: 'utils/featureVisibility.ts',
        flag: 'calypsoConsole',
        parked: /\bcalypsoConsole:\s*false\b/,
        live: /\bcalypsoConsole:\s*true\b/,
    }),
    Object.freeze({
        page: 'components/map/OfflineAreaModal.tsx',
        flagFile: 'components/map/mapHubHelpers.ts',
        flag: 'OFFLINE_AREA_FAB_VISIBLE',
        parked: /\bexport const OFFLINE_AREA_FAB_VISIBLE = false;/,
        live: /\bexport const OFFLINE_AREA_FAB_VISIBLE = true;/,
    }),
    ...[
        [
            'components/map/WaveParticleLayer.ts',
            'VITE_CMEMS_WAVES_ENABLED',
            'components/map/useOceanWaveParticleLayer.ts',
        ],
        ['components/map/SeaIceRasterLayer.ts', 'VITE_CMEMS_SEAICE_ENABLED', 'components/map/useSeaIceRasterLayer.ts'],
        ['components/map/MldRasterLayer.ts', 'VITE_CMEMS_MLD_ENABLED', 'components/map/useMldRasterLayer.ts'],
        ['services/weather/api/mpaDataset.ts', 'VITE_MPA_ENABLED', 'components/map/useMpaLayer.ts'],
    ].map(([page, flag, gate]) => Object.freeze({ page, flagFile: PROFILE_FILE, flag, gate })),
]);

/**
 * Code a false profile flag compiles off inside a module that still ships in
 * part, and text in the built chunk that only that code contains.
 */
export const COMPILED_OFF_CODE = Object.freeze([
    Object.freeze({
        what: "Blitzortung's strike socket",
        code: 'services/weather/api/blitzortungLightning.ts',
        // `wss://ws${id}.blitzortung.org/` as a template (the minifier inlines
        // the server pick into it), lowered to + or .concat(), or one fixed
        // server. Not the attribution link, and not a comment such as
        // `wss://ws[1,2,7,8].blitzortung.org`.
        marker: /wss:\/\/ws(?:\$\{|["'`]\s*(?:\+|\.concat\()|\d)[^\n]{0,160}?\.blitzortung\.org/,
        flagFile: PROFILE_FILE,
        flag: 'VITE_BLITZORTUNG_ENABLED',
        gate: 'services/weather/api/lightningLicence.ts',
        reader: 'isBlitzortungEnabled()',
    }),
]);

/** 'parked', 'live', or 'missing' when the flag can no longer be found. */
export function parkedFlagState(root, entry) {
    const source = fs.readFileSync(path.join(root, entry.flagFile), 'utf8');
    if (entry.gate) {
        const enabled = JSON.parse(source).featureFlags?.[entry.flag];
        return enabled === false ? 'parked' : enabled === true ? 'live' : 'missing';
    }
    if (entry.parked.test(source)) return 'parked';
    if (entry.live.test(source)) return 'live';
    return 'missing';
}

/**
 * Parked pages, and compiled-off code, that reached a Rollup output bundle,
 * one message each. Empty when the bundle is clean. `root` is the repo root the page paths are under.
 */
export function parkedPagesInBundle(root, bundle, flagState = parkedFlagState) {
    const offenders = [];
    for (const entry of PARKED_LAZY_PAGES) {
        if (flagState(root, entry) !== 'parked') continue;
        const id = path.posix.join(root.replaceAll('\\', '/'), entry.page);
        for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            const rendered = output.modules?.[id]?.renderedLength ?? 0;
            if (output.facadeModuleId === id || rendered > 0) {
                offenders.push(
                    entry.gate
                        ? `${entry.page} shipped in ${output.fileName} although ${entry.flag} is false in ${entry.flagFile}. ` +
                              `Does ${entry.gate} still read import.meta.env.${entry.flag} === 'true' directly, so the build can fold it?`
                        : `${entry.page} shipped in ${output.fileName} although ${entry.flag} is false. ` +
                              'Is utils/lazyRetry.ts still annotated #__NO_SIDE_EFFECTS__, and does the toolchain honour it?',
                );
            }
        }
    }
    for (const entry of COMPILED_OFF_CODE) {
        if (flagState(root, entry) !== 'parked') continue;
        for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk' || typeof output.code !== 'string' || !entry.marker.test(output.code)) continue;
            offenders.push(
                `${entry.what} (${entry.code}) shipped in ${output.fileName} although ${entry.flag} is false in ${entry.flagFile}. ` +
                    `Does every caller still check ${entry.reader} first, and does ${entry.gate} still return import.meta.env.${entry.flag} === 'true'?`,
            );
        }
    }
    return offenders;
}
