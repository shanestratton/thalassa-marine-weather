import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createPublicBetaFeatureArtifact,
    publicBetaCredentialPresenceFromEnvironment,
    publicBetaFeatureArtifactFailures,
    publicBetaFeatureDefines,
    publicBetaFeatureEnvironmentConflicts,
    readPublicBetaFeatureProfile,
} from '../scripts/public-beta-feature-profile.mjs';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');
const profile = readPublicBetaFeatureProfile(root);
const allRequiredCredentialsPresent = Object.fromEntries(
    profile.requiredCredentialPresence.map((name: string) => [name, true]),
);

describe('committed public-beta feature profile', () => {
    it('parks every hosted marine overlay until its publication cutover passes', () => {
        // Cutover state, 2026-08-07. Currents/SST/CHL are ON because their
        // manifest-v2 endpoints now actually serve (verified 200 with real
        // generations); they were held while the publisher deadlocked on a
        // missing-asset message it did not recognise, so every pipeline failed
        // and the API answered 502 "No valid dataset manifest slot".
        //
        // Waves, sea ice and MLD stay OFF and are additionally in
        // PARKED_SEA_LAYERS — Shane parked them from the pickers on
        // 2026-07-18 as irrelevant to a coastal passage. Two independent
        // reasons; turning the flag on alone would not surface them.
        //
        // MPA stays OFF: its pipeline has not been re-run since the fix.
        expect(profile.featureFlags).toEqual({
            VITE_CMEMS_CURRENTS_ENABLED: true,
            VITE_CMEMS_WAVES_ENABLED: false,
            VITE_CMEMS_SST_ENABLED: true,
            VITE_CMEMS_CHL_ENABLED: true,
            VITE_CMEMS_SEAICE_ENABLED: false,
            VITE_CMEMS_MLD_ENABLED: false,
            VITE_MPA_ENABLED: false,
            VITE_APPLE_SIGN_IN_ENABLED: false,
            // RELEASED 2026-08-10: MusicKit App Service live on the App ID,
            // usage description shipped, native plugin restored to Sources.
            VITE_APPLE_MUSIC_ENABLED: true,
            VITE_APPLE_WATCH_ENABLED: false,
            VITE_GOOGLE_SIGN_IN_ENABLED: false,
            VITE_ACCOUNT_DELETION_ENABLED: false,
            VITE_GRANT_ALL_FEATURES: false,
            VITE_ENABLE_ENC_DEMO_SAMPLES: false,
            VITE_WX_SERVER_ENABLED: false,
        });
        expect(profile.publicEndpoints).toEqual({
            VITE_DEEPGRAM_PROXY_URL: 'https://thalassa-deepgram-proxy.thalassacalypso.workers.dev',
            VITE_NATIVE_API_BASE: 'https://thalassawx.vercel.app/api',
            VITE_WX_SERVER_BASE: '',
        });
        expect(profile.heldCapabilities).toEqual([
            'apple-sign-in',
            'apple-watch-bridge',
            'account-deletion',
            'gmail',
            'grant-all-features',
            'enc-demo-samples',
            'private-weather-server',
            'community-precise-track-sharing',
            // 'musickit' released 2026-08-10 — governed by the flag-agreement
            // gate now, not a hold.
            'aishub-contribution',
            'retired-public-float-plan',
            // Parked 2026-08-09. Note this is the CONSOLE only — MAYDAY, DSC
            // and radio position read-out go through safetyTts and are not held.
            'calypso-voice-console',
            'calypso-proactive-alerts',
            'billing',
            'private-recipe-photos',
            'unverified-commercial-chart-packages',
            'spoonacular-online-catalogue',
        ]);
        expect(profile.requiredAbsentClientConfig).toEqual(['VITE_GOOGLE_OAUTH_CLIENT_ID']);
        expect(profile.requiredCredentialPresence).toEqual(['VITE_OWM_API_KEY', 'VITE_SENTRY_DSN']);
    });

    it('turns the committed profile into exact Vite defines, including held empty config', () => {
        const define = publicBetaFeatureDefines(profile);

        for (const [key, enabled] of Object.entries(profile.featureFlags)) {
            expect(define[`import.meta.env.${key}`]).toBe(JSON.stringify(String(enabled)));
        }
        for (const [key, endpoint] of Object.entries(profile.publicEndpoints)) {
            expect(define[`import.meta.env.${key}`]).toBe(JSON.stringify(endpoint));
        }
        expect(define['import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID']).toBe(JSON.stringify(''));
    });

    it('fails production when a supplied feature or endpoint override disagrees', () => {
        expect(
            publicBetaFeatureEnvironmentConflicts(profile, {
                VITE_CMEMS_WAVES_ENABLED: 'true',
                VITE_MPA_ENABLED: 'false',
                VITE_NATIVE_API_BASE: profile.publicEndpoints.VITE_NATIVE_API_BASE,
            }),
        ).toEqual(['VITE_CMEMS_WAVES_ENABLED']);
        expect(
            publicBetaFeatureEnvironmentConflicts(profile, {
                VITE_CMEMS_WAVES_ENABLED: 'false',
                VITE_MPA_ENABLED: 'false',
            }),
        ).toEqual([]);
    });

    it('emits a deterministic fingerprint and credential presence without credential values', () => {
        const credentialValues = {
            VITE_OWM_API_KEY: 'test-only-owm-value',
            VITE_SENTRY_DSN: 'https://test-only-sentry-value.invalid/1',
        };
        const presence = publicBetaCredentialPresenceFromEnvironment(profile, credentialValues);
        const first = createPublicBetaFeatureArtifact(profile, presence);
        const second = createPublicBetaFeatureArtifact(profile, presence);
        const serialized = JSON.stringify(first);

        expect(first).toEqual(second);
        expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(first.credentialPresence).toEqual(allRequiredCredentialsPresent);
        expect(serialized).not.toContain(credentialValues.VITE_OWM_API_KEY);
        expect(serialized).not.toContain(credentialValues.VITE_SENTRY_DSN);
        expect(publicBetaFeatureArtifactFailures(first, profile, allRequiredCredentialsPresent)).toEqual([]);
    });

    it('rejects an artifact whose feature, presence, or fingerprint drifts', () => {
        const artifact = createPublicBetaFeatureArtifact(profile, allRequiredCredentialsPresent);
        const drifted = structuredClone(artifact);
        drifted.featureFlags.VITE_CMEMS_WAVES_ENABLED = true;
        drifted.credentialPresence.VITE_SENTRY_DSN = false;

        expect(publicBetaFeatureArtifactFailures(drifted, profile, allRequiredCredentialsPresent)).toEqual(
            expect.arrayContaining([
                'VITE_CMEMS_WAVES_ENABLED must equal false',
                'VITE_SENTRY_DSN must be present at build time',
                'feature manifest fingerprint does not match',
            ]),
        );
    });

    it('pins production build and CI verification to the committed profile', () => {
        const vite = read('vite.config.ts');
        const gate = read('scripts/check-beta-readiness.mjs');
        const verifier = read('scripts/verify-web-release.mjs');
        const pkg = JSON.parse(read('package.json'));

        expect(vite).toContain("name: 'release-public-beta-feature-manifest'");
        expect(vite).toContain('publicBetaFeatureEnvironmentConflicts(publicBetaFeatureProfile');
        expect(vite).toContain('Production environment disagrees with config/public-beta-features.json');
        expect(gate).toContain('committed public-beta profile owns the exact map features');
        expect(gate).toContain('every artifact-declared held capability has an exact source-level release boundary');
        expect(gate).toContain('web artifact exposes the deterministic public-beta feature profile');
        expect(verifier).toContain('publicBetaFeatureArtifactFailures');
        expect(pkg.scripts.build).toContain('vite build');

        for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/lighthouse.yml']) {
            const workflow = read(workflowPath);
            expect(workflow).toContain('VITE_OWM_API_KEY: ${{ vars.VITE_OWM_API_KEY }}');
            expect(workflow).toContain('VITE_SENTRY_DSN: ${{ vars.VITE_SENTRY_DSN }}');
            expect(workflow).toContain('npm run build');
        }
    });
});
