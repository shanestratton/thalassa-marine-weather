#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const migrationDirectory = path.resolve('supabase/migrations');
const grandfathered = new Set(['001_anchor_alarm_push.sql']);
const canonicalName = /^(\d{8,14})_[a-z0-9_]+\.sql$/;

/**
 * SECURITY DEFINER hygiene.
 *
 * A definer function runs as its owner. Two defaults make that dangerous and
 * both are silent:
 *
 *   - no `SET search_path` — a caller who can create objects shadows an
 *     unqualified name inside the body and it executes as postgres;
 *   - EXECUTE defaults to PUBLIC, which on Supabase means the `anon` key that
 *     ships inside the web bundle.
 *
 * A July 2026 hardening pass fixed the functions that existed then, by
 * enumeration, so everything older kept the unsafe defaults. That was found
 * the hard way: as `anon`, `user_display_name()` returned a real name out of
 * `auth.users` (fixed in 20260728150000). Enumeration does not hold a line —
 * a check does. Every NEW migration that creates a definer function must pin
 * its search_path and say who may execute it.
 *
 * Pre-existing offenders are listed below rather than rewritten: their
 * functions are already corrected in the live database by later migrations,
 * and editing applied migrations would desync every deployed environment.
 */
const definerHygieneGrandfathered = new Set([
    // Seeded from the 19 files that predate this check. Their functions are
    // already corrected in the live database — 20260728150000 pinned the last
    // 11 unpinned definers and revoked PUBLIC where nothing called them, and
    // the catalogue now reports zero unpinned. Rewriting applied migrations
    // would desync every deployed environment, so the files stay as history.
    //
    // DO NOT ADD TO THIS LIST. Fix the migration instead.
    '20260207_shared_tracks.sql',
    '20260212070000_chat_tables.sql',
    '20260220080000_update_trigger_types.sql',
    '20260306_push_queue_trigger.sql',
    '20260318070000_ais_freshness.sql',
    '20260318080000_ais_vessels.sql',
    '20260319070000_guardian_profiles.sql',
    '20260319080000_guardian_alerts.sql',
    '20260319090100_search_vessels.sql',
    '20260319090200_vessel_metadata.sql',
    '20260319090300_guardian_watchdog_rpcs.sql',
    '20260319100000_push_hardening.sql',
    '20260516130000_crew_to_boat_bridge.sql',
    '20260516140000_voyage_log_byline_parts.sql',
    '20260516150000_voyage_log_name_metadata.sql',
    '20260723100000_crew_manifest_hardening.sql',
    '20260723101000_marketplace_pin_bcrypt.sql',
    '20260723104000_passage_permission_rls.sql',
    '20260727131000_crew_list_conversation_hardening.sql',
]);

/**
 * Tables whose RLS was disabled before this check existed. Both are now
 * re-enabled by 20260730090000_enable_rls_on_reference_tables.sql, but the
 * original migrations stay as applied history — editing them would desync
 * every deployed environment.
 *
 * DO NOT ADD TO THIS LIST. RLS off on a PostgREST-exposed table means the anon
 * key that ships in the client bundle is the only thing between the public and
 * your rows.
 */
const rlsDisableGrandfathered = new Set(['20260516160000_linz_warnings.sql', '20260516170000_australian_ports.sql']);

const entries = (await readdir(migrationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

const errors = [];
const versions = new Map();

for (const filename of entries) {
    if (grandfathered.has(filename)) continue;

    const match = filename.match(canonicalName);
    if (!match) {
        errors.push(`${filename}: migration names must start with an 8–14 digit version`);
        continue;
    }

    const version = match[1];
    const previous = versions.get(version);
    if (previous) {
        errors.push(`${filename}: version ${version} is already used by ${previous}`);
    } else {
        versions.set(version, filename);
    }

    const sql = await readFile(path.join(migrationDirectory, filename), 'utf8');

    // ── RLS must not be switched off on a PostgREST-exposed table ──────────
    // A comment asserting "only service-role touches this" is intent, not
    // enforcement: with RLS off the gate is the GRANT, and Supabase grants
    // privileges on public tables by default. linz_warnings held in-force
    // navigational warnings and was writable by the anon key in the bundle.
    if (!rlsDisableGrandfathered.has(filename)) {
        for (const m of sql.matchAll(
            /ALTER\s+TABLE\s+(?:public\.)?([a-z0-9_]+)\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
        )) {
            const table = m[1];
            // The only defensible form is an explicit REVOKE of the client
            // roles in the same migration, so the exposure is stated and
            // reviewable rather than inherited.
            const revoked = new RegExp(
                `REVOKE[\\s\\S]{0,400}?ON\\s+(?:TABLE\\s+)?(?:public\\.)?${table}\\b[\\s\\S]{0,200}?(anon|authenticated)`,
                'i',
            ).test(sql);
            if (!revoked) {
                errors.push(
                    `${filename}: ${table} has RLS DISABLED with no REVOKE from anon/authenticated — ` +
                        `the anon key ships in the client bundle`,
                );
            }
        }
    }

    if (definerHygieneGrandfathered.has(filename)) continue;
    // Split on the dollar-quoted body terminator so each chunk holds at most
    // one function definition; crude, but it keeps a later function's pin
    // from vouching for an earlier one's omission.
    for (const chunk of sql.split(/\$\$;/)) {
        if (!/SECURITY\s+DEFINER/i.test(chunk)) continue;

        const declared = chunk.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)/i);
        if (!declared) continue;
        const fn = declared[1];

        if (!/SET\s+search_path\s*=/i.test(chunk)) {
            errors.push(`${filename}: ${fn}() is SECURITY DEFINER without SET search_path`);
        }
        // Reachability has to be stated somewhere in the file — either the
        // default PUBLIC grant is revoked, or execution is granted to named
        // roles deliberately. Silence means it inherited PUBLIC.
        const revoked = new RegExp(`REVOKE[\\s\\S]{0,400}?ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\b`, 'i').test(sql);
        const granted = new RegExp(`GRANT[\\s\\S]{0,400}?ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\b`, 'i').test(sql);
        if (!revoked && !granted) {
            errors.push(
                `${filename}: ${fn}() is SECURITY DEFINER with no REVOKE/GRANT — it inherits EXECUTE TO PUBLIC`,
            );
        }
    }
}

if (errors.length > 0) {
    console.error('Supabase migration audit failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
} else {
    console.log(`Supabase migration audit passed (${entries.length} files).`);
}
