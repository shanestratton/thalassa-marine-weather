import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'supabase/functions/_shared/marine-v2.ts');
const target = path.join(root, 'pi-cache/src/marine/marine-v2.ts');
const header =
    '// GENERATED from supabase/functions/_shared/marine-v2.ts. Run node pi-cache/scripts/sync-marine-v2.mjs.\n';
const expected = header + fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n');
if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== expected)
        throw Error('Pi marine schema mirror is stale');
} else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
}
