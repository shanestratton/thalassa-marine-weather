import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cabinOwnerBinding } from './access.js';

/** Operator CLI only: read the existing private pairing without constructing/mutating the outbox. */
export function readCabinOperatorBinding(cacheDirectory: string): string | null {
    const file = path.join(cacheDirectory, 'diary-relay', 'outbox.db');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
        throw Error('Current private pairing unavailable');
    const database = new Database(file, { readonly: true, fileMustExist: true, timeout: 1_000 });
    try {
        const value = database
            .prepare('SELECT relay_owner_id, relay_id, relay_token FROM diary_relay_config WHERE singleton = 1')
            .get() as { relay_owner_id?: unknown; relay_id?: unknown; relay_token?: unknown } | undefined;
        return value &&
            typeof value.relay_owner_id === 'string' &&
            typeof value.relay_id === 'string' &&
            typeof value.relay_token === 'string'
            ? cabinOwnerBinding({ ownerId: value.relay_owner_id, relayId: value.relay_id, token: value.relay_token })
            : null;
    } finally {
        database.close();
    }
}
