import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Decryption for S-63 charts installed by OpenCPN's s63 plugin.
 *
 * Unlike o-charts `.oesu` (see `oexserverd.ts`), S-63 has no decryption
 * daemon and no IPC. The plugin's OCPNsenc helper builds a plaintext SENC at
 * import time, then obscures it with a 1024-byte one-time pad, repeating, XOR.
 * The pad itself is regenerated on demand by invoking OCPNsenc with the three
 * permits; it is never stored.
 *
 * So reading an eSENC is two steps:
 *   1. `OCPNsenc -n` writes the 1024-byte pad for one specific .es57 file.
 *   2. XOR the .es57 against that pad, cycling, to recover the SENC.
 *
 * Reference: bdbcat/s63_pi `s63chart.cpp` — `GetSENCCryptKeyBuffer` builds the
 * command line, `CryptInputStream::Read` is the XOR loop.
 *
 * The pad is bound to the file's absolute path at build time: a pad fetched
 * for one .es57 will not decrypt another, and moving the file invalidates it.
 */

/** Length of the one-time pad OCPNsenc emits. Fixed by the plugin's malloc(1024). */
const CRYPT_KEY_BYTES = 1024;

/**
 * Every SENC this dialect produces opens with this literal. It is the only
 * reliable check that a pad was the RIGHT pad — see `decryptEsenc`.
 */
const SENC_MAGIC = 'SENC Version=';

export interface S63Permits {
    /** 28-char UserPermit from o-charts, bound to this machine's fingerprint. */
    userPermit: string;
    /** 8-char InstallPermit issued alongside the UserPermit. */
    installPermit: string;
    /**
     * Cell permit line for this specific cell, as stored in the `.os63`
     * descriptor after the `cellpermit:` prefix — commas and trailing empty
     * fields included. OCPNsenc validates the whole string, not just the key.
     */
    cellPermit: string;
}

export interface S63DecryptOptions {
    /** Path to the OCPNsenc helper. Default: `$HOME/.local/bin/OCPNsenc`. */
    sencUtilPath?: string;
    /**
     * Path to the s63 plugin shared library. OCPNsenc refuses to emit a pad
     * unless it can verify the calling plugin binary (`-z`).
     * Default: `$HOME/.local/lib/opencpn/libs63_pi.so`.
     */
    pluginPath?: string;
}

function defaultSencUtil(): string {
    return `${process.env.HOME}/.local/bin/OCPNsenc`;
}

function defaultPlugin(): string {
    return `${process.env.HOME}/.local/lib/opencpn/libs63_pi.so`;
}

/**
 * Ask OCPNsenc for the one-time pad that decrypts `esencPath`.
 *
 * The helper only writes to a file, so we hand it a temp path and read it
 * back. Deleted in `finally` — the pad is key material and regenerating it
 * costs one exec.
 */
export async function fetchCryptKey(
    esencPath: string,
    permits: S63Permits,
    opts: S63DecryptOptions = {},
): Promise<Buffer> {
    const sencUtil = opts.sencUtilPath ?? defaultSencUtil();
    const plugin = opts.pluginPath ?? defaultPlugin();

    if (!existsSync(sencUtil)) {
        throw new Error(`OCPNsenc not found at ${sencUtil} — is the s63 plugin installed?`);
    }
    if (!existsSync(plugin)) {
        throw new Error(`s63 plugin library not found at ${plugin}`);
    }
    if (!existsSync(esencPath)) {
        throw new Error(`eSENC not found at ${esencPath}`);
    }

    const keyPath = join(tmpdir(), `s63key-${process.pid}-${randomBytes(4).toString('hex')}.bin`);

    try {
        // Pre-create owner-only so the pad never sits world-readable in the
        // shared temp dir — OCPNsenc's fopen("w") truncates but keeps the mode.
        await writeFile(keyPath, Buffer.alloc(0), { mode: 0o600 });
        try {
            await execFileAsync(sencUtil, [
                '-n', // emit crypt key only
                '-i',
                esencPath,
                '-o',
                keyPath,
                '-u',
                permits.userPermit,
                '-e',
                permits.installPermit,
                '-p',
                permits.cellPermit,
                '-z',
                plugin,
            ]);
        } catch {
            // Node's default message embeds the whole argv, which would put
            // the UserPermit and the cell key into any log that catches this.
            throw new Error(
                `OCPNsenc rejected the permits for ${esencPath} ` +
                    `(it reports "USERPERMIT M_ID invalid" for a malformed UserPermit)`,
            );
        }

        // Belt and braces: if a future build exits 0 without writing, say so
        // in permit terms rather than surfacing a bare ENOENT.
        let key: Buffer;
        try {
            key = await readFile(keyPath);
        } catch {
            throw new Error(`OCPNsenc produced no key for ${esencPath} — the UserPermit or InstallPermit is malformed`);
        }
        if (key.length !== CRYPT_KEY_BYTES) {
            throw new Error(
                `expected a ${CRYPT_KEY_BYTES}-byte key, got ${key.length} — check the user/install/cell permits`,
            );
        }
        return key;
    } finally {
        await unlink(keyPath).catch(() => undefined);
    }
}

/** XOR `data` against the repeating pad, in place, returning the same buffer. */
export function applyCryptKey(data: Buffer, key: Buffer): Buffer {
    for (let i = 0; i < data.length; i += 1) {
        data[i] ^= key[i % key.length];
    }
    return data;
}

/**
 * Fetch the pad for one eSENC and return its decrypted SENC bytes.
 *
 * Guards against the dangerous failure mode: a cell permit that is
 * well-formed but WRONG (a different cell's, or one character off) makes
 * OCPNsenc emit a full-length pad with no complaint and exit 0. Measured
 * against FR466870, flipping the last character of the cell permit yielded a
 * different 1024-byte key whose output is high-entropy noise. Length alone
 * cannot catch that, so verify the plaintext actually looks like a SENC before
 * handing it to a parser that would otherwise report a chart with no features.
 */
export async function decryptEsenc(
    esencPath: string,
    permits: S63Permits,
    opts: S63DecryptOptions = {},
): Promise<Buffer> {
    const key = await fetchCryptKey(esencPath, permits, opts);
    const senc = applyCryptKey(await readFile(esencPath), key);

    if (senc.subarray(0, SENC_MAGIC.length).toString('latin1') !== SENC_MAGIC) {
        throw new Error(
            `decrypted output for ${esencPath} does not start with "${SENC_MAGIC}" — ` +
                `the cell permit is almost certainly wrong for this cell`,
        );
    }
    return senc;
}
