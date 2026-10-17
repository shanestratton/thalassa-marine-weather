import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../../utils/ownBoatSkill.ts', import.meta.url));
const target = fileURLToPath(new URL('../src/ownBoatSkillWire.ts', import.meta.url));
const raw = readFileSync(source);
if (process.argv.includes('--check')) {
    if (!readFileSync(target).equals(raw)) throw Error('Private own-boat skill wire mirror differs');
} else writeFileSync(target, raw);
