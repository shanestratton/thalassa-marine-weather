import { defineConfig } from '@playwright/test';
import sourceConfig from './playwright.radio.config';

/**
 * The own-ship fixtures (marker anchoring, the label beside it, the little
 * boat) and Obs's camera centring on the real Mapbox engine, against source.
 */
export default defineConfig({
    ...sourceConfig,
    testDir: './browser-tests',
    testMatch: ['ownship-label-layout.spec.ts', 'ownship-boat-marker.spec.ts', 'obs-camera-centring.spec.ts'],
});
