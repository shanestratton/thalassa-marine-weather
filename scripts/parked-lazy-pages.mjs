/**
 * Pages a build-time flag has parked must not ship as chunks.
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
 * Flipping a flag to true lifts its page's check; the page then ships as normal.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Each parked page, and the literal flag that parks it. */
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
]);

/** 'parked', 'live', or 'missing' when the flag can no longer be found. */
export function parkedFlagState(root, entry) {
    const source = fs.readFileSync(path.join(root, entry.flagFile), 'utf8');
    if (entry.parked.test(source)) return 'parked';
    if (entry.live.test(source)) return 'live';
    return 'missing';
}

/**
 * Parked pages that reached a Rollup output bundle, one message each. Empty
 * when the bundle is clean. `root` is the repo root the page paths are under.
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
                    `${entry.page} shipped in ${output.fileName} although ${entry.flag} is false. ` +
                        'Is utils/lazyRetry.ts still annotated #__NO_SIDE_EFFECTS__, and does the toolchain honour it?',
                );
            }
        }
    }
    return offenders;
}
