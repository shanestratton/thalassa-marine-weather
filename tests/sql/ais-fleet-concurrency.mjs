// Use only with the isolated fixture database populated by ais-fleet-replay.sql.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const sql = (query) =>
    new Promise((resolve, reject) => {
        const child = spawn('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        let out = '',
            err = '';
        child.stdout.on('data', (chunk) => {
            out += chunk;
            if (out.length > 32768) child.kill();
        });
        child.stderr.on('data', (chunk) => {
            err += chunk;
            if (err.length > 32768) child.kill();
        });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0 ? resolve(out.trim()) : reject(Error(`Isolated AIS SQL exited${code}: ${err.slice(0, 400)}`)),
        );
    });
await sql(
    "SELECT public.fixture_assert((SELECT licence_reference='FICTIONAL TEST ONLY - NOT A LIVE APPROVAL' FROM public.ais_fleet_control),'refuse nonfixture database'); UPDATE public.ais_fleet_control SET next_allowed_at='-infinity',claim_token=NULL;",
);
const claims = await Promise.all(
    Array.from({ length: 16 }, () => sql("SELECT coalesce(public.claim_ais_fleet_poll()->>'token','DENIED')")),
);
const winners = claims.filter((value) => value !== 'DENIED');
assert.equal(winners.length, 1, 'sixteen independent SQL connections must yield exactly one provider claim');
assert.equal(
    await sql("SELECT coalesce(public.claim_ais_fleet_poll()->>'token','DENIED')"),
    'DENIED',
    'a fresh/restarted connection cannot spend another claim',
);
await sql(
    `SELECT public.finish_ais_fleet_poll('${winners[0]}'::uuid,NULL,'empty',0,0); SELECT public.fixture_assert((SELECT next_allowed_at>=now()+interval '60 seconds' FROM public.ais_fleet_control),'full minute after completion');`,
);
console.log('AIS SQL concurrency:16 connections,1 persisted claim; restart/cooldown passed.');
