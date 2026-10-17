import fs from 'node:fs';
const source = 'services/seabed/crowdPolicy.ts';
const target = 'supabase/functions/_shared/crowdPolicy.ts';
const expected = fs.readFileSync(source, 'utf8').replace("from './seabedCore'", "from './seabedCore.ts'");
if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== expected.replaceAll('\r\n', '\n'))
        throw Error('Crowd publication policy mirror differs');
} else fs.writeFileSync(target, expected);
