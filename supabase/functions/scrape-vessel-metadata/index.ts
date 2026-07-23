/**
 * scrape-vessel-metadata — Supabase Edge Function (Cron).
 *
 * Two-phase vessel enrichment run, scheduled every 15 min via pg_cron.
 * Ported from the Railway-hosted `vessel-scraper` worker so we have one
 * fewer long-running container to pay for.
 *
 *   Phase 1 — AIS SEED: populate vessel_metadata from the existing
 *             `vessels` table + MMSI decoder. No external APIs, always
 *             succeeds, guarantees baseline coverage.
 *
 *   Phase 2 — ENRICHMENT: priority-bucket the stale MMSIs and hit
 *             AMSA / USCG / Equasis / ITU-MARS for verified identity
 *             and dimensions. Per-scraper failures are non-fatal.
 *
 * MAX_EXTERNAL_PER_RUN is 30 here (vs 50 on Railway) so the whole run
 * stays comfortably under the 150 s edge-function wall-clock limit.
 * Per-request rate limits are preserved.
 */
import { getStaleOrMissingMmsis } from './_shared/supabase.ts';
import { getScrapePriority } from './_shared/MmsiDecoder.ts';
import { seedFromAis } from './_shared/scrapers/AisSeedScraper.ts';
import { scrapeAmsa } from './_shared/scrapers/AmsaScraper.ts';
import { scrapeUscg } from './_shared/scrapers/UscgScraper.ts';
import { scrapeEquasis } from './_shared/scrapers/EquasisScraper.ts';
import { scrapeItuMars } from './_shared/scrapers/ItuMarsScraper.ts';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';

// Each source deliberately sleeps between requests and may retry a second
// registry. Eight candidates keeps the worst case below the edge/pg_net
// deadline while the 15-minute cron steadily drains the queue.
const MAX_EXTERNAL_PER_RUN = 8;
const SEED_BATCH_SIZE = 500;

interface RunSummary {
    durationSec: number;
    phase1Seeded: number;
    phase2Attempted: number;
    phase2Enriched: number;
    priorityBreakdown: Record<'1' | '2' | '3' | '4', number>;
}

async function run(): Promise<RunSummary> {
    const startTime = Date.now();

    // ── Phase 1: AIS self-seed ──
    const staleMmsis = await getStaleOrMissingMmsis(7, SEED_BATCH_SIZE);
    console.log(`[PHASE 1] ${staleMmsis.length} vessels needing metadata`);

    let seeded = 0;
    if (staleMmsis.length > 0) {
        seeded = await seedFromAis(staleMmsis);
    }

    // ── Phase 2: external enrichment ──
    const enrichCandidates = staleMmsis.slice(0, MAX_EXTERNAL_PER_RUN);
    const priorityBuckets: Record<1 | 2 | 3 | 4, number[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const mmsi of enrichCandidates) {
        priorityBuckets[getScrapePriority(mmsi)].push(mmsi);
    }

    let totalEnriched = 0;
    if (enrichCandidates.length > 0) {
        console.log(
            `[PHASE 2] P1(AU)=${priorityBuckets[1].length} P2(US)=${priorityBuckets[2].length}`,
            `P3(EU)=${priorityBuckets[3].length} P4(GL)=${priorityBuckets[4].length}`,
        );

        for (const priority of [1, 2, 3, 4] as const) {
            const batch = priorityBuckets[priority];
            if (batch.length === 0) continue;

            try {
                let enriched = 0;
                switch (priority) {
                    case 1:
                        enriched = await scrapeAmsa(batch);
                        break;
                    case 2:
                        enriched = await scrapeUscg(batch);
                        break;
                    case 3:
                        enriched = await scrapeEquasis(batch);
                        break;
                    case 4:
                        enriched = await scrapeItuMars(batch);
                        break;
                }
                totalEnriched += enriched;
            } catch (err) {
                // Phase-1 rows are already saved; log and move on.
                console.error(`[PHASE 2] P${priority} crashed (non-fatal):`, err);
            }
        }
    }

    const durationSec = Number(((Date.now() - startTime) / 1000).toFixed(1));
    console.log(
        `[DONE] ${durationSec}s — seeded=${seeded} attempted=${enrichCandidates.length} enriched=${totalEnriched}`,
    );

    return {
        durationSec,
        phase1Seeded: seeded,
        phase2Attempted: enrichCandidates.length,
        phase2Enriched: totalEnriched,
        priorityBreakdown: {
            '1': priorityBuckets[1].length,
            '2': priorityBuckets[2].length,
            '3': priorityBuckets[3].length,
            '4': priorityBuckets[4].length,
        },
    };
}

Deno.serve(async (req: Request) => {
    const authorizationFailure = requireServiceRolePost(req, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (authorizationFailure) return authorizationFailure;

    try {
        const summary = await run();
        return jsonResponse({ ok: true, ...summary, timestamp: new Date().toISOString() });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[FATAL]', message);
        return jsonResponse({ ok: false, error: 'Vessel metadata scrape failed' }, 500);
    }
});
