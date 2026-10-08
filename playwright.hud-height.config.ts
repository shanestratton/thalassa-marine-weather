import { defineConfig } from '@playwright/test';
import sourceLayoutConfig from './playwright.keyboard.config';

export default defineConfig({
    ...sourceLayoutConfig,
    testMatch: ['passage-hud-height.spec.ts', 'passage-recording-layout.spec.ts', 'passage-hud-preview-layout.spec.ts'],
});
