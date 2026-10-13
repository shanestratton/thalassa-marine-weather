/**
 * thalassa-chart-vault: the process that holds the boat's licensed charts
 * (127-C-d, Pi update 3). Run by systemd/thalassa-chart-vault.service:
 *
 *   node --max-old-space-size=512 dist/vault/main.js
 *
 * It is the only thing on the Pi that turns a delivered o-charts .oesu into
 * chart data, and it does that in its own RAM, on demand: oexserverd decrypts
 * over a FIFO, the mirrored parser (src/sencEngine) decodes, a byte-bounded
 * LRU holds the result. It writes two files, both catalogue only:
 * enc-charts/vault/vault-index.json and removed.json. It talks only over a
 * unix socket, to thalassa-cache, which stays the front door (pinned TLS,
 * device tokens, the boat-LAN check, signing).
 *
 * Environment (the unit sets them; defaults suit /opt/thalassa-pi-cache):
 *   VAULT_SOCKET            /run/thalassa-chart-vault/vault.sock
 *   VAULT_STATE_DIR         ./enc-charts/vault
 *   ENC_CHART_DIR           ./enc-charts (its sources/ hold app-installed sets)
 *   ENC_WATCH_DIR           $HOME/Charts (OpenCPN's o-charts downloads)
 *   VAULT_REFERENCE_DIR     ./reference (the two S-57 catalogue CSVs)
 *   VAULT_OEXSERVERD        $HOME/.local/bin/oexserverd
 *   VAULT_LRU_MB            vault/limits.ts lruMB
 *   VAULT_OEX_COMMAND_PIPE  only for a fake daemon (tests, the Mac dry run)
 */
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_VAULT_SOCKET, VAULT_LIMITS } from './limits.js';
import { OexDecoder } from './decoder.js';
import { VaultService } from './vaultService.js';
import { createVaultHttpServer, listenOnSocket } from './vaultServer.js';

const env = process.env;
const home = os.homedir();
const socketPath = env.VAULT_SOCKET || DEFAULT_VAULT_SOCKET;
const chartStore = path.resolve(env.ENC_CHART_DIR || './enc-charts');
const lruMB = Number(env.VAULT_LRU_MB) > 0 ? Number(env.VAULT_LRU_MB) : VAULT_LIMITS.lruMB;

const decoder = new OexDecoder({
    binaryPath: env.VAULT_OEXSERVERD || path.join(home, '.local', 'bin', 'oexserverd'),
    commandPipe: env.VAULT_OEX_COMMAND_PIPE || undefined,
    readTimeoutMs: VAULT_LIMITS.readTimeoutMs,
    startupTimeoutMs: VAULT_LIMITS.daemonStartMs,
});
const service = new VaultService({
    stateDir: path.resolve(env.VAULT_STATE_DIR || path.join(chartStore, 'vault')),
    roots: [path.resolve(env.ENC_WATCH_DIR || path.join(home, 'Charts')), path.join(chartStore, 'sources')],
    referenceDir: path.resolve(env.VAULT_REFERENCE_DIR || './reference'),
    lruBytes: lruMB * 1024 * 1024,
    decrypt: (file, key) => decoder.decrypt(file, key),
    onStop: () => decoder.stop(),
});
const server = createVaultHttpServer(service);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`[vault] ${signal}: stopping`);
    server.close();
    await service.stop().catch(() => undefined);
    process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await listenOnSocket(server, socketPath);
console.log(`[vault] listening on ${socketPath} (LRU ${lruMB} MB, schema-checked parser)`);
await service.start();
