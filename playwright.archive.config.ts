import { defineConfig } from '@playwright/test';
import sourceLayoutConfig from './playwright.keyboard.config';

export default defineConfig({ ...sourceLayoutConfig, testMatch: ['archive-log-layout.spec.ts'] });
