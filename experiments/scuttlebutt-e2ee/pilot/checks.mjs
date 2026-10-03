// Run only from the isolated checkout. One heavy job at a time across the Mac.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../../../', import.meta.url));
assert(cwd.includes('/.codex/worktrees/scuttlebutt-e2ee/'), 'Keep pilot checks out of the primary checkout');
const phases = {
    hosted_types: [
        '/opt/homebrew/bin/deno',
        'check',
        '--config',
        'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.json',
        'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts',
    ],
    relay_tests: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'experiments/scuttlebutt-e2ee/relay/vitest.config.mjs',
        '--configLoader',
        'runner',
        '--no-cache',
        '--maxWorkers',
        '1',
        '--no-file-parallelism',
    ],
    tests: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'experiments/scuttlebutt-e2ee/pilot/vitest.config.mjs',
        '--configLoader',
        'runner',
        '--no-cache',
        '--maxWorkers',
        '1',
        '--no-file-parallelism',
    ],
    types: [
        '--max-old-space-size=2048',
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '-p',
        'experiments/scuttlebutt-e2ee/pilot/tsconfig.json',
    ],
};
for (const phase of process.argv.slice(2)) {
    assert(Object.hasOwn(phases, phase), 'Specify tests and/or types');
    process.title = 'thalassa pilot checks waiting';
    let announced = false;
    for (;;) {
        const check = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
        assert(!check.error && [0, 1].includes(check.status));
        const others = check.stdout
            .trim()
            .split('\n')
            .filter(
                (line) =>
                    /^\d+\s/.test(line) &&
                    !line.startsWith(`${process.pid} `) &&
                    !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|tail|grep|rg|pgrep)\s/.test(line),
            );
        if (!others.length) break;
        if (!announced) console.info(`Waiting for shared build slot (${phase}).`);
        announced = true;
        await delay(5000);
    }
    process.title = 'vite build slot: isolated private-message pilot checks';
    console.info(`Running ${phase}`);
    const status = await new Promise((resolve) => {
        const command = phase === 'hosted_types' ? phases[phase][0] : process.execPath;
        const args = phase === 'hosted_types' ? phases[phase].slice(1) : phases[phase];
        const child = spawn(command, args, { cwd, stdio: 'inherit' });
        child.on('error', () => resolve(1));
        child.on('exit', (code) => resolve(code ?? 1));
    });
    if (status !== 0) process.exit(status);
}
