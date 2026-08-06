import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import { PUBLIC_BETA_HELD_CAPABILITIES } from '../scripts/public-beta-feature-profile.mjs';

const registry = readFileSync('viewRegistry.tsx', 'utf8');
const service = readFileSync('services/GuardianService.ts', 'utf8');
const vesselHub = readFileSync('components/VesselHub.tsx', 'utf8');
const migration = readFileSync('supabase/migrations/20260804191000_guardian_presence_privacy.sql', 'utf8');
const profile = JSON.parse(readFileSync('config/public-beta-features.json', 'utf8'));

/**
 * Guardian was held for the public beta because its server contract could not
 * stop a hostile authenticated client from spoofing movement and scanning for
 * nearby vessels. Migration 20260804191000_guardian_presence_privacy.sql closed
 * that, and the hold was lifted on 2026-08-06.
 *
 * This file now guards the LIFT: the client entry points are live, and the
 * server-side properties that made lifting defensible are still in the tree. If
 * any of those properties is reverted, Guardian must go back behind the flag
 * rather than silently keep shipping.
 */
describe('Guardian public-beta release', () => {
    it('exposes every public client entry point', () => {
        expect(FEATURE_VISIBILITY.guardian).toBe(true);
        expect(registry).toContain('FEATURE_VISIBILITY.guardian ? LiveGuardianPage : GuardianBetaHoldPage');
        expect(vesselHub).toContain('{FEATURE_VISIBILITY.guardian && (');
        // The safety row grows back to four tiles: MOB, Radio, Guardian, Anchor.
        expect(vesselHub).toContain("FEATURE_VISIBILITY.guardian ? 'grid-cols-4' : 'grid-cols-3'");
    });

    it('no longer claims Guardian as a held capability in the release manifest', () => {
        expect(PUBLIC_BETA_HELD_CAPABILITIES).not.toContain('guardian');
        expect(profile.heldCapabilities).not.toContain('guardian');
    });

    it('keeps the discovery boundary that justified the lift', () => {
        // Discovery searches from the caller's own stored presence — there is
        // no query point to aim somewhere else.
        expect(migration).toMatch(/DROP FUNCTION public\.thalassa_users_nearby/i);
        expect(migration).not.toMatch(/nearby_guardians\(query_lat/i);
        expect(service).toContain("rpc('nearby_guardians'");
        // A client can only move its own armed row, never another vessel's.
        expect(migration).toMatch(/guardian_heartbeat[\s\S]*WHERE user_id = auth\.uid\(\)[\s\S]*armed IS TRUE/i);
        // Disarming removes you from the index rather than freezing a position.
        expect(migration).toMatch(/guardian_disarm[\s\S]*last_known_lat\s*=\s*NULL[\s\S]*last_known_at\s*=\s*NULL/i);
        // Both discovery RPCs stay rate limited.
        expect(migration).toContain("consume_edge_quota('guardian_heartbeat', 180, 3600)");
        expect(migration).toContain("consume_edge_quota('guardian_nearby', 180, 3600)");
        // Disarmed profiles cannot craft location broadcasts.
        expect(migration).toMatch(/guardian_require_armed_user_broadcast[\s\S]*gp\.armed IS TRUE/i);
    });
});
