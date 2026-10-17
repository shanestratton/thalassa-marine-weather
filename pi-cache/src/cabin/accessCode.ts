import 'dotenv/config';
import path from 'node:path';
import { rotateCabinCode } from './codeFile.js';
import { readCabinOperatorBinding } from './operatorBinding.js';

// No HTTP endpoint can rotate a code or create an app/chart-device credential.
if (process.argv.length !== 3 || process.argv[2] !== '--rotate') throw Error('Use --rotate locally on the Pi');
const cache = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const binding = readCabinOperatorBinding(cache);
if (!binding) throw Error('Pair this Pi to the current owner before creating a cabin code');
const result = rotateCabinCode(path.join(cache, 'cabin', 'access.json'), binding);
console.log(
    `Cabin display code: ${result.code}\nValid until ${new Date(result.expiresAt).toISOString()}. Rotating the code disconnects existing cabin viewers.`,
);
