import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Getting a boat licensed for encrypted charts, without a terminal.
 *
 * There are two chart worlds and they identify a boat in completely different
 * ways. Telling them apart is most of what a skipper needs to know:
 *
 *   o-charts (oeSENC)  identity is the SG-Lock USB dongle. It is portable — move
 *                      the dongle to another Pi and the charts follow. Nothing
 *                      here is consumed or spent.
 *   ChartWorld (S-63)  identity is a fingerprint of THIS machine. o-charts issue
 *                      an InstallPermit against it, you get five for a
 *                      UserPermit, and "the combination of computer and OS"
 *                      changing burns one. Reinstalling the OS burns one.
 *
 * So the flow this supports is: see which world you are in, get the fingerprint
 * file off the Pi and up to the shop, then paste back the two codes it returns.
 *
 * Everything is validated against this machine BEFORE it is stored. OCPNsenc can
 * answer both questions directly — is this UserPermit well-formed, and is this
 * InstallPermit for this machine — and a permit that is wrong is worth knowing
 * about while the skipper is still looking at the screen, not at chart-build
 * time three steps later.
 */

const HOME = homedir();
const SENC_UTIL = process.env.ENC_OCPNSENC || join(HOME, '.local/bin/OCPNsenc');
const PLUGIN = process.env.ENC_S63_PLUGIN || join(HOME, '.local/lib/opencpn/libs63_pi.so');
const OPENCPN_DIR = process.env.ENC_OPENCPN_DIR || join(HOME, '.opencpn');
const CONF_PATH = join(OPENCPN_DIR, 'opencpn.conf');

/** An S-63 UserPermit is 28 hex characters; the InstallPermit is 8. */
const USER_PERMIT_RE = /^[0-9A-Fa-f]{28}$/;
const INSTALL_PERMIT_RE = /^[0-9A-Fa-f]{8}$/;

/** SG Intec's vendor id. The SG-Lock[U2] reports 1547:1000. */
const SG_LOCK_VENDOR = '1547';

const EXEC_TIMEOUT_MS = 20_000;

export interface S63Status {
    /** Is the S-63 toolchain present at all? Without it none of this can run. */
    toolchainReady: boolean;
    missing: string[];
    dongle: { present: boolean; description: string | null };
    userPermit: string | null;
    installPermit: string | null;
    /** Null when no permits are stored yet, so "unknown" is never shown as "bad". */
    permitsValid: boolean | null;
    permitProblem: string | null;
}

function assertToolchain(): void {
    const missing = toolchainMissing();
    if (missing.length > 0) {
        throw new Error(
            `The S-63 toolchain is not installed on this Pi (missing: ${missing.join(', ')}). ` +
                'Charts from o-charts with a dongle do not need it; ChartWorld S-63 does.',
        );
    }
}

function toolchainMissing(): string[] {
    const missing: string[] = [];
    if (!existsSync(SENC_UTIL)) missing.push('OCPNsenc');
    if (!existsSync(PLUGIN)) missing.push('libs63_pi.so');
    return missing;
}

/**
 * Is an SG-Lock plugged in?
 *
 * Worth surfacing even though nothing here needs it: a skipper holding a dongle
 * is in the o-charts world and does not need a fingerprint or an InstallPermit
 * at all, and telling them that up front saves them spending one of five shots
 * to learn it.
 */
