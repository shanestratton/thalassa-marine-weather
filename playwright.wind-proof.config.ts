import base from './playwright.keyboard.config';
export default {
    ...base,
    testMatch: ['desk-wind-layout.spec.ts', 'wind-native-colour.spec.ts'],
    grep: /@pixel/,
    outputDir: 'test-results/wind-proof',
    workers: 1,
    retries: 0,
};
