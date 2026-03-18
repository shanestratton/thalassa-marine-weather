/**
 * Vessel Intelligence Scraper — "The Railroad"
 *
 * Standalone Node.js service for Railway.app deployment.
 * Runs every 15 minutes via Railway Cron.
 *
 * Two-phase approach:
 *   Phase 1 — AIS SEED: Populate vessel_metadata from existing AIS data
 *             in the `vessels` table + MMSI decoder (flag, country, ship type).
 *             No external APIs. Guarantees all vessels get basic metadata.
 *
 *   Phase 2 — ENRICHMENT: Attempt external government APIs to add
 *             verified data (official name, dimensions, photos).
 *             Failures are non-fatal — Phase 1 data persists.
 *
 * Priority-based enrichment:
 *   P1: Australia (AMSA) — MID 503
 *   P2: USA (USCG) — MID 338/366-369
 *   P3: Europe (Equasis) — MID 200-299
 *   P4: Global (ITU MARS / GFW) — everything else
 *
 * Rate-limited: max 50 external lookups per run, 2s between requests.
 */

import { getStaleOrMissingMmsis } from './supabase';
import { getScrapePriority } from './MmsiDecoder';
import { seedFromAis } from './scrapers/AisSeedScraper';
import { scrapeAmsa } from './scrapers/AmsaScraper';
import { scrapeUscg } from './scrapers/UscgScraper';
import { scrapeEquasis } from './scrapers/EquasisScraper';
import { scrapeItuMars } from './scrapers/ItuMarsScraper';

const MAX_EXTERNAL_PER_RUN = 50;
const SEED_BATCH_SIZE = 500;

async function run(): Promise<void> {
    const startTime = Date.now();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🚂 THE RAILROAD — Vessel Intelligence Scraper v2`);
    console.log(`   Started at ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(60)}\n`);

    // ══════════════════════════════════════════════════════════════
    // PHASE 1: AIS SEED — populate from existing vessels table
    // ══════════════════════════════════════════════════════════════

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📡 PHASE 1: AIS Self-Seed`);
    console.log(`${'─'.repeat(50)}\n`);

    const staleMmsis = await getStaleOrMissingMmsis(7, SEED_BATCH_SIZE);
    console.log(`📋 Found ${staleMmsis.length} vessels needing metadata`);

    let seeded = 0;
    if (staleMmsis.length > 0) {
        // Seed all stale MMSIs from AIS data (up to 200 per run)
        seeded = await seedFromAis(staleMmsis);
        console.log(`✅ Phase 1 complete: ${seeded} vessels seeded from AIS data`);
    } else {
        console.log('✅ All vessels have fresh metadata. Nothing to seed.');
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE 2: EXTERNAL ENRICHMENT — government registries
    // ══════════════════════════════════════════════════════════════

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🌐 PHASE 2: External Enrichment`);
    console.log(`${'─'.repeat(50)}\n`);

    // Get vessels that were just seeded but could benefit from verified data
    // Only try external APIs for vessels whose data_source is still 'AIS'
    const enrichCandidates = staleMmsis.slice(0, MAX_EXTERNAL_PER_RUN);

    if (enrichCandidates.length === 0) {
        console.log('⏭️  No candidates for external enrichment.');
    } else {
        // Group by priority
        const priorityBuckets: Record<1 | 2 | 3 | 4, number[]> = {
            1: [], 2: [], 3: [], 4: [],
        };

        for (const mmsi of enrichCandidates) {
            const priority = getScrapePriority(mmsi);
            priorityBuckets[priority].push(mmsi);
        }

        console.log(`📊 Priority breakdown:`);
        console.log(`   P1 🇦🇺 Australia (AMSA):    ${priorityBuckets[1].length}`);
        console.log(`   P2 🇺🇸 USA (USCG):          ${priorityBuckets[2].length}`);
        console.log(`   P3 🇪🇺 Europe (Equasis):     ${priorityBuckets[3].length}`);
        console.log(`   P4 🌍 Global (ITU/GFW):      ${priorityBuckets[4].length}`);

        let totalEnriched = 0;

        for (const priority of [1, 2, 3, 4] as const) {
            const batch = priorityBuckets[priority];
            if (batch.length === 0) continue;

            console.log(`\n── Priority ${priority} ──`);

            try {
                let enriched = 0;
                switch (priority) {
                    case 1: enriched = await scrapeAmsa(batch); break;
                    case 2: enriched = await scrapeUscg(batch); break;
                    case 3: enriched = await scrapeEquasis(batch); break;
                    case 4: enriched = await scrapeItuMars(batch); break;
                }
                totalEnriched += enriched;

                if (enriched === 0) {
                    console.warn(`⚠️  P${priority} returned 0 results — API may be unreachable`);
                }
            } catch (err) {
                // Non-fatal — Phase 1 data is already saved
                console.error(`❌ P${priority} scraper crashed (non-fatal):`, err);
            }
        }

        console.log(`\n✅ Phase 2 complete: ${totalEnriched} vessels enriched via external APIs`);
    }

    // ══════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏁 COMPLETE in ${duration}s`);
    console.log(`   Phase 1 (AIS Seed):       ${seeded} vessels`);
    console.log(`   Phase 2 (External):       attempted ${enrichCandidates.length}`);
    console.log(`${'═'.repeat(60)}\n`);
}

// Run and exit
run()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('💥 Fatal error:', e);
        process.exit(1);
    });
