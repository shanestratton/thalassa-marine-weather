/** Build/plugin and closed-leaf fixtures only, not App/native execution. */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, realpathSync } from 'node:fs';
import { URL as NodeURL, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
    createFullAppGraphIsolation,
    fullAppGraphSubstitutionPaths,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/graphIsolation.mjs';
import {
    supabase,
    supabaseUrl,
    supabaseAnonKey,
    isSupabaseConfigured,
    getCurrentUser,
    getUserProfile,
    updateUserProfile,
    capacitorAuthStorage,
    captureException,
    ensureSentryLoaded,
    readClosedBackendCounters,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/closedBackend';
import {
    Capacitor,
    registerPlugin,
    readFullAppCoreCounters,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/core';
const repo = resolve(new NodeURL('..', import.meta.url).pathname);
const sdkRoot = realpathSync(repo + '/node_modules/@supabase/supabase-js');
const coreRoot = realpathSync(repo + '/node_modules/@capacitor/core');
const researchSdk = repo + '/experiments/scuttlebutt-e2ee/full-app-pilot/sdk.ts';
describe('exact full-App graph isolation', () => {
    it.each(fullAppGraphSubstitutionPaths)('substitutes %s and refuses a direct original load', (path) => {
        const plugin = createFullAppGraphIsolation();
        const id = plugin.resolveId(path, repo + '/App.tsx');
        expect(id).toMatch(/^\0thalassa-full-app-closed:/);
        expect(plugin.load(id!)).toBeTypeOf('string');
        expect(() => plugin.load(path)).toThrow(/Production entry or authority/);
    });
    it('resolves relative and extension-qualified authority paths identically', () => {
        const plugin = createFullAppGraphIsolation();
        expect(plugin.resolveId('../stores/authStore', repo + '/context/AuthContext.tsx')).toBe(
            plugin.resolveId('../stores/authStore.ts', repo + '/context/AuthContext.tsx'),
        );
        expect(plugin.resolveId('@/services/supabase', repo + '/App.tsx')).toMatch(/^\0thalassa-full-app-closed:/);
    });
    it('canonicalizes file and Vite paths and strips both query and fragment authority aliases', () => {
        const plugin = createFullAppGraphIsolation();
        const original = repo + '/services/nativeStorage.ts';
        const selected = plugin.resolveId(original, repo + '/App.tsx');
        for (const source of [
            original + '?raw#bypass',
            original + '#bypass',
            pathToFileURL(original).href + '#bypass',
            '/@fs/' + original + '?raw#bypass',
        ]) {
            expect(plugin.resolveId(source, repo + '/App.tsx')).toBe(selected);
            expect(() => plugin.load(source)).toThrow(/Production entry or authority/);
        }
        expect(() => plugin.load(repo + '/services/sentrySdk.ts#bypass')).toThrow();
        expect(() => plugin.load(pathToFileURL(repo + '/index.tsx').href + '?raw#bypass')).toThrow();
    });
    it('allows real core only for audited Research files while App/native packages resolve closed', () => {
        const plugin = createFullAppGraphIsolation();
        expect(
            plugin.resolveId('@capacitor/core', repo + '/experiments/scuttlebutt-e2ee/bridge-web/auth.ts'),
        ).toBeNull();
        expect(
            plugin.resolveId('@capacitor/core', repo + '/experiments/scuttlebutt-e2ee/full-app-pilot/sdk.ts'),
        ).toBeNull();
        for (const importer of [repo + '/App.tsx', repo + '/services/PiProvisionService.ts'])
            expect(plugin.load(plugin.resolveId('@capacitor/core', importer)!)).toContain('core.ts');
        for (const source of [
            '@capacitor/preferences',
            '@capacitor/push-notifications',
            '@transistorsoft/capacitor-background-geolocation',
        ])
            expect(plugin.load(plugin.resolveId(source, repo + '/App.tsx')!)).not.toContain('node_modules');
        expect(
            plugin.load(plugin.resolveId('@transistorsoft/capacitor-background-geolocation', repo + '/App.tsx')!),
        ).toContain('BackgroundGeolocation as default');
    });
    it('rejects unmapped native, direct telemetry and unexpected runtime SDK imports', () => {
        const plugin = createFullAppGraphIsolation();
        for (const source of [
            '@capacitor/unreviewed',
            '@capacitor/core/dist/index.js',
            '@sentry/react',
            '@supabase/supabase-js',
        ])
            expect(() => plugin.resolveId(source, repo + '/App.tsx')).toThrow();
        expect(
            plugin.resolveId('@supabase/supabase-js', repo + '/experiments/scuttlebutt-e2ee/full-app-pilot/sdk.ts'),
        ).toBeNull();
        expect(() => plugin.load(repo + '/services/sentrySdk.ts')).toThrow();
        expect(() => plugin.load(repo + '/index.tsx')).toThrow();
        expect(() => plugin.load(repo + '/ApplicationShell.tsx')).toThrow();
    });
    it.each([
        '@supabase/supabase-js/dist/index.mjs',
        '@supabase/auth-js',
        '@supabase/auth-js/dist/index.mjs',
        '@capacitor/core/dist/index.js',
    ])('rejects unapproved SDK/core deep or sibling package %s', (source) => {
        const plugin = createFullAppGraphIsolation();
        expect(() => plugin.resolveId(source, repo + '/App.tsx')).toThrow();
        // Audited roots may select only their exact bare packages.
        expect(() => plugin.resolveId(source, researchSdk)).toThrow();
    });
    it.each([
        ['sdk', sdkRoot, '@supabase/supabase-js', 'dist/index.mjs'],
        ['core', coreRoot, '@capacitor/core', 'dist/index.js'],
    ])(
        'rejects %s installed package path spellings, even after an approved selection',
        (_kind, installed, named, entry) => {
            const plugin = createFullAppGraphIsolation();
            expect(plugin.resolveId(named, researchSdk)).toBeNull();
            const physical = installed + '/' + entry;
            const repository = repo + '/node_modules/' + named + '/' + entry;
            for (const source of [
                physical,
                repository,
                repository + '?raw#bypass',
                pathToFileURL(physical).href,
                pathToFileURL(repository).href + '#bypass',
                '/@fs/' + physical,
                './node_modules/' + named + '/' + entry,
                'node_modules/' + named + '/' + entry,
                '../node_modules/' + named + '/' + entry,
            ])
                expect(() =>
                    plugin.resolveId(
                        source,
                        source.startsWith('../') ? repo + '/context/UIContext.tsx' : repo + '/App.tsx',
                    ),
                ).toThrow(/installed authority/);
        },
    );
    it('starts installed package loads closed and preserves selected legitimate package-internal resolution', () => {
        const plugin = createFullAppGraphIsolation();
        const sdkEntry = sdkRoot + '/dist/index.mjs',
            coreEntry = coreRoot + '/dist/index.js';
        expect(() => plugin.load(sdkEntry)).toThrow(/Unselected installed authority/);
        expect(() => plugin.load(pathToFileURL(coreEntry).href + '#bypass')).toThrow(/Unselected installed authority/);
        expect(plugin.resolveId('@supabase/supabase-js', researchSdk + '?query#fragment')).toBeNull();
        expect(plugin.resolveId('@capacitor/core', researchSdk)).toBeNull();
        expect(plugin.load(sdkEntry + '#fragment')).toBeNull();
        expect(plugin.load(coreEntry + '?query')).toBeNull();
        expect(plugin.resolveId('./lib/helpers.js', sdkEntry)).toBeNull();
        expect(plugin.resolveId('@supabase/auth-js', sdkEntry)).toBeNull();
        expect(plugin.resolveId('./definitions.js', coreEntry)).toBeNull();
        expect(() => plugin.resolveId('@capacitor/core', sdkEntry)).toThrow(/Cross-package authority/);
    });
    it('projects only ChatService retry classification without selecting an SDK or exporting client authority', () => {
        const plugin = createFullAppGraphIsolation();
        const selected = plugin.resolveId('@supabase/supabase-js', repo + '/services/ChatService.ts');
        expect(selected).toMatch(/^\0thalassa-full-app-closed:/);
        const code = plugin.load(selected!);
        expect(code).toBe('export function isAuthRetryableFetchError(){return false;}');
        expect(code).not.toMatch(/createClient|\bimport\b|node_modules|AuthClient/);
        expect(() => plugin.load(sdkRoot + '/dist/index.mjs')).toThrow(/Unselected installed authority/);
        expect(() =>
            plugin.resolveId('@supabase/supabase-js/dist/index.mjs', repo + '/services/ChatService.ts'),
        ).toThrow();
        expect(() => plugin.resolveId('@supabase/supabase-js', repo + '/services/OtherService.ts')).toThrow();
    });
    it('denies before dynamic full graph loading and excludes inherited env variables by configuration', () => {
        const source = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/entry.ts', import.meta.url),
            'utf8',
        );
        expect(source.indexOf('requireNativePrivateMessagesForProcess();')).toBeLessThan(
            source.indexOf('fence.install();'),
        );
        expect(source.indexOf('fence.install();')).toBeLessThan(source.indexOf("import('./main')"));
        const config = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/vite.config.mjs', import.meta.url),
            'utf8',
        );
        expect(config).toMatch(/envDir\s*:\s*false/);
        expect(config).toMatch(/envPrefix\s*:\s*\[\]/);
        expect(config).not.toMatch(/loadEnv|\.\.\/.*vite\.config/);
        const root = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/FullAppResearchRoot.tsx', import.meta.url),
            'utf8',
        );
        expect(root).toContain('normalizeAppPrivateMessageSelection(selection)');
        expect(root).toMatch(/App privateMessageSelection=\{closed\}/);
    });
});
describe('explicit unavailable backend and native proxies', () => {
    it('selects only the false voyage classifier and closed manager for the real Log-page importer', () => {
        const plugin = createFullAppGraphIsolation();
        const code = plugin.load(plugin.resolveId('../services/BgGeoManager', repo + '/pages/LogPage.tsx')!);
        expect(code).toContain('BgGeoManager,isVoyageLocationError');
        expect(code).toContain('boundaries.ts');
        expect(code).not.toContain('class VoyageLocationError');
        expect(code).not.toContain('node_modules');
        expect(() => plugin.load(repo + '/services/BgGeoManager.ts')).toThrow(/Production entry or authority/);
    });
    it('keeps current database helpers and anchor-age vocabulary behind only exact closed projections', () => {
        const plugin = createFullAppGraphIsolation();
        const database = plugin.load(plugin.resolveId('./LocalDatabase', repo + '/services/vessel/vaultFiles.ts')!);
        for (const name of ['identityFileToken', 'rewriteQueuedRecord', 'discardUnsentRecord'])
            expect(database).toContain(name);
        expect(database).toContain('boundaries.ts');
        expect(database).not.toContain('CachedPosition');
        expect(() => plugin.load(repo + '/services/vessel/LocalDatabase.ts')).toThrow(/Production entry or authority/);
        const anchor = plugin.load(
            plugin.resolveId(
                '../../services/AnchorWatchService',
                repo + '/components/anchor-watch/MoveAnchorSheet.tsx',
            )!,
        );
        expect(anchor).toContain('ANCHOR_RELOCATE_FIX_MAX_AGE_MS');
        expect(anchor).toContain('boundaries.ts');
        expect(() => plugin.load(repo + '/services/AnchorWatchService.ts')).toThrow(/Production entry or authority/);
    });
    it('projects the exact unavailable Auth fence export without selecting production Auth or Apple', () => {
        const plugin = createFullAppGraphIsolation();
        const id = plugin.resolveId('../../stores/authStore', repo + '/services/auth/SocialAuthService.ts');
        const code = plugin.load(id!);
        expect(code).toContain('fenceSignedOutOnThisDevice');
        expect(code).toContain('full-app-pilot/authStore.ts');
        expect(code).not.toContain('node_modules');
        expect(() => plugin.load(repo + '/stores/authStore.ts')).toThrow(/Production entry or authority/);
        expect(() => plugin.resolveId('@supabase/supabase-js', repo + '/services/auth/SocialAuthService.ts')).toThrow(
            /Unexpected runtime SDK dependency/,
        );
    });
    it('projects only the unavailable anchor distance helper without evaluating its production service', () => {
        const plugin = createFullAppGraphIsolation();
        const id = plugin.resolveId(
            '../../services/AnchorWatchService',
            repo + '/components/anchor-watch/swingRadiusSuggest.ts',
        );
        const code = plugin.load(id!);
        expect(code).toContain('haversineDistance');
        expect(code).toContain('boundaries.ts');
        expect(() => plugin.load(repo + '/services/AnchorWatchService.ts')).toThrow(/Production entry or authority/);
    });
    it('creates a separately closed graph for every module-worker build', () => {
        const config = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/vite.config.mjs', import.meta.url),
            'utf8',
        );
        expect(config).toMatch(
            /worker:\s*\{\s*format:\s*'es',\s*plugins:\s*\(\)\s*=>\s*\[createFullAppGraphIsolation\(\)\]/,
        );
        const main = createFullAppGraphIsolation();
        expect(main.resolveId('@supabase/supabase-js', researchSdk)).toBeNull();
        const worker = createFullAppGraphIsolation();
        expect(() => worker.load(sdkRoot + '/dist/index.mjs')).toThrow(/Unselected installed authority/);
        expect(() => worker.resolveId('@supabase/supabase-js', repo + '/services/engine/navGridWorker.ts')).toThrow(
            /Unexpected runtime SDK dependency/,
        );
    });
    it('closes the complete background manager and refuses its native runtime enum package', () => {
        const plugin = createFullAppGraphIsolation();
        const id = plugin.resolveId('../BgGeoManager', repo + '/services/shiplog/PositionResolver.ts');
        const code = plugin.load(id!);
        expect(code).toContain('export {BgGeoManager,isVoyageLocationError}');
        expect(code).toContain('boundaries.ts');
        expect(code).not.toContain('node_modules');
        expect(() => plugin.load(repo + '/services/BgGeoManager.ts')).toThrow(/Production entry or authority/);
        expect(() =>
            plugin.resolveId('@transistorsoft/background-geolocation-types', repo + '/services/BgGeoManager.ts'),
        ).toThrow(/Unmapped native dependency/);
        const native = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/nativeLeaves.ts', import.meta.url),
            'utf8',
        );
        expect(native).not.toMatch(/export const (?:ActivityType|AuthorizationStatus|DesiredAccuracy|LogLevel)\b/);
    });
    it('never creates a production client/profile/token store or mutation success', async () => {
        expect(supabase).toBeNull();
        expect(supabaseUrl).toBe('');
        expect(supabaseAnonKey).toBe('');
        expect(isSupabaseConfigured()).toBe(false);
        expect(await getCurrentUser()).toBeNull();
        expect(await getUserProfile('synthetic')).toBeNull();
        expect(await updateUserProfile('synthetic', {})).toBe(false);
        await expect(capacitorAuthStorage.setItem('not-a-token', 'synthetic')).rejects.toThrow(/unavailable/i);
        const getter = vi.fn(() => {
            throw new Error('Arguments must not be read');
        });
        captureException(Object.defineProperty({}, 'message', { get: getter }));
        expect(getter).not.toHaveBeenCalled();
        await expect(ensureSentryLoaded()).rejects.toThrow(/unavailable/i);
        expect(Object.values(readClosedBackendCounters()).every(Number.isSafeInteger)).toBe(true);
    });
    it('never invokes a registered implementation or unknown native method', async () => {
        const implementation = vi.fn(),
            getter = vi.fn(() => {
                throw new Error('Do not read native options');
            });
        const plugin = registerPlugin<{ invoke(options: unknown): Promise<unknown>; then?: unknown }>('Synthetic', {
            web: implementation,
        });
        expect(plugin.then).toBeUndefined();
        await expect(plugin.invoke(Object.defineProperty({}, 'credential', { get: getter }))).rejects.toThrow(
            /unavailable/i,
        );
        expect(implementation).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        expect(Capacitor.isPluginAvailable('ScuttlebuttResearchAuth')).toBe(false);
        expect(Capacitor.convertFileSrc('private-path')).toBe('');
        expect(readFullAppCoreCounters().methodAttempts).toBeGreaterThan(0);
    });
});
