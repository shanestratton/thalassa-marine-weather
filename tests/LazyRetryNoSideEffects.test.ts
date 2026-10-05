// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformWithEsbuild } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { PARKED_LAZY_PAGES, parkedFlagState, parkedPagesInBundle } from '../scripts/parked-lazy-pages.mjs';
import { lazyRetry } from '../utils/lazyRetry';

/**
 * utils/lazyRetry.ts carries `#__NO_SIDE_EFFECTS__`, so Rollup drops any
 * lazyRetry() call whose result the build has discarded. That is how a page
 * parked by a build-time flag (the Calypso console, the offline-area modal)
 * stops shipping as a chunk nothing can load (2026-10-05, about 135 KB).
 *
 * The annotation is only true while calling lazyRetry does nothing but wrap
 * the factory: no import starts and no storage is read or written until React
 * first renders the component. These tests pin that.
 */
const source = readFileSync(resolve(process.cwd(), 'utils/lazyRetry.ts'), 'utf8');

describe('lazyRetry is free to call', () => {
    it('declares itself side-effect free, directly above the function', () => {
        expect(source).toMatch(
            /\/\* #__NO_SIDE_EFFECTS__ \*\/\n\/\/ eslint-disable-next-line[^\n]*\nexport function lazyRetry</,
        );
    });

    it('keeps the annotation through the TypeScript transform Rollup reads', async () => {
        const { code } = await transformWithEsbuild(source, 'lazyRetry.ts', { loader: 'ts' });
        expect(code).toMatch(/\/\/ @__NO_SIDE_EFFECTS__\nexport function lazyRetry\(/);
    });

    it('does not run the factory or touch storage when called', () => {
        const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
        vi.stubGlobal('sessionStorage', storage);
        try {
            const factory = vi.fn(() => Promise.resolve({ default: () => null }));
            const Lazy = lazyRetry(factory, 'NoSideEffectsProbe');
            expect(factory).not.toHaveBeenCalled();
            expect(storage.getItem).not.toHaveBeenCalled();
            expect(storage.setItem).not.toHaveBeenCalled();
            expect(storage.removeItem).not.toHaveBeenCalled();
            expect(Lazy.$$typeof).toBe(Symbol.for('react.lazy'));
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

/**
 * The build backs the annotation up: vite.config.ts `releaseParkedPagesStayOut`
 * fails a production build that still emits a parked page, so a toolchain
 * that stops honouring `#__NO_SIDE_EFFECTS__` (a future Vite or Oxc) shows up
 * at once rather than as about 135 KB of lost budget.
 */
describe('parked pages stay out of the build', () => {
    const ROOT = process.cwd();
    const page = (rel: string) => `${ROOT.replaceAll('\\', '/')}/${rel}`;
    const chunk = (fileName: string, facadeModuleId: string | null, modules: Record<string, number> = {}) => ({
        type: 'chunk',
        fileName,
        facadeModuleId,
        modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])),
    });
    const bosun = PARKED_LAZY_PAGES.find((entry) => entry.flag === 'calypsoConsole')!;

    it('is registered for production builds', () => {
        const viteConfig = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
        expect(viteConfig).toContain("mode === 'production' && releaseParkedPagesStayOut(),");
        expect(viteConfig).toContain('parkedPagesInBundle(__dirname, bundle)');
    });

    it.each(PARKED_LAZY_PAGES.map((entry) => [entry.page, entry]))(
        '%s and its flag still exist (a renamed flag would switch the check off)',
        (_name, entry) => {
            expect(existsSync(resolve(ROOT, entry.page))).toBe(true);
            expect(parkedFlagState(ROOT, entry)).not.toBe('missing');
        },
    );

    it('fails a bundle that emits a parked page, as a chunk or inside one', () => {
        const parked = () => 'parked' as const;
        const bundle = {
            'assets/index.js': chunk('assets/index.js', page('index.tsx'), { [page('index.tsx')]: 900 }),
            'assets/BosunConsole-x.js': chunk('assets/BosunConsole-x.js', page(bosun.page)),
            'assets/Shared-y.js': chunk('assets/Shared-y.js', null, { [page(PARKED_LAZY_PAGES[1].page)]: 40 }),
            'sw.js': { type: 'asset', fileName: 'sw.js' },
        };
        const offenders = parkedPagesInBundle(ROOT, bundle, parked);
        expect(offenders).toHaveLength(2);
        expect(offenders[0]).toMatch(/BosunConsole\.tsx shipped in assets\/BosunConsole-x\.js although calypsoConsole/);
        expect(offenders[1]).toMatch(/OfflineAreaModal\.tsx shipped in assets\/Shared-y\.js/);
    });

    it('passes a clean bundle, a fully tree-shaken module, and a page whose flag is on', () => {
        const clean = {
            'assets/index.js': chunk('assets/index.js', page('index.tsx'), { [page(bosun.page)]: 0 }),
        };
        expect(parkedPagesInBundle(ROOT, clean, () => 'parked')).toEqual([]);
        const live = { 'assets/BosunConsole-x.js': chunk('assets/BosunConsole-x.js', page(bosun.page)) };
        expect(parkedPagesInBundle(ROOT, live, () => 'live')).toEqual([]);
    });
});
