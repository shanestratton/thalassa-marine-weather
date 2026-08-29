import { spawn, ChildProcess, execSync } from 'node:child_process';
import { constants, existsSync, lstatSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { open as fsOpen, unlink, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * IPC client for the o-charts `oexserverd` decryption daemon.
 *
 * Protocol (ported from hornang/oesenc-export.py, MIT/GPL-licensed reference):
 *
 *   1. oexserverd creates `/tmp/OCPN_PIPEX` (command FIFO) on startup.
 *   2. Client mkfifo's a return FIFO at a random path.
 *   3. For each chart: write a 1025-byte command struct to the command pipe,
 *      then read decrypted SENC bytes from the return pipe until EOF.
 *   4. Send CMD_EXIT to oexserverd to shut down cleanly.
 *
 * The dongle (SG-Lock USB key) must be plugged in and registered — see the
 * Bosun Pi setup notes for the o-charts dongle pairing flow.
 */

const COMMAND_PIPE = '/tmp/OCPN_PIPEX';

const CMD_READ_ESENC = 0; // legacy .oesenc format
const CMD_EXIT = 2;
const CMD_READ_OESU = 8; // current .oesu format

export interface OexserverdOptions {
    /** Absolute path to the `oexserverd` binary. Default: `$HOME/.local/bin/oexserverd`. */
    binaryPath?: string;
    /** How long to wait for the daemon to come up after spawning, in ms. Default 5000. */
    startupTimeoutMs?: number;
    /** Per-chart decryption timeout in ms. Default 30000. */
    readTimeoutMs?: number;
}

export class OexserverdClient {
    private process: ChildProcess | null = null;
    private returnPipe: string;
    private returnPipeCreated = false;
    private spawnedBinary = false;
    /** Why the last command-pipe probe failed; surfaced if startup times out. */
    private lastPipeError: string | null = null;

    constructor(private readonly opts: OexserverdOptions = {}) {
        const randomSuffix = randomBytes(4).toString('hex');
        this.returnPipe = join(tmpdir(), `senc-extract-${process.pid}-${randomSuffix}`);
    }

    /** Start the daemon if not already running and create the return FIFO. */
    async start(): Promise<void> {
        // Make the return FIFO. mkfifo isn't in node core, so shell out.
        // 0600: this FIFO carries decrypted chart bytes back to us.
        execSync(`mkfifo -m 600 ${shellQuote(this.returnPipe)}`);
        this.returnPipeCreated = true;

        if (await this.commandPipeWritable()) {
            return; // someone else already running it
        }

        const binary = this.opts.binaryPath ?? `${process.env.HOME}/.local/bin/oexserverd`;
        if (!existsSync(binary)) {
            throw new Error(`oexserverd binary not found at ${binary}`);
        }

        // oexserverd creates COMMAND_PIPE itself, at mode 0666 & ~umask. Under the
        // usual Debian umask of 0002 that is a group-writable FIFO, which
        // assertTrustedCommandPipe() rightly refuses. Give the daemon a private
        // umask so the FIFO it makes is 0600, and clear a stale group-writable one
        // first, since the daemon reuses an existing FIFO rather than recreating it.
        this.clearUntrustedCommandPipe();

        const previousUmask = process.umask(0o077);
        try {
            this.process = spawn(binary, [], { stdio: 'ignore', detached: false });
        } finally {
            process.umask(previousUmask);
        }
        this.spawnedBinary = true;

        const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 5000);
        while (Date.now() < deadline) {
            if (await this.commandPipeWritable()) return;
            await sleep(100);
        }
        throw new Error(
            `oexserverd did not start within timeout${this.lastPipeError ? ` (${this.lastPipeError})` : ''}`,
        );
    }

    /**
     * Decrypt a single .oesu chart file and return the decrypted SENC bytes.
     * The dongle must be paired with this chart's install key.
     */
    async decryptChart(chartPath: string, installKey: string): Promise<Buffer> {
        const ext = chartPath.toLowerCase().endsWith('.oesu')
            ? '.oesu'
            : chartPath.toLowerCase().endsWith('.oesenc')
              ? '.oesenc'
              : null;
        if (!ext) throw new Error(`unsupported chart extension: ${chartPath}`);
        const cmd = ext === '.oesu' ? CMD_READ_OESU : CMD_READ_ESENC;

        // 1) Write command to oexserverd. Open → write → close marks EOF for the daemon.
        this.writeCommand(cmd, this.returnPipe, chartPath, installKey);

        // 2) Read decrypted bytes from the return pipe until EOF.
        return this.readReturnPipe();
    }

    /** Send CMD_EXIT to the daemon and clean up the return pipe. */
    async stop(): Promise<void> {
        if (await this.commandPipeWritable()) {
            try {
                this.writeCommand(CMD_EXIT, '', '', '');
            } catch {
                // Daemon may have already exited.
            }
        }

        if (this.process && this.spawnedBinary) {
            // Wait briefly for graceful exit, then force.
            const exitDeadline = Date.now() + 2000;
            while (Date.now() < exitDeadline && this.process.exitCode === null) {
                await sleep(50);
            }
            if (this.process.exitCode === null) {
                this.process.kill('SIGTERM');
            }
        }

        if (this.returnPipeCreated) {
            await unlink(this.returnPipe).catch(() => undefined);
        }
    }

    /**
     * Remove a command FIFO from an earlier run that we own but that
     * assertTrustedCommandPipe() would reject. Anything not ours, or not a FIFO,
     * is left alone: that is a condition to report, not to clobber.
     */
    private clearUntrustedCommandPipe(): void {
        try {
            const stat = lstatSync(COMMAND_PIPE);
            if (!stat.isFIFO()) return;
            const uid = typeof process.getuid === 'function' ? process.getuid() : null;
            if (uid !== null && stat.uid !== uid) return;
            if ((stat.mode & 0o022) === 0) return;
            unlinkSync(COMMAND_PIPE);
        } catch {
            // Absent, or not ours to remove: let the trust check report it.
        }
    }

    private async commandPipeWritable(): Promise<boolean> {
        try {
            assertTrustedCommandPipe();
            const fd = openSync(COMMAND_PIPE, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
            closeSync(fd);
            this.lastPipeError = null;
            return true;
        } catch (err) {
            this.lastPipeError = err instanceof Error ? err.message : String(err);
            return false;
        }
    }

    /**
     * Pack the protocol message:
     *   uint8 cmd, char[256] fifo_name, char[256] senc_name, char[512] senc_key
     * — total 1025 bytes, all null-padded ASCII (per hornang).
     */
    private writeCommand(cmd: number, fifoName: string, sencName: string, sencKey: string): void {
        const buf = Buffer.alloc(1 + 256 + 256 + 512);
        buf.writeUInt8(cmd, 0);
        Buffer.from(fifoName, 'utf8').copy(buf, 1, 0, Math.min(255, fifoName.length));
        Buffer.from(sencName, 'utf8').copy(buf, 1 + 256, 0, Math.min(255, sencName.length));
        Buffer.from(sencKey, 'utf8').copy(buf, 1 + 256 + 256, 0, Math.min(511, sencKey.length));

        // Open command pipe write-only, write, close.
        assertTrustedCommandPipe();
        const fd = openSync(COMMAND_PIPE, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
            let written = 0;
            while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
        } finally {
            closeSync(fd);
        }
    }

    private async readReturnPipe(): Promise<Buffer> {
        // Opening the read end of the FIFO unblocks oexserverd's matching write.
        // We accumulate bytes until the daemon closes its write end (EOF).
        const handle = await fsOpen(this.returnPipe, 'r');
        try {
            const stream = handle.createReadStream({ highWaterMark: 64 * 1024 });
            const chunks: Buffer[] = [];
            const deadline = Date.now() + (this.opts.readTimeoutMs ?? 30000);

            await new Promise<void>((resolve, reject) => {
                const timer = setInterval(() => {
                    if (Date.now() > deadline) {
                        stream.destroy(new Error('readReturnPipe timeout'));
                    }
                }, 500);
                stream.on('data', (chunk: Buffer | string) => {
                    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                });
                stream.on('end', () => {
                    clearInterval(timer);
                    resolve();
                });
                stream.on('error', (err) => {
                    clearInterval(timer);
                    reject(err);
                });
            });

            return Buffer.concat(chunks);
        } finally {
            await handle.close().catch(() => undefined);
        }
    }
}

function assertTrustedCommandPipe(): void {
    const stat = lstatSync(COMMAND_PIPE);
    if (!stat.isFIFO()) throw new Error('oexserverd command endpoint is not a FIFO');
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && stat.uid !== uid) throw new Error('oexserverd command FIFO has an unexpected owner');
    if ((stat.mode & 0o022) !== 0) throw new Error('oexserverd command FIFO is writable by another user');
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Convenience: decrypt one chart and return the bytes. Manages oexserverd lifecycle.
 * For batch use, instantiate `OexserverdClient` directly and reuse across charts.
 */
export async function decryptOnce(
    chartPath: string,
    installKey: string,
    opts: OexserverdOptions = {},
): Promise<Buffer> {
    const client = new OexserverdClient(opts);
    try {
        await client.start();
        return await client.decryptChart(chartPath, installKey);
    } finally {
        await client.stop();
    }
}

/** Re-export so callers can implement custom pipelines. */
export { readFile };
