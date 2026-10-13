/**
 * The vault's systemd unit (127-C-d decision 2) and thalassa-cache's drop-in
 * (decision 14), parsed. The values are the never-cut limits: its own low
 * priority process on two of the four cores, killed first, never swapped,
 * never dumped, no network. They must equal vault/limits.ts, the one place
 * the measurement (M0-M5) changes them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VAULT_LIMITS } from './limits.js';

const SYSTEMD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'systemd');

/** section → key → values (a key may repeat). Trailing comments are not allowed by systemd. */
function parseUnit(text: string): Map<string, Map<string, string[]>> {
    const sections = new Map<string, Map<string, string[]>>();
    let current: Map<string, string[]> | null = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const section = /^\[(.+)\]$/.exec(line);
        if (section) {
            current = new Map();
            sections.set(section[1], current);
            continue;
        }
        const eq = line.indexOf('=');
        assert.ok(current && eq > 0, `not a key=value line: ${line}`);
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        assert.doesNotMatch(value, /\s#/, `${key}: systemd has no trailing comments`);
        current.set(key, [...(current.get(key) ?? []), value]);
    }
    return sections;
}

const unitText = readFileSync(path.join(SYSTEMD, 'thalassa-chart-vault.service'), 'utf8');
const unit = parseUnit(unitText);
const service = unit.get('Service')!;
const one = (key: string) => {
    const values = service.get(key);
    assert.ok(values && values.length === 1, `${key} set once`);
    return values[0];
};

test('the vault unit holds the decision-2 limits', () => {
    assert.equal(one('Nice'), String(VAULT_LIMITS.nice));
    assert.equal(VAULT_LIMITS.nice, 10);
    // CPUQuota turns the cgroup cpu controller on, and then only CPUWeight ranks services.
    assert.equal(one('CPUWeight'), String(VAULT_LIMITS.cpuWeight));
    assert.ok(VAULT_LIMITS.cpuWeight < 100, 'below an ordinary service');
    assert.equal(one('CPUQuota'), `${VAULT_LIMITS.cpuQuotaPercent}%`);
    assert.equal(VAULT_LIMITS.cpuQuotaPercent, 200);
    assert.equal(one('MemorySwapMax'), '0');
    assert.ok(Number(one('OOMScoreAdjust')) >= 800);
    assert.equal(one('OOMScoreAdjust'), String(VAULT_LIMITS.oomScoreAdjust));
    assert.equal(one('LimitCORE'), '0');
    assert.equal(one('PrivateTmp'), 'yes');
    assert.equal(one('RestrictAddressFamilies'), 'AF_UNIX');
    assert.equal(one('PrivateNetwork'), 'yes');
    assert.equal(one('ProtectHome'), 'read-only');
    assert.equal(one('ProtectSystem'), 'strict');
    assert.equal(one('NoNewPrivileges'), 'yes');
    assert.equal(one('UMask'), '0077');
    assert.equal(one('MemoryHigh'), `${VAULT_LIMITS.memoryHighMB}M`);
    assert.equal(one('MemoryMax'), `${VAULT_LIMITS.memoryMaxMB}M`);
    assert.equal(one('TasksMax'), String(VAULT_LIMITS.tasksMax));
    assert.equal(one('IOSchedulingClass'), 'best-effort');
    assert.equal(one('IOSchedulingPriority'), '7');
    assert.equal(one('KillMode'), 'control-group');
    assert.equal(one('Restart'), 'on-failure');
    assert.equal(one('RuntimeDirectory'), 'thalassa-chart-vault');
    assert.equal(one('RuntimeDirectoryMode'), '0700');
    assert.equal(one('ReadWritePaths'), '/opt/thalassa-pi-cache/enc-charts/vault');
    assert.notEqual(service.get('PrivateDevices')?.[0], 'yes', 'the SG-Lock needs /dev/bus/usb');
    assert.equal(service.has('MemoryDenyWriteExecute'), false, 'V8 needs W^X off');
});

test('the vault runs as thalassa-cache’s user and node, filled in at install, with the heap and LRU of limits.ts', () => {
    assert.equal(one('User'), '@USER@');
    const exec = one('ExecStart');
    assert.match(exec, /^@NODE@ /);
    assert.match(exec, new RegExp(`--max-old-space-size=${VAULT_LIMITS.maxOldSpaceMB} dist/vault/main\\.js$`));
    const env = (service.get('Environment') ?? []).join(' ');
    assert.match(env, /NODE_ENV=production/);
    assert.match(env, /TMPDIR=\/tmp/);
    assert.match(env, new RegExp(`VAULT_LRU_MB=${VAULT_LIMITS.lruMB}\\b`));
    assert.equal(one('WorkingDirectory'), '/opt/thalassa-pi-cache');
});

test('thalassa-cache wants the vault but never requires it, and dumps no core', () => {
    const dropIn = parseUnit(readFileSync(path.join(SYSTEMD, '20-chart-vault.conf'), 'utf8'));
    assert.deepEqual(dropIn.get('Unit')?.get('Wants'), ['thalassa-chart-vault.service']);
    for (const hard of ['Requires', 'BindsTo', 'Requisite', 'PartOf'])
        assert.equal(dropIn.get('Unit')?.has(hard), false, `no ${hard}: the watch starts even if the vault does not`);
    assert.deepEqual(dropIn.get('Service')?.get('LimitCORE'), ['0']);
});

test("the watch's process keeps its CPU priority once the vault turns the cpu controller on", () => {
    const dropIn = parseUnit(readFileSync(path.join(SYSTEMD, '20-chart-vault.conf'), 'utf8'));
    assert.deepEqual(dropIn.get('Service')?.get('CPUWeight'), [String(VAULT_LIMITS.serviceCpuWeight)]);
    assert.ok(VAULT_LIMITS.serviceCpuWeight > 100, 'above the services at the default weight');
    assert.ok(
        VAULT_LIMITS.serviceCpuWeight >= 20 * VAULT_LIMITS.cpuWeight,
        'the watch outweighs the vault by twenty times or more, as Nice -5 against 10 did',
    );
});
