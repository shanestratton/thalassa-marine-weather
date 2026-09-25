import { defineConfig } from '@playwright/test';
import sourceConfig from './playwright.radio.config';

export default defineConfig({ ...sourceConfig, testMatch: 'ownship-label-layout.spec.ts' });
