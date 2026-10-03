#!/usr/bin/env node
/**
 * CI dependency audit: fail on any high or critical advisory, except a short,
 * dated allowlist of advisories that have NO fixed release and only reach
 * install-time tooling. Every entry carries its reason and an expiry date; an
 * expired entry fails the gate, so an exception can't quietly become permanent.
 * The audit itself failing to run fails the gate too (fail-closed).
 */
import { execFileSync } from 'node:child_process';

const ALLOW = [
    {
        id: 'GHSA-vfj7-8cjw-p6xm',
        packageName: 'braces',
        reason:
            'braces <=3.0.3 stack-exhaustion DoS. No fixed release exists (3.0.3, published 2024-05, is the latest). ' +
            'It reaches us only through the dev-only postinstall chain patch-package -> find-yarn-workspace-root -> ' +
            'micromatch, which matches our own patch paths at install time: never user input, never in the app.',
        until: '2026-10-31',
    },
];

const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
    try {
        return execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        // npm audit exits non-zero whenever it finds anything; its JSON is still on stdout.
        if (error && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) return error.stdout;
        throw error;
    }
}

function advisoryId(via) {
    const url = typeof via.url === 'string' ? via.url : '';
    const match = url.match(/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/i);
    return match ? match[1] : String(via.source ?? via.title ?? 'unknown');
}

let report;
try {
    report = JSON.parse(runAudit());
} catch (error) {
    console.error('Dependency audit could not run:', error instanceof Error ? error.message : error);
    process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const advisories = new Map();
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
        if (!via || typeof via !== 'object') continue;
        const id = advisoryId(via);
        if (!advisories.has(id)) {
            advisories.set(id, { id, packageName: via.name ?? name, severity: via.severity, title: via.title ?? '' });
        }
    }
}

const failures = [];
const allowed = [];
for (const advisory of advisories.values()) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const entry = ALLOW.find((item) => item.id === advisory.id && item.packageName === advisory.packageName);
    if (!entry) {
        failures.push(`${advisory.severity}: ${advisory.packageName} ${advisory.id} ${advisory.title}`);
    } else if (today > entry.until) {
        failures.push(
            `${advisory.severity}: ${advisory.packageName} ${advisory.id} - its allowlist entry expired on ${entry.until}; re-check it`,
        );
    } else {
        allowed.push(`${advisory.packageName} ${advisory.id} (allowed until ${entry.until}): ${entry.reason}`);
    }
}

for (const line of allowed) console.log(`Allowed: ${line}`);
const counts = report.metadata?.vulnerabilities ?? {};
console.log(
    `Audit: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low.`,
);
if (failures.length > 0) {
    console.error('High or critical advisories without a fix plan:');
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
}
console.log('Dependency audit gate passed.');
