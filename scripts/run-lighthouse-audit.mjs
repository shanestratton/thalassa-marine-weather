#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import lighthouse from 'lighthouse';
import puppeteer from 'puppeteer';

const require = createRequire(import.meta.url);
const config = require('../lighthouserc.cjs');
const seedApplicationShell = require('./lighthouse-setup.cjs');

const collect = config?.ci?.collect ?? {};
const assertions = config?.ci?.assert?.assertions ?? {};
const auditUrl = collect.url?.[0];
const reportDirectory = '.lighthouseci';

if (typeof auditUrl !== 'string' || !auditUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('Lighthouse must audit an explicit local preview URL.');
}
if (collect.numberOfRuns !== 1 || collect.settings?.disableStorageReset !== true) {
    throw new Error('The application-shell seed is only trustworthy for one run with storage reset disabled.');
}

function waitForExit(child) {
    return new Promise((resolve) => child.once('exit', resolve));
}

async function waitForPreview(child, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'preview did not answer';

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Preview exited before Lighthouse started (code ${child.exitCode}).`);
        }
        try {
            const response = await fetch(auditUrl, { signal: globalThis.AbortSignal.timeout(2_000) });
            await response.arrayBuffer();
            if (response.ok) return;
            lastError = `preview returned HTTP ${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Preview was not ready within ${timeoutMs / 1_000}s: ${lastError}`);
}

function browserPort(browser) {
    const endpoint = new URL(browser.wsEndpoint());
    const port = Number(endpoint.port);
    if (!Number.isInteger(port) || port <= 0) throw new Error('Puppeteer did not expose a debugging port.');
    return port;
}

function assertionValue(lhr, auditId) {
    if (auditId.startsWith('categories:')) {
        return lhr.categories?.[auditId.slice('categories:'.length)]?.score;
    }
    return lhr.audits?.[auditId]?.numericValue;
}

function evaluateAssertions(lhr) {
    const results = [];
    const failures = [];

    for (const [auditId, assertion] of Object.entries(assertions)) {
        const [level, options = {}] = assertion;
        if (level === 'off') continue;

        const value = assertionValue(lhr, auditId);
        let passed = typeof value === 'number';
        if (passed && typeof options.minScore === 'number') passed = value >= options.minScore;
        if (passed && typeof options.maxNumericValue === 'number') passed = value <= options.maxNumericValue;

        const result = { auditId, level, value: value ?? null, ...options, passed };
        results.push(result);
        if (!passed && level === 'error') failures.push(result);
    }

    return { results, failures };
}

// A previous successful report must never make a failed or skipped audit look
// green. Keep each invocation self-contained and make the independent verifier
// prove only the reports produced by this run.
await rm(reportDirectory, { recursive: true, force: true });

const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--strictPort'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let previewOutput = '';
preview.stdout.on('data', (chunk) => {
    previewOutput += chunk;
    process.stdout.write(chunk);
});
preview.stderr.on('data', (chunk) => {
    previewOutput += chunk;
    process.stderr.write(chunk);
});

let browser;
try {
    await waitForPreview(preview);
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    await seedApplicationShell(browser, { url: auditUrl });

    const result = await lighthouse(auditUrl, {
        port: browserPort(browser),
        output: ['json', 'html'],
        logLevel: 'info',
        disableStorageReset: true,
    });
    if (!result?.lhr || !Array.isArray(result.report) || result.report.length !== 2) {
        throw new Error('Lighthouse did not return both JSON and HTML reports.');
    }

    const stamp = Date.now();
    const [jsonReport, htmlReport] = result.report;
    const { results, failures } = evaluateAssertions(result.lhr);
    await mkdir(reportDirectory, { recursive: true });
    await Promise.all([
        writeFile(`${reportDirectory}/lhr-${stamp}.json`, jsonReport, 'utf8'),
        writeFile(`${reportDirectory}/lhr-${stamp}.html`, htmlReport, 'utf8'),
        writeFile(`${reportDirectory}/assertion-results.json`, JSON.stringify(results, null, 2), 'utf8'),
    ]);

    for (const item of results) {
        const marker = item.passed ? 'PASS' : item.level === 'error' ? 'FAIL' : 'WARN';
        console.log(`${marker} ${item.auditId}: ${item.value}`);
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} Lighthouse release assertion(s) failed.`);
    }
} catch (error) {
    if (previewOutput.trim()) console.error('Preview output was captured above.');
    throw error;
} finally {
    if (browser) await browser.close().catch(() => undefined);
    if (preview.exitCode === null) {
        preview.kill('SIGTERM');
        await Promise.race([waitForExit(preview), new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (preview.exitCode === null) preview.kill('SIGKILL');
    }
}
