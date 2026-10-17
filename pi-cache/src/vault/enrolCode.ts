/**
 * A chart-device code from a shell (127-C-d decision 5). install.sh prints
 * the first one from here; Shane can run it again over ssh, as thalassa-cache's
 * user, from /opt/thalassa-pi-cache:
 *
 *   node dist/vault/enrolCode.js              a code for a new phone or tablet (30 minutes)
 *   node dist/vault/enrolCode.js --list       the enrolled devices (labels and dates)
 *   node dist/vault/enrolCode.js --remove ID  take one off (the cut fallback for the app's list)
 *   node dist/vault/enrolCode.js --recover    the Pi answers every device again (observe), and a
 *                                             fresh owner code: the way back if "Only her own
 *                                             devices can command the Pi" ever locks the
 *                                             skipper out (129-12, piCommandLock.ts)
 *
 * Run as anyone but the owner of CACHE_DIR (plain `sudo` is root), it changes
 * nothing and says how to run it: a file root wrote would lock the service out.
 *
 * The code goes to this terminal only, never to a log: the Pi keeps only its
 * hash, in CACHE_DIR/enc-devices.json, which the running service reads fresh.
 * CACHE_DIR comes from the environment or the service's own .env, as
 * server.ts reads it.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { EncDeviceStore, INSTALL_CODE_TTL_MS } from '../encDevices.js';
import { PiLockStore, recoverPiLock, wrongShellUser } from '../piCommandLock.js';

// Quiet: the terminal shows the code and nothing about the .env.
dotenv.config({ quiet: true });

function cacheDir(): string {
    return path.resolve(process.env.CACHE_DIR || './cache');
}

const args = process.argv.slice(2);
const store = new EncDeviceStore(path.join(cacheDir(), 'enc-devices.json'));
// As the service's own user only: a file root wrote would lock the service out of it (129-12).
const wrongUser = wrongShellUser(cacheDir(), process.getuid?.());

if (wrongUser) {
    console.error(wrongUser);
    process.exitCode = 1;
} else if (args[0] === '--list') {
    const devices = await store.list();
    if (devices.length === 0) console.log('No device is set up for charts yet.');
    for (const d of devices) console.log(`${d.id}  ${d.label}  set up ${d.enrolledAt}  last seen ${d.lastSeenAt}`);
} else if (args[0] === '--remove') {
    const id = args[1];
    if (!id) {
        console.error('usage: node dist/vault/enrolCode.js --remove <device id>');
        process.exitCode = 2;
    } else {
        const removed = await store.remove(id);
        console.log(removed ? `Removed ${id}.` : `No device ${id}.`);
        process.exitCode = removed ? 0 : 1;
    }
} else if (args[0] === '--recover') {
    const { code, expiresAt } = await recoverPiLock({
        store: new PiLockStore(path.join(cacheDir(), 'pi-lock.json')),
        devices: store,
    });
    console.log('The Pi answers every phone and tablet again (observe). Turn the lock back on from the app.');
    console.log(`Owner code: ${code.slice(0, 5)}-${code.slice(5)}`);
    console.log(`Type it on your phone within 30 minutes (until ${expiresAt}):`);
    console.log('Settings → Boat network → Boat Pi → Charts from <your boat>.');
} else if (args.length === 0) {
    const { code, expiresAt } = await store.mintCode({ ttlMs: INSTALL_CODE_TTL_MS });
    const shown = `${code.slice(0, 5)}-${code.slice(5)}`;
    console.log(`Chart code: ${shown}`);
    console.log(`Type it on the phone within 30 minutes (until ${expiresAt}):`);
    console.log('Settings → Boat network → Boat Pi → Charts from <your boat>.');
} else {
    console.error('usage: node dist/vault/enrolCode.js [--list | --remove <device id> | --recover]');
    process.exitCode = 2;
}
