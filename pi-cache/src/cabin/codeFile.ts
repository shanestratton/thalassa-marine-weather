import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { CABIN_CODE_TTL_MS, validCabinCodeRecord, type CabinCodeRecord } from './access.js';

export function readCabinCode(file: string, now = Date.now()): CabinCodeRecord | null {
    try {
        const stat = fs.lstatSync(file);
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 512 ||
            (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        )
            return null;
        const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return validCabinCodeRecord(value, now) ? value : null;
    } catch {
        return null;
    }
}

/** Local operator command only. The code is returned once; its hash alone is stored. */
export function rotateCabinCode(file: string, now = Date.now()): { code: string; expiresAt: number } {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Cabin access directory is not private');
    if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
        throw Error('Cabin access directory is not private');
    try {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error('Cabin code file cannot be a link');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const record: CabinCodeRecord = {
        schema: 1,
        nonce: randomBytes(16).toString('hex'),
        codeHash: createHash('sha256').update(code).digest('hex'),
        issuedAt: now,
        expiresAt: now + CABIN_CODE_TTL_MS,
    };
    const temporary = path.join(parent, '.cabin-' + randomBytes(16).toString('hex'));
    try {
        fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
    return { code, expiresAt: record.expiresAt };
}
