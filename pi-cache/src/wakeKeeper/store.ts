import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    WAKE_CONFIG_BYTES,
    WakeKeeperError,
    parseStoredWakeConfiguration,
    parseWakeConfigurationRequest,
    wakePairKey,
    type WakeConfiguration,
    type WakeConfigurationRequest,
    type WakeBinding,
} from './contract.js';

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** One bounded, private configuration. No evaluation, alarm or green proof is persisted. */
export class WakeKeeperStore {
    private readonly directory: string;
    private readonly file: string;
    private readonly lock: string;
    private tail: Promise<void> = Promise.resolve();
    constructor(cacheDir: string) {
        this.directory = path.resolve(cacheDir, 'wake-keeper');
        this.file = path.join(this.directory, 'configuration.json');
        this.lock = path.join(this.directory, 'configuration.lock');
    }
    private async ensure(): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
            throw new WakeKeeperError('unavailable');
    }
    private async readBytes(file: string, maximum: number): Promise<Uint8Array | null> {
        let handle: FileHandle | undefined;
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
                throw new WakeKeeperError('unavailable');
            handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const opened = await handle.stat();
            if (
                !opened.isFile() ||
                opened.dev !== stat.dev ||
                opened.ino !== stat.ino ||
                opened.size > maximum ||
                (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
            )
                throw new WakeKeeperError('unavailable');
            const bytes = Buffer.alloc(maximum + 1);
            let length = 0;
            while (length <= maximum) {
                const read = await handle.read(bytes, length, bytes.length - length, length);
                if (!read.bytesRead) break;
                length += read.bytesRead;
            }
            if (length > maximum) throw new WakeKeeperError('unavailable');
            return bytes.subarray(0, length);
        } catch (error) {
            if (code(error) === 'ENOENT') return null;
            throw new WakeKeeperError('unavailable');
        } finally {
            await handle?.close();
        }
    }
    private async read(): Promise<WakeConfiguration | null> {
        const bytes = await this.readBytes(this.file, WAKE_CONFIG_BYTES);
        if (!bytes) return null;
        try {
            return parseStoredWakeConfiguration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        } catch {
            throw new WakeKeeperError('unavailable');
        }
    }
    async load(): Promise<WakeConfiguration | null> {
        await this.ensure();
        return this.read();
    }
    private async lockToken(): Promise<string> {
        const nonce = randomUUID(),
            deadline = performance.now() + 1000;
        for (;;) {
            try {
                const handle = await fs.open(
                    this.lock,
                    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
                    0o600,
                );
                try {
                    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                return nonce;
            } catch (error) {
                if (code(error) !== 'EEXIST') throw new WakeKeeperError('unavailable');
                // Never unlink an uncertain/stale writer by a read-then-unlink
                // comparison: two reclaimers could otherwise delete a newer
                // writer's lock. After a crash an operator must quiesce the
                // service and review/remove this private lock explicitly.
                if (performance.now() >= deadline) throw new WakeKeeperError('busy');
                await delay(20);
            }
        }
    }
    private async withLock<T>(work: () => Promise<T>): Promise<T> {
        const run = async () => {
            await this.ensure();
            const token = await this.lockToken();
            try {
                return await work();
            } finally {
                try {
                    const bytes = await this.readBytes(this.lock, 512);
                    if (bytes && JSON.parse(new TextDecoder().decode(bytes)).nonce === token)
                        await fs.unlink(this.lock);
                } catch {
                    /* never remove a lock now owned by someone else */
                }
            }
        };
        const next = this.tail.catch(() => undefined).then(run);
        this.tail = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }
    private async atomic(value: WakeConfiguration | null): Promise<void> {
        if (value === null) {
            await fs.unlink(this.file).catch((error) => {
                if (code(error) !== 'ENOENT') throw error;
            });
            await this.syncDirectory();
            return;
        }
        const bytes = Buffer.from(JSON.stringify(value), 'utf8');
        if (bytes.length > WAKE_CONFIG_BYTES) throw new WakeKeeperError('invalid');
        const temporary = path.join(this.directory, `.configuration-${randomUUID()}.tmp`);
        let handle: FileHandle | undefined;
        try {
            handle = await fs.open(
                temporary,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
                0o600,
            );
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(temporary, this.file);
            await this.syncDirectory();
        } finally {
            await handle?.close();
            await fs.unlink(temporary).catch((error) => {
                if (code(error) !== 'ENOENT') throw error;
            });
        }
    }
    private async syncDirectory(): Promise<void> {
        if (process.platform === 'win32') return;
        const directory = await fs.open(this.directory, constants.O_RDONLY);
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
    /** A changed trusted scope logically has no previous configuration.
     * Same-owner/pair edits always require its exact current revision. */
    private matchesExpected(old: WakeConfiguration | null, binding: WakeBinding, expected: string | null): boolean {
        const visible = old && wakePairKey(old.binding) === wakePairKey(binding) ? old.revision : null;
        return visible === expected;
    }
    async configure(
        raw: WakeConfigurationRequest,
        isCurrent: () => Promise<boolean>,
        now = Date.now(),
    ): Promise<WakeConfiguration> {
        const request = parseWakeConfigurationRequest(raw);
        return this.withLock(async () => {
            if (!(await isCurrent())) throw new WakeKeeperError('binding');
            const old = await this.read();
            if (!this.matchesExpected(old, request.binding, request.expectedRevision))
                throw new WakeKeeperError('conflict');
            const { expectedRevision: _, ...body } = request;
            const next: WakeConfiguration = { ...body, revision: randomUUID(), configuredAt: now };
            parseStoredWakeConfiguration(next);
            if (!(await isCurrent())) throw new WakeKeeperError('binding');
            await this.atomic(next);
            if (!(await isCurrent())) {
                await this.atomic(old);
                throw new WakeKeeperError('binding');
            }
            return next;
        });
    }
    async clear(
        binding: WakeBinding,
        expectedRevision: string | null,
        isCurrent: () => Promise<boolean>,
    ): Promise<void> {
        return this.withLock(async () => {
            if (!(await isCurrent())) throw new WakeKeeperError('binding');
            const old = await this.read();
            if (!this.matchesExpected(old, binding, expectedRevision)) throw new WakeKeeperError('conflict');
            if (!(await isCurrent())) throw new WakeKeeperError('binding');
            await this.atomic(null);
            if (!(await isCurrent())) {
                await this.atomic(old);
                throw new WakeKeeperError('binding');
            }
        });
    }
}
