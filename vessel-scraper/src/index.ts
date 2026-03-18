/**
 * Vessel Intelligence Scraper — "The Railroad"
 *
 * Standalone Node.js service for Railway.app deployment.
 * Runs every 15 minutes via Railway Cron.
 *
 * Priority-based scraping:
 *   P1: Australia (AMSA) — MID 503
 *   P2: USA (USCG) — MID 338/366-369
 *   P3: Europe (Equasis) — MID 200-299
 *   P4: Global (ITU MARS / GFW) — everything else
 *
 * Rate-limited: max 50 lookups per run, 2s between requests.
 */

import { getStaleOrMissingMmsis } from './supabase';
import { getScrapePriority } from './MmsiDecoder';
import { scrapeAmsa } from './scrapers/AmsaScraper';
import { scrapeUscg } from './scrapers/UscgScraper';
import { scrapeEquasis } from './scrapers/EquasisScraper';
import { scrapeItuMars } from './scrapers/ItuMarsScraper';

const MAX_PER_RUN = 50;

async function run(): Promise<void> {
    const startTime = Date.now();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🚂 THE RAILROAD — Vessel Intelligence Scraper`);
    console.log(`   Started at ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(60)}\n`);

    // 1. Get MMSIs that need scraping
    const staleMmsis = await getStaleOrMissingMmsis(7, 200);
    console.log(`📋 Found ${staleMmsis.length} vessels needing metadata`);

    if (staleMmsis.length === 0) {
        console.log('✅ All vessels have fresh metadata. Nothing to do.');
        return;
    }

    // 2. Group by scrape priority
    const priorityBuckets: Record<1 | 2 | 3 | 4, number[]> = {
        1: [], // Australia
        2: [], // USA
        3: [], // Europe
        4: [], // Global
    };

    for (const mmsi of staleMmsis) {
        const priority = getScrapePriority(mmsi);
        priorityBuckets[priority].push(mmsi);
    }

    console.log(`\n📊 Priority breakdown:`);
    console.log(`   P1 🇦🇺 Australia (AMSA):    ${priorityBuckets[1].length}`);
    console.log(`   P2 🇺🇸 USA (USCG):          ${priorityBuckets[2].length}`);
    console.log(`   P3 🇪🇺 Europe (Equasis):     ${priorityBuckets[3].length}`);
    console.log(`   P4 🌍 Global (ITU/GFW):      ${priorityBuckets[4].length}`);

    // 3. Scrape in priority order, respecting MAX_PER_RUN
    let totalScraped = 0;
    let remaining = MAX_PER_RUN;

    for (const priority of [1, 2, 3, 4] as const) {
        if (remaining <= 0) break;
        const batch = priorityBuckets[priority].slice(0, remaining);
        if (batch.length === 0) continue;

        console.log(`\n── Priority ${priority} ──`);

        let scraped = 0;
        switch (priority) {
            case 1:
                scraped = await scrapeAmsa(batch);
                break;
            case 2:
                scraped = await scrapeUscg(batch);
                break;
            case 3:
                scraped = await scrapeEquasis(batch);
                break;
            case 4:
                scraped = await scrapeItuMars(batch);
                break;
        }

        totalScraped += scraped;
        remaining -= batch.length;
    }

    // 4. Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏁 COMPLETE: ${totalScraped} vessels enriched in ${duration}s`);
    console.log(`${'═'.repeat(60)}\n`);
}

// Run and exit
run()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('💥 Fatal error:', e);
        process.exit(1);
    });
