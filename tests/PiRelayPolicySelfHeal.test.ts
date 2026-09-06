/**
 * A rebooted Pi comes back with its internet gate shut — by design. The app
 * must reopen it from the skipper's LIVE policy on the next health check, not
 * from a stale in-memory copy that started out `false`.
 *
 * 2026-09-06: the first telemetry publisher deploy restarted the Pi, its
 * outbox read allow_internet = 0, the publisher reported `internet-off`, and
 * no diary handoff happened to run — so nothing ever reopened the gate.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pi = readFileSync(resolve(process.cwd(), 'services/PiCacheService.ts'), 'utf8');

describe('Pi relay internet policy self-heals after a Pi restart', () => {
    const fn = pi.slice(
        pi.indexOf('private async reconcileDiaryRelayInternetPolicy()'),
        pi.indexOf(
            '}\n',
            pi.indexOf('if (applied) this.status = { ...this.status, diaryRelayAllowInternet: desired };'),
        ) + 2,
    );

    it('reads the desired policy live from the diary rule, and pushes on any mismatch', () => {
        expect(fn).toContain("await import('./DiaryRelayTransport')");
        expect(fn).toContain('const desired = isDiaryRelayInternetAllowed();');
        expect(fn).toContain('if (this.status.diaryRelayAllowInternet === desired) return;');
        expect(fn).toContain('diaryRelayAllowInternet: desired,');
        expect(fn).not.toContain('this.status.diaryRelayAllowInternet === this.diaryRelayAllowInternet');
    });

    it('runs after every successful health check', () => {
        const health = pi.slice(
            pi.indexOf('private async checkHealth()'),
            pi.indexOf('private async autoReconcileConfigIfNeeded()'),
        );
        expect(health).toContain('this.reconcileDiaryRelayInternetPolicy().catch(');
    });
});
