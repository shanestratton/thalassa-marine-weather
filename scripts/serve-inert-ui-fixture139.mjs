/** Local synthetic proof server only. No app build, provider or native install. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { buildInertUiFixture } from '../tests/helpers/inertUiFixture139.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const port = Number(process.env.INERT_UI_PROOF_PORT ?? 4307);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('Invalid fixture port');
const stage = await fs.mkdtemp(path.join(path.dirname(repo), 'inert-ui139-browser-'));
const dist = path.join(stage, 'dist'),
    nativeCopy = path.join(stage, 'native-public-copy');
const uiPools = Array.from({ length: 4 }, (_, pool) =>
    Array.from(
        { length: 7 },
        (_, i) => `Pool ${pool} exact fictional string ${i}: space  space, Unicode ☀️ and \\ escape.`,
    ),
);
const { expected } = await buildInertUiFixture(path.join(stage, 'source'), dist, { uiPools });
// A genuine second mini build has a different vocabulary/content identity.
// Its HTML data can be paired with the current JS URLs to exercise stale data.
const oldDist = path.join(stage, 'old-dist');
await buildInertUiFixture(path.join(stage, 'old-source'), oldDist, {
    uiPools: uiPools.map((pool) => pool.map((value) => value + ' Previous build.')),
});
const oldHtml = await fs.readFile(path.join(oldDist, 'index.html'), 'utf8');
const oldBlocks = (
    oldHtml.match(/<script type="application\/json" id="thalassa-ui-[a-f0-9]{64}">[\s\S]*?<\/script>/g) ?? []
).join('');
await fs.copyFile(path.join(repo, 'public/sw.js'), path.join(dist, 'sw.js'));
await fs.cp(dist, nativeCopy, { recursive: true, errorOnExist: true, force: false });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory) {
    const rows = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory())
            for (const [name, hash] of await inventory(target)) rows.push([entry.name + '/' + name, hash]);
        else rows.push([entry.name, sha(await fs.readFile(target))]);
    }
    return rows.sort(([a], [b]) => a.localeCompare(b));
}
const sourceInventory = await inventory(dist),
    copyInventory = await inventory(nativeCopy);
if (JSON.stringify(sourceInventory) !== JSON.stringify(copyInventory)) throw Error('Native-copy fixture differs');
const indexSource = await fs.readFile(path.join(repo, 'index.html'), 'utf8');
const nativeCsp = indexSource.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
const deployed = JSON.parse(await fs.readFile(path.join(repo, 'vercel.json'), 'utf8'));
const webCsp = deployed.headers
    .flatMap((entry) => entry.headers)
    .find((entry) => entry.key.toLowerCase() === 'content-security-policy')?.value;
if (!nativeCsp || !webCsp) throw Error('Actual CSP unavailable');
const capacitor = await fs.readFile(path.join(repo, 'capacitor.config.ts'), 'utf8');
const copyProof = {
    matchingFiles: sourceInventory.length,
    byteIdentical: true,
    webDirDist: /webDir:\s*'dist'/.test(capacitor),
    noRemoteServerUrl: !/^\s*url\s*:/m.test(capacitor),
    scope: 'Synthetic byte-copy preparation only; no Capacitor runtime, device or WKWebView acceptance.',
};
const blocks = /<script type="application\/json" id="(thalassa-ui-[a-f0-9]{64})">([\s\S]*?)<\/script>/g;
function corrupt(html, fault) {
    if (fault === 'mixed') return html.replace(blocks, '').replace('<body>', '<body>' + oldBlocks);
    const target = [...html.matchAll(blocks)].find((match) => {
        const tuple = JSON.parse(match[2]);
        const [words, rows] = JSON.parse(inflateSync(Buffer.from(tuple[0], 'base64')).toString('utf8'));
        const first = rows[0]
            .split(' ')
            .map((index) => words[parseInt(index, 36)])
            .join(' ');
        return first === (fault === 'dynamic-class' ? expected.classes[0] : expected.ui[0]);
    });
    if (!target) throw Error('Fictional data target unavailable');
    const [whole, id, text] = target,
        tuple = JSON.parse(text);
    let replacement;
    if (fault === 'missing' || fault === 'dynamic-class') replacement = '';
    else if (fault === 'duplicate') replacement = whole + whole;
    else if (fault === 'stale')
        replacement = whole.replace(id, 'thalassa-ui-' + (id.endsWith('0') ? '1' : '0').repeat(64));
    else if (fault === 'malformed') replacement = whole.replace(text, '{');
    else if (fault === 'metadata') {
        tuple[2]++;
        replacement = whole.replace(text, JSON.stringify(tuple));
    } else if (fault === 'checksum') {
        const bytes = Buffer.from(tuple[0], 'base64');
        bytes[bytes.length - 1] ^= 1;
        tuple[0] = bytes.toString('base64');
        replacement = whole.replace(text, JSON.stringify(tuple));
    } else throw Error('Unknown synthetic fault');
    return html.replace(whole, replacement);
}
const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
};
let offline = false,
    failedRequests = 0;
const serve = async (request, response) => {
    try {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname === '/_qa/transport') {
            if (url.searchParams.has('offline')) offline = url.searchParams.get('offline') === '1';
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ offline, failedRequests }));
            return;
        }
        if (offline && request.headers.host?.startsWith('127.0.0.2:')) {
            failedRequests++;
            request.socket.destroy();
            return;
        }
        const copy =
            url.searchParams.get('copy') === '1' ||
            /(?:^|;\s*)inert-ui-copy=1(?:;|$)/.test(request.headers.cookie ?? '');
        if (url.searchParams.get('copy') === '1')
            response.setHeader('Set-Cookie', 'inert-ui-copy=1; Path=/; SameSite=Strict');
        response.setHeader('x-fixture-source', copy ? 'native-public-copy' : 'dist');
        if (url.pathname === '/expected.json' || url.pathname === '/copy-proof.json') {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(url.pathname === '/expected.json' ? expected : copyProof));
            return;
        }
        let name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!name || name.startsWith('plan/')) name = 'index.html';
        else if (name === 'logs' || name.startsWith('logs/')) name = 'logs.html';
        else if (['beta', 'feedback', 'ocean', 'plan'].includes(name))
            name = name === 'plan' ? 'index.html' : name + '.html';
        const directory = copy ? nativeCopy : dist,
            target = path.resolve(directory, name);
        if (!target.startsWith(directory + path.sep)) throw Error('Outside synthetic bundle');
        let bytes = await fs.readFile(target);
        if (name.endsWith('.html')) {
            let html = bytes.toString('utf8');
            const policy = url.searchParams.get('policy');
            if (policy === 'native' || policy === 'web') {
                html = html.replace(
                    /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
                    policy === 'native' ? `<meta http-equiv="Content-Security-Policy" content="${nativeCsp}">` : '',
                );
                if (policy === 'web') response.setHeader('Content-Security-Policy', webCsp);
            }
            const fault = url.searchParams.get('fault');
            if (fault) html = corrupt(html, fault);
            bytes = Buffer.from(html);
        }
        response.setHeader('Content-Type', mime[path.extname(name)] ?? 'application/octet-stream');
        response.setHeader('Cache-Control', 'no-store');
        response.end(bytes);
    } catch {
        response.statusCode = 404;
        response.end('Synthetic fixture unavailable');
    }
};
const server = http.createServer(serve);
// The real SW deliberately bypasses localhost/127.0.0.1. A distinct loopback
// secure-context origin exercises its production branch without editing it.
http.createServer(serve).listen(port, '127.0.0.2');
server.listen(port, '127.0.0.1', () => console.log(`Inert UI mini fixture ready: http://127.0.0.1:${port}`));