export async function detectDongle(): Promise<{ present: boolean; description: string | null }> {
    try {
        const { stdout } = await execFileAsync('lsusb', [], { timeout: EXEC_TIMEOUT_MS });
        const line = stdout.split('\n').find((l) => l.includes(`ID ${SG_LOCK_VENDOR}:`));
        if (!line) return { present: false, description: null };
        const after = line.split(/ID\s+[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\s*/)[1];
        return { present: true, description: (after || 'SG-Lock').trim() };
    } catch {
        // No lsusb, or it failed. Absence of evidence only.
        return { present: false, description: null };
    }
}

/** Read the permits currently stored for the plugin, if any. */
export async function readStoredPermits(): Promise<{ userPermit: string | null; installPermit: string | null }> {
    let conf: string;
    try {
        conf = await readFile(CONF_PATH, 'utf8');
    } catch {
        return { userPermit: null, installPermit: null };
    }
    const pick = (key: string): string | null => {
        const m = conf.match(new RegExp(`^${key}=(.*)$`, 'mi'));
        const value = m?.[1]?.trim();
        return value ? value : null;
    };
    return { userPermit: pick('Userpermit'), installPermit: pick('Installpermit') };
}

/**
 * Ask OCPNsenc whether these permits are good for this machine.
 *
 * `-y` checks the UserPermit itself, `-k` checks the InstallPermit against this
 * hardware — the latter is the one that matters, because an InstallPermit issued
 * for a different machine looks perfectly valid until a chart fails to build.
 */
export async function validatePermits(
    userPermit: string,
    installPermit: string,
): Promise<{ valid: boolean; problem: string | null }> {
    assertToolchain();
    if (!USER_PERMIT_RE.test(userPermit)) {
        return { valid: false, problem: 'The UserPermit should be 28 hexadecimal characters.' };
    }
    if (!INSTALL_PERMIT_RE.test(installPermit)) {
        return { valid: false, problem: 'The InstallPermit should be 8 hexadecimal characters.' };
    }

    const run = async (args: string[]): Promise<string> => {
        const { stdout, stderr } = await execFileAsync(SENC_UTIL, args, { timeout: EXEC_TIMEOUT_MS });
        return `${stdout}\n${stderr}`;
    };

    try {
        const userOut = await run(['-y', '-u', userPermit, '-z', PLUGIN]);
        if (/error/i.test(userOut)) {
            return { valid: false, problem: 'That UserPermit was rejected. Check it against the o-charts shop.' };
        }
        const installOut = await run(['-k', '-e', installPermit, '-u', userPermit, '-z', PLUGIN]);
        if (/invalid for this machine/i.test(installOut)) {
            return {
                valid: false,
                problem:
                    'That InstallPermit belongs to a different machine. Generate a fingerprint on this Pi and ' +
                    'get an InstallPermit for it.',
            };
        }
        if (/error/i.test(installOut)) {
            return { valid: false, problem: 'That InstallPermit was rejected. Check it against the o-charts shop.' };
        }
        return { valid: true, problem: null };
    } catch (err) {
        return { valid: false, problem: `Could not check the permits: ${(err as Error).message}` };
    }
}

/**
 * Generate a fingerprint for THIS machine and return it for the skipper to
 * upload to the o-charts shop.
 *
 * `-w` is the flag. `-j` looks equally plausible in the plugin source but emits
 * an UNENCRYPTED variant that the shop rejects with a useless "bad file name",
 * so it must not be used here.
 */
export async function generateFingerprint(): Promise<{ filename: string; base64: string; bytes: number }> {
    assertToolchain();
    await mkdir(OPENCPN_DIR, { recursive: true });

    const before = new Set(await listFprFiles());
    const { stdout } = await execFileAsync(SENC_UTIL, ['-w', '-o', `${OPENCPN_DIR}/`], { timeout: EXEC_TIMEOUT_MS });

    // It prints `fpr file:<path>`, but fall back to diffing the directory rather
    // than trusting one line of output for the whole result.
    let produced = stdout.match(/fpr file:\s*(\S+)/i)?.[1];
    if (!produced || !existsSync(produced)) {
        const after = await listFprFiles();
        produced = after.find((f) => !before.has(f));
    }
    if (!produced) throw new Error('OCPNsenc did not produce a fingerprint file');

    const data = await readFile(produced);
    // The accepted format is opaque binary. Plain text here means `-j` output
    // (or a stub), which the shop refuses — better to fail now than to send the
    // skipper round the houses with a file that cannot work.
    if (data.length === 0) throw new Error('The fingerprint file came out empty');
    if (data[0] === 0x3c) throw new Error('The fingerprint came out as plain text, which the shop rejects');

    return {
        filename: produced.split('/').pop() ?? 'fingerprint.fpr',
        base64: data.toString('base64'),
        bytes: data.length,
    };
}

async function listFprFiles(): Promise<string[]> {
    try {
        const names = await readdir(OPENCPN_DIR);
        return names.filter((n) => n.toLowerCase().endsWith('.fpr')).map((n) => join(OPENCPN_DIR, n));
    } catch {
        return [];
    }
}

/**
 * Store the permits, but only once they have been checked against this machine.
 *
 * Only the two keys are touched. A skipper who also runs OpenCPN on this Pi has
 * real settings in this file, and a chart-licensing step has no business
 * rewriting them.
 */
export async function savePermits(
    userPermit: string,
    installPermit: string,
): Promise<{ valid: boolean; problem: string | null }> {
    const user = userPermit.trim().toUpperCase();
    const install = installPermit.trim().toUpperCase();

    const check = await validatePermits(user, install);
    if (!check.valid) return check;

    await mkdir(OPENCPN_DIR, { recursive: true });
    let conf = '';
    try {
        conf = await readFile(CONF_PATH, 'utf8');
    } catch {
        // No config yet: a Pi that has never run OpenCPN. Start one.
    }

    conf = upsertConfValue(conf, 'Userpermit', user);
    conf = upsertConfValue(conf, 'Installpermit', install);
    await writeFile(CONF_PATH, conf, { mode: 0o600 });
    return { valid: true, problem: null };
}

/**
 * Set one key inside `[PlugIns/S63]`, creating the section if it is absent and
 * leaving every other section untouched.
 */
function upsertConfValue(conf: string, key: string, value: string): string {
    const lines = conf.split('\n');
    const sectionIndex = lines.findIndex((l) => l.trim().toLowerCase() === '[plugins/s63]');
    if (sectionIndex === -1) {
        const body = conf.endsWith('\n') || conf === '' ? conf : `${conf}\n`;
        return `${body}[PlugIns/S63]\n${key}=${value}\n`;
    }
    let end = lines.length;
    for (let i = sectionIndex + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith('[')) {
            end = i;
            break;
        }
    }
    const existing = lines.findIndex(
        (l, i) => i > sectionIndex && i < end && l.toLowerCase().startsWith(`${key.toLowerCase()}=`),
    );
    if (existing !== -1) {
        lines[existing] = `${key}=${value}`;
    } else {
        lines.splice(end, 0, `${key}=${value}`);
    }
    return lines.join('\n');
}

/** Everything the setup screen needs, in one call. */
export async function s63Status(): Promise<S63Status> {
    const missing = toolchainMissing();
    const dongle = await detectDongle();
    const { userPermit, installPermit } = await readStoredPermits();

    let permitsValid: boolean | null = null;
    let permitProblem: string | null = null;
    if (missing.length === 0 && userPermit && installPermit) {
        const check = await validatePermits(userPermit, installPermit);
        permitsValid = check.valid;
        permitProblem = check.problem;
    }

    return {
        toolchainReady: missing.length === 0,
        missing,
        dongle,
        userPermit,
        installPermit,
        permitsValid,
        permitProblem,
    };
}

export const __testing = { upsertConfValue, USER_PERMIT_RE, INSTALL_PERMIT_RE };
