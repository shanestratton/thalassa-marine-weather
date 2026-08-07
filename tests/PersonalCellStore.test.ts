import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

/**
 * The personal ENC store lets a skipper's OWN charts reach their OWN browser.
 * Two properties make that legitimate rather than redistribution, and both are
 * structural — no behavioural test would catch either regressing, because in
 * both cases the feature keeps working and only the boundary moves.
 */
describe('personal ENC cell store', () => {
    const migration = read('supabase/migrations/20260807093000_personal_enc_cells.sql');
    const service = codeOf('services/enc/personalCellSync.ts');

    describe('licensing boundary', () => {
        it('no longer lets any authenticated user read the whole bucket', () => {
            // The 2026-07-08 policy was `using (bucket_id = 'enc-cells')` with
            // no path predicate. Left in place, every skipper's private cells
            // would be readable by every other signed-in account the moment
            // this feature uploaded anything.
            expect(migration).toContain('drop policy if exists "enc cells authenticated read"');
            const sharedRead = migration.slice(migration.indexOf('create policy "enc cells shared read"'));
            expect(sharedRead.slice(0, 300)).toContain("name not like 'u/%'");
        });

        it('scopes every personal-prefix policy to the owner', () => {
            // Read, insert, update and delete must ALL be owner-scoped. A
            // missing insert check would let one account write into another's
            // folder; a missing update WITH CHECK would let an object be moved
            // out of the owner's prefix.
            for (const verb of ['read', 'insert', 'update', 'delete']) {
                const start = migration.indexOf(`create policy "enc cells owner ${verb}"`);
                expect(start, `owner ${verb} policy missing`).toBeGreaterThan(-1);
                const next = migration.indexOf('drop policy', start);
                const body = next > 0 ? migration.slice(start, next) : migration.slice(start);
                expect(body, `owner ${verb} not scoped to auth.uid()`).toContain(
                    '(storage.foldername(name))[2] = auth.uid()::text',
                );
            }
            const update = migration.slice(migration.indexOf('create policy "enc cells owner update"'));
            const updateBody = update.slice(0, update.indexOf('drop policy'));
            expect(updateBody).toContain('using (');
            expect(updateBody).toContain('with check (');
        });

        it('namespaces objects under the exact prefix the policies match', () => {
            // The policies key on foldername()[1] = 'u'. If the client ever
            // writes a different prefix, uploads fail closed rather than
            // leaking — but the feature silently stops working, so pin it.
            expect(service).toContain('`u/${userId}`');
        });
    });

    describe('two publishers, two markers', () => {
        it('marks personal cells with a field the curated sweep ignores', () => {
            // cloudCellSync.reconcileManifest retires every cell carrying
            // `cloudManifestVersion` that is absent from the curated manifest.
            // A personal cell is absent from it by definition, so reusing that
            // marker would make each one delete itself on the next curated
            // sync — charts vanishing with no error anywhere.
            expect(service).toContain('personalManifestVersion');
            const importCall = service.slice(service.indexOf('const { importCell }'));
            expect(importCall.slice(0, 400)).toContain('personalManifestVersion: snapshot.manifest.version');
            expect(importCall.slice(0, 400)).not.toContain('cloudManifestVersion');
        });

        it('keeps the curated sweep keyed on cloudManifestVersion alone', () => {
            const cloud = codeOf('services/enc/cloudCellSync.ts');
            const sweep = cloud.slice(cloud.indexOf('async function reconcileManifest'));
            const body = sweep.slice(0, sweep.indexOf('async function ensureActiveManifest'));
            expect(body).toContain('cloudManifestVersion !== undefined');
            expect(body).not.toContain('personalManifestVersion');
        });
    });

    describe('publish safety', () => {
        it('never republishes curated cells into the personal folder', () => {
            // They are already readable at the bucket root. Copying them would
            // burn ~55 MB of the account's quota to duplicate what it can
            // already fetch.
            const publishable = service.slice(service.indexOf('function isPublishable'));
            expect(publishable.slice(0, 300)).toContain('cloudManifestVersion !== undefined');
        });

        it('never triggers a download to satisfy a publish', () => {
            // loadCellGeoJSON's remote fallback would otherwise pull a cell
            // down just to push it straight back up.
            const upload = service.slice(service.indexOf('const uploadOne'));
            expect(upload.slice(0, 400)).toContain('loadCellGeoJSON(cell.id, false)');
        });

        it('writes the manifest only over cells that actually landed', () => {
            // A manifest naming a failed upload leaves the browser registering
            // a pending cell whose blob 404s forever: it appears in the list
            // and never draws.
            const publish = service.slice(service.indexOf('export async function publishPersonalCells'));
            const landed = publish.indexOf('landed.set(');
            const manifestWrite = publish.indexOf('manifestPath(userId)');
            expect(landed).toBeGreaterThan(-1);
            expect(manifestWrite).toBeGreaterThan(landed);
            expect(publish).toContain('const merged = new Map(publishedEntries);');
        });

        it('validates downloaded bytes through the shared import transaction', () => {
            // Own-account bytes are not a reason to skip validation — this is
            // what stops a truncated upload becoming a routing-grade chart.
            expect(service).toContain('validateLocalEncPack');
            expect(service).toContain('payload identity does not match its manifest path');
        });
    });

    it('serves the browser as the last hydration rung', () => {
        // Anchor on the CALL, not the bare identifier: `downloadPersonalCell`
        // also appears in the `await import(...)` destructure one line above,
        // so matching the name alone still passed with the rung deleted.
        const store = codeOf('services/enc/EncCellStore.ts');
        const fallback = store.slice(store.indexOf('if (remoteFallback)'));
        const pi = fallback.indexOf('await downloadPiCell(cellId)');
        const cloud = fallback.indexOf('await downloadCloudCell(cellId)');
        const personal = fallback.indexOf('await downloadPersonalCell(cellId)');
        expect(pi, 'Pi rung missing').toBeGreaterThan(-1);
        expect(cloud, 'cloud rung missing').toBeGreaterThan(pi);
        expect(personal, 'personal rung missing').toBeGreaterThan(cloud);
    });

    /**
     * Every path that fetches a remote cell needs the personal rung — there
     * are THREE, and they do not share one ladder. Adding it to
     * loadCellGeoJSON alone left published charts registering and never
     * drawing: the hydration walk calls downloadCloudCell directly, so a
     * personal-only cell failed its cloud fetch and sat in the failure
     * cooldown. Found 2026-08-07 after a clean publish showed nothing on
     * /plan.
     */
    describe('all three remote-fetch paths know about personal cells', () => {
        it('hydrates pending cells from the personal store when the curated fetch misses', () => {
            const hazard = codeOf('services/enc/EncHazardService.ts');
            const walk = hazard.slice(hazard.indexOf('async function hydrateMissingCells'));
            expect(walk).toContain('downloadPersonalCell');
            // The walk must actually CALL it, not merely import it.
            expect(walk).toContain('(await downloadCloudCell(id)) || downloadPersonalCell(id)');
            expect(walk).toContain('const ok = await downloadRemoteCell(id);');
        });

        it('fills a route corridor from personal cells too', () => {
            // downloadCloudCellsForBBox filters on cloudManifestVersion, which
            // a personal cell never carries — so it is invisible there by
            // construction and needs its own pass.
            const cloud = codeOf('services/enc/cloudCellSync.ts');
            const fill = cloud.slice(cloud.indexOf('export async function downloadCloudCellsForBBox'));
            expect(fill).toContain('downloadPersonalCellsForBBox');
            expect(service).toContain('export async function downloadPersonalCellsForBBox');
            const personalFill = service.slice(service.indexOf('export async function downloadPersonalCellsForBBox'));
            expect(personalFill.slice(0, 900)).toContain('cell.personalManifestVersion === undefined');
        });

        it('stops reporting "no bucket" for an account with only its own charts', () => {
            // The old unconditional `if (!activeManifest) return
            // bucketAvailable: false` reads to callers as "sign in / offline",
            // which is wrong for someone whose only charts are their own.
            const cloud = codeOf('services/enc/cloudCellSync.ts');
            const fill = cloud.slice(cloud.indexOf('export async function downloadCloudCellsForBBox'));
            expect(fill).toContain('bucketAvailable: Boolean(activeManifest) || personal.available');
            expect(fill).not.toContain(
                'if (!activeManifest) return { downloaded: 0, needed: 0, bucketAvailable: false };',
            );
        });
    });

    it('does not auto-publish before the skipper has opted in', () => {
        // Run one is ~400 MB and there is no Wi-Fi/cellular signal available
        // in this app, so it must never fire on its own.
        const auto = service.slice(service.indexOf('export async function publishNewCellsIfEnabled'));
        expect(auto.slice(0, 200)).toContain('if (!isAutoPublishEnabled()) return;');
    });
});
