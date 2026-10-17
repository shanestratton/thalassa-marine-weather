import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSharedBuildWait, parseSharedBuildWaitArgs } from './sharedBuildWait.mjs';

// Synthetic scheduling only: no child process, filesystem write, delay or build.
function fixture(budgetMs, rows, sleepOvershoot = 0) {
    let time = 100;
    const polls = [],
        sleeps = [],
        saved = [];
    const wait = createSharedBuildWait({
        budgetMs,
        pid: 7,
        now: () => time,
        poll: (timeout) => {
            polls.push(timeout);
            const row = rows.shift();
            assert(row, 'No unplanned poll');
            time += row.elapsed ?? 0;
            if (row.throw) throw new Error('private-process-error');
            return { status: 1, stdout: '', ...row };
        },
        sleep: async (duration) => {
            sleeps.push(duration);
            time += duration + sleepOvershoot;
        },
        persist: (row) => saved.push(row),
    });
    return { wait, polls, sleeps, saved };
}

for (const args of [
    [],
    ['/cargo', '/cache', '/scratch'],
    ['/cargo', '/cache', '/scratch', 'simulator'],
    ['/cargo', '/cache', '/scratch', 'simulator', '--relay-archive', '/archive'],
    ['/cargo', '/cache', '/scratch', 'simulator', '--recover-receipt', '/failed-receipt'],
]) {
    test('preserves positional arguments ' + JSON.stringify(args), () => {
        const parsed = parseSharedBuildWaitArgs(args);
        assert.deepEqual(parsed.args, args);
        assert.equal(parsed.budgetMs, 120000);
        assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.args));
        assert.deepEqual(parseSharedBuildWaitArgs([...args, '--shared-wait-budget-ms', '149']).args, args);
        assert.equal(parseSharedBuildWaitArgs([...args, '--shared-wait-budget-ms', '149']).budgetMs, 149);
    });
}
for (const value of ['0', '1', '119999', '120000']) {
    test('accepts canonical allowance ' + value, () => {
        assert.equal(parseSharedBuildWaitArgs(['--shared-wait-budget-ms', value]).budgetMs, Number(value));
    });
}
for (const value of ['', '-1', '+1', '01', '1.0', '1e3', '120001', '1000000', ' 1', '1\n', 'NaN']) {
    test('refuses noncanonical allowance ' + JSON.stringify(value), () => {
        assert.throws(() => parseSharedBuildWaitArgs(['--shared-wait-budget-ms', value]), /waiting refused/);
    });
}
test('refuses duplicate, nontrailing and missing allowance flags', () => {
    for (const args of [
        ['--shared-wait-budget-ms'],
        ['--shared-wait-budget-ms', '1', '/late'],
        ['--shared-wait-budget-ms', '1', '--shared-wait-budget-ms', '2'],
    ])
        assert.throws(() => parseSharedBuildWaitArgs(args), /waiting refused/);
});
test('does not mutate caller arguments', () => {
    const args = Object.freeze(['/cargo', '--shared-wait-budget-ms', '9']);
    assert.deepEqual(parseSharedBuildWaitArgs(args), { args: ['/cargo'], budgetMs: 9 });
});
test('zero allowance persists queued and dispatches neither poll nor sleep', async () => {
    const f = fixture(0, []);
    await assert.rejects(f.wait.wait(), /budget exhausted/);
    assert.deepEqual(f.polls, []);
    assert.deepEqual(f.sleeps, []);
    assert.deepEqual(f.saved, [{ spentMs: 0, budgetMs: 0, status: 'queued-unrun' }]);
});
test('poll overhead is counted before ready', async () => {
    const f = fixture(120000, [{ elapsed: 13 }]);
    assert.equal(await f.wait.wait(), 13);
    assert.deepEqual(f.polls, [10000]);
    assert.deepEqual(f.saved.at(-1), { spentMs: 13, budgetMs: 120000, status: 'ready' });
});
test('poll timeout is capped by the remaining allowance', async () => {
    const f = fixture(7, [{ elapsed: 1 }]);
    assert.equal(await f.wait.wait(), 1);
    assert.deepEqual(f.polls, [7]);
});
for (const elapsed of [7, 11]) {
    test('poll exact exhaustion/overshoot refuses even an empty process result ' + elapsed, async () => {
        const f = fixture(7, [{ elapsed }]);
        await assert.rejects(f.wait.wait(), /budget exhausted/);
        assert.equal(f.saved.at(-1).spentMs, elapsed);
        assert.equal(f.saved.at(-1).status, 'queued-unrun');
        assert.deepEqual(f.sleeps, []);
    });
}
test('sleep uses only remainder and preserves overshoot before another poll', async () => {
    const f = fixture(10, [{ elapsed: 3, status: 0, stdout: '22 node vitest\n' }], 2);
    await assert.rejects(f.wait.wait(), /budget exhausted/);
    assert.deepEqual(f.polls, [10]);
    assert.deepEqual(f.sleeps, [7]);
    assert.deepEqual(f.saved.at(-1), { spentMs: 12, budgetMs: 10, status: 'queued-unrun' });
});
test('ordinary sleeps never exceed five seconds', async () => {
    const f = fixture(20000, [{ elapsed: 2, status: 0, stdout: '22 node vitest\n' }, { elapsed: 3 }]);
    assert.equal(await f.wait.wait(), 5005);
    assert.deepEqual(f.sleeps, [5000]);
    assert.deepEqual(f.polls, [10000, 10000]);
});
test('ledger is cumulative across separate heavy steps', async () => {
    const f = fixture(10, [{ elapsed: 3 }, { elapsed: 8 }]);
    assert.equal(await f.wait.wait(), 3);
    await assert.rejects(f.wait.wait(), /budget exhausted/);
    assert.deepEqual(f.polls, [10, 7]);
    assert.deepEqual(f.saved.at(-1), { spentMs: 11, budgetMs: 10, status: 'queued-unrun' });
    await assert.rejects(f.wait.wait(), /budget exhausted/);
    assert.deepEqual(f.polls, [10, 7]);
});
test('self, shell wrappers and non-PID continuations cannot create a false busy job', async () => {
    const stdout = [
        '7 node owned-current-runner',
        '8 /bin/zsh -c guard',
        '9 /usr/bin/env guard',
        '10 /usr/bin/pgrep guard',
        '11 xargs guard',
        '12 fish guard',
        'continuation mentions node vitest',
        '',
    ].join('\n');
    const f = fixture(100, [{ elapsed: 1, status: 0, stdout }]);
    assert.equal(await f.wait.wait(), 1);
    assert.deepEqual(f.sleeps, []);
});
test('a genuine different PID still waits', async () => {
    const f = fixture(12, [{ elapsed: 1, status: 0, stdout: '70 node owned-heavy\n' }]);
    await assert.rejects(f.wait.wait(), /budget exhausted/);
    assert.deepEqual(f.sleeps, [11]);
});
test('poll failure retains elapsed and fixed failure without process details', async () => {
    const f = fixture(100, [{ elapsed: 17, throw: true }]);
    await assert.rejects(f.wait.wait(), { message: 'Shared build waiting refused' });
    assert.deepEqual(f.saved.at(-1), { spentMs: 17, budgetMs: 100, status: 'failed' });
    assert(!JSON.stringify(f.saved).includes('private-process-error'));
});
test('failed enumeration is not mistaken for a free slot', async () => {
    for (const row of [{ status: 2 }, { error: {} }, { stdout: null }]) {
        const f = fixture(100, [{ elapsed: 3, ...row }]);
        await assert.rejects(f.wait.wait(), /waiting refused/);
        assert.equal(f.saved.at(-1).status, 'failed');
        assert.equal(f.saved.at(-1).spentMs, 3);
    }
});
test('clock regression refuses rather than reducing the ledger', async () => {
    const f = fixture(100, [{ elapsed: -1 }]);
    await assert.rejects(f.wait.wait(), /waiting refused/);
    assert.deepEqual(f.saved.at(-1), { spentMs: 0, budgetMs: 100, status: 'failed' });
});
test('persisted observations are immutable values', async () => {
    const f = fixture(100, [{ elapsed: 1 }]);
    await f.wait.wait();
    assert(f.saved.every(Object.isFrozen));
    assert.deepEqual(f.saved[0], { spentMs: 1, budgetMs: 100, status: 'waiting' });
});
test('both runner callsites supply remaining-aware bounded polling and private status persistence', () => {
    for (const name of ['vodozemac-native-proof.mjs', 'bridge-native/buildLocalUiFrameworks.mjs']) {
        const source = readFileSync(new URL(name, import.meta.url), 'utf8');
        assert.match(source, /parseSharedBuildWaitArgs\(process\.argv\.slice\(2\)\)/);
        assert.match(source, /budgetMs: waitArgs\.budgetMs/);
        assert.match(
            source,
            /spawnSync\('\/usr\/bin\/pgrep', \['-fl', 'vite build\|tsc\|vitest'\], \{\s+encoding: 'utf8',\s+timeout,/,
        );
        assert.match(source, /if \(status === 'queued-unrun' \|\| status === 'failed'\)/);
        assert.match(source, /await sharedWait\.wait\(\)/);
        assert.doesNotMatch(source, /setTimeout\(resolve, 10_000\)/);
    }
});
test('native preparation receipt precedes the first slot and leaves original phase/launch gates present', () => {
    const source = readFileSync(new URL('vodozemac-native-proof.mjs', import.meta.url), 'utf8');
    assert(source.indexOf("kind: 'native-provider-preparation-attempt'") < source.indexOf('await buildSlot();'));
    assert.match(source, /mode: 0o600, flag: 'wx'/);
    assert.match(source, /acceptanceEvidence: false/);
    assert.match(
        source,
        /const receiptPath = join\(scratch, `\$\{recovery \? 'recovery' : 'run'\}-\$\{ids\[0\]\}\.json`\)/,
    );
    assert.match(source, /\{ capture: true, timeout: 180_000 \}/);
    assert.match(source, /candidate\.runID === ids\[0\] && candidate\.phase === phase && candidate\.pid === pid/);
    assert.match(source, /if \(!cleaned && receipt\.status !== 'failed'\) receipt\.status = 'incomplete'/);
});
