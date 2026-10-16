import config from '../../../source/playwright.keyboard.config';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../source/', import.meta.url));
export default {
    ...config,
    testDir: '.',
    testMatch: 'diagnostic.spec.ts',
    workers: 2,
    retries: 0,
    outputDir: fileURLToPath(new URL('../../../diagnostic-results/', import.meta.url)),
    reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../diagnostic-report.json', import.meta.url)) }]],
    use: { ...config.use, trace: 'on' },
    projects: [config.projects![1]],
    webServer: {
        ...config.webServer,
        cwd: root,
        env: {
            ...config.webServer!.env,
            VITE_MAPBOX_ACCESS_TOKEN: 'pk.fixture-not-a-real-token-for-browser-tests',
            VITE_SUPABASE_URL: 'https://fixture.supabase.co',
            VITE_SUPABASE_KEY: 'sb_publishable_fixture_browser_test',
        },
    },
};
