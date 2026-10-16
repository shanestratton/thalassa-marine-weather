import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
const folder = new URL('src/offlineWeather/', new URL('../', import.meta.url));
mkdirSync(folder, { recursive: true });
const sources = [
    ['services/weather/synopticCharts.ts', 'synopticCharts.ts', (text) => text],
    ['services/weather/marineBulletins.ts', 'marineBulletins.ts', (text) => text],
    [
        'components/map/satelliteImagery.ts',
        'satelliteSource.ts',
        (text) => text.slice(text.indexOf('export const GMGSI_WMS_URL'), text.indexOf('/** Corners of that image')),
    ],
];
for (const [path, target, select] of sources) {
    const original = readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(original).digest('hex');
    const expected = '// Generated from ' + path + '; source SHA256 ' + hash + '\n' + select(original).trim() + '\n';
    const output = new URL(target, folder);
    if (process.argv.includes('--check')) {
        if (readFileSync(output, 'utf8').replace(/\r\n/g, '\n') !== expected)
            throw new Error('Offline weather source mirror is stale: ' + path);
    } else writeFileSync(output, expected);
}
