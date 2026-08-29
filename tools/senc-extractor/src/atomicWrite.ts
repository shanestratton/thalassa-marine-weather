import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, basename } from 'node:path';

/**
 * Write a file atomically, via a same-directory temp file and rename(2).
 *
 * The pi-cache service reads this store while the extractor writes to it, and a
 * batch run rewrites index.json once per cell. A plain writeFile truncates
 * first, so a concurrent reader can catch an empty or half-written index, and a
 * crash mid-write loses the record of every installed cell. rename(2) is atomic
 * within a filesystem: a reader sees either the old file or the complete new one.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
        await writeFile(tmp, data);
        await rename(tmp, path);
    } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
    }
}
