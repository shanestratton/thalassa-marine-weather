/** Read-only actual-artifact proof. No rebuild, account, provider or native install. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.ACTUAL_INERT_DIST ?? path.resolve(repo, '../build139-configured-inert-tuples'));
const parent = path.dirname(repo);
if (!dist.startsWith(parent + path.sep) || !path.basename(dist).startsWith('build139-configured-'))
    throw Error('Pass the explicit configured139 proof artifact.');
const stage = await fs.mkdtemp(path.join(parent, 'inert-ui139-artifact-copy-')),
    copy = path.join(stage, 'public');
await fs.cp(dist, copy, { recursive: true, filter: (source) => !source.endsWith('.map') });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory) {
    const rows = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory())
            for (const [name, hash] of await inventory(target)) rows.push([entry.name + '/' + name, hash]);
        else if (!entry.name.endsWith('.map')) rows.push([entry.name, sha(await fs.readFile(target))]);
    }
    return rows.sort(([a], [b]) => a.localeCompare(b));
}
const sourceInventory = await inventory(dist),
    copyInventory = await inventory(copy);
if (JSON.stringify(sourceInventory) !== JSON.stringify(copyInventory)) throw Error('Public byte copy differs');
const index = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
const logs = await fs.readFile(path.join(dist, 'logs.html'), 'utf8');
const blocks = /<script type="application\/json" id="(thalassa-ui-[a-f0-9]{64})">([\s\S]*?)<\/script>/g;
const tables = (html) =>
    [...html.matchAll(blocks)].map((match) => ({ id: match[1], tuple: JSON.parse(match[2]), textSha: sha(match[2]) }));
const indexTables = tables(index),
    logTables = tables(logs);
if (indexTables.length !== 6 || JSON.stringify(indexTables) !== JSON.stringify(logTables))
    throw Error('Expected the reviewed six real tuples');
const assets = await fs.readdir(path.join(dist, 'assets'));
const router = assets.filter((name) => /^router-engine-[^.]+\.js$/.test(name));
if (router.length !== 1) throw Error('Expected the actual route worker asset');
const deployed = JSON.parse(await fs.readFile(path.join(repo, 'vercel.json'), 'utf8'));
const webCsp = deployed.headers
    .flatMap((entry) => entry.headers)
    .find((entry) => entry.key.toLowerCase() === 'content-security-policy')?.value;
if (!webCsp) throw Error('Actual web CSP unavailable');
const proof = {
    artifact: path.basename(dist),
    publicFiles: sourceInventory.length,
    copiedPublicBytesIdentical: true,
    sourceMapsExcludedFromCopy: true,
    indexSha: sha(index),
    logsSha: sha(logs),
    router: '/assets/' + router[0],
    tables: indexTables.map(({ id, tuple, textSha }) => ({
        id,
        encodedLength: tuple[0].length,
        bytes: tuple[1],
        count: tuple[2],
        checksum: tuple[3],
        textSha,
    })),
    scope: 'Actual configured artifact and public-byte copy; no physical/native acceptance or authenticated/provider coverage.',
};
let offline = false,
    failedRequests = 0;
const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
};
const serve = async (request, response) => {
    try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1:4309');
        if (url.pathname === '/_qa/proof.json' || url.pathname === '/_qa/transport') {
            if (url.searchParams.has('offline')) offline = url.searchParams.get('offline') === '1';
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(url.pathname === '/_qa/proof.json' ? proof : { offline, failedRequests }));
            return;
        }
        if (offline && request.headers.host?.startsWith('127.0.0.2:')) {
            failedRequests++;
            request.socket.destroy();
            return;
        }
        const copied =
            url.searchParams.get('copy') === '1' ||
            /(?:^|;\s*)inert-actual-copy=1(?:;|$)/.test(request.headers.cookie ?? '');
        if (url.searchParams.get('copy') === '1')
            response.setHeader('Set-Cookie', 'inert-actual-copy=1; Path=/; SameSite=Strict');
        let name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!name || name === 'plan' || name.startsWith('plan/')) name = 'index.html';
        else if (name === 'logs' || name.startsWith('logs/')) name = 'logs.html';
        else if (['beta', 'feedback', 'ocean'].includes(name)) name += '.html';
        else if (!name.startsWith('api/') && !path.extname(name)) name = 'index.html';
        const directory = copied ? copy : dist,
            target = path.resolve(directory, name);
        if (!target.startsWith(directory + path.sep) || name.endsWith('.map'))
            throw Error('Outside public proof payload');
        let bytes = await fs.readFile(target);
        if (name.endsWith('.html') && url.searchParams.get('fault') === 'stale') {
            const html = bytes
                .toString('utf8')
                .replace(blocks, (whole, id) => whole.replace(id, 'thalassa-ui-' + '0'.repeat(64)));
            bytes = Buffer.from(html);
        }
        if (url.searchParams.get('policy') === 'web') response.setHeader('Content-Security-Policy', webCsp);
        response.setHeader('x-fixture-source', copied ? 'actual-public-copy' : 'actual-configured-artifact');
        response.setHeader('Content-Type', mime[path.extname(name)] ?? 'application/octet-stream');
        response.setHeader('Cache-Control', 'no-store');
        response.end(bytes);
    } catch {
        response.statusCode = 404;
        response.end('Actual public artifact path unavailable');
    }
};
http.createServer(serve).listen(4309, '127.0.0.2');
http.createServer(serve).listen(4309, '127.0.0.1', () =>
    console.log('Actual inert139 artifact ready: http://127.0.0.1:4309'),
);
