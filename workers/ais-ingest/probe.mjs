/**
 * probe.mjs — is the aisstream.io key alive? Nothing else.
 *
 * Written 2026-08-12 after the ingest worker sat on a connected socket for
 * twenty minutes reporting `Messages: 0`. Every other explanation had been
 * eliminated — Supabase credentials proven by an end-to-end sweep, the
 * Railway variable names confirmed correct, the bounding box accepted — and
 * the remaining suspect could not be tested without disentangling it from
 * the worker, Railway and the database all at once.
 *
 * So this talks to aisstream and NOTHING else. No Supabase client, no
 * database, no batching, no dead man's switch. It connects, subscribes,
 * prints every frame it receives verbatim, and after 30 seconds tells you
 * plainly whether the key works.
 *
 * The key is read from the environment and never printed. If aisstream
 * echoes it back in an error, it is redacted before it reaches your
 * terminal or your scrollback.
 *
 * Run it from this directory (it needs the `ws` package already installed
 * here):
 *
 *     AISSTREAM_KEY='paste-your-key' node probe.mjs
 *
 * Reading the result:
 *   · frames arriving        -> the key is GOOD; the fault is in the worker
 *   · silence for 30 s       -> the key or the account is refused
 *   · a text frame with an   -> aisstream is telling you exactly what is
 *     error message             wrong; that text is the answer
 */
import WebSocket from 'ws';

const KEY = process.env.AISSTREAM_KEY;
if (!KEY) {
    console.error('Set AISSTREAM_KEY first. To keep the key out of your shell history:');
    console.error('    read -rs -p "aisstream key: " K && AISSTREAM_KEY="$K" node probe.mjs');
    process.exit(1);
}

// Refuse an obvious placeholder. Written after this script was run with the
// literal string 'paste-your-key' (14 chars) copied straight out of the
// instructions — the second time in one session that a placeholder inside a
// runnable command was pasted verbatim, the first being a Supabase Vault URL
// that cost an hour. A placeholder must fail loudly and instantly, not
// produce a plausible-looking negative result that reads as a dead key.
if (/paste|your.?key|example|^<|xxx|changeme/i.test(KEY) || KEY.length < 20) {
    console.error(`Refusing to run: AISSTREAM_KEY looks like a placeholder (length ${KEY.length}).`);
    console.error('A real aisstream key is a long random string, not a word.');
    console.error('Substitute yours — and to keep it out of your shell history:');
    console.error('    read -rs -p "aisstream key: " K && AISSTREAM_KEY="$K" node probe.mjs');
    process.exit(2);
}

const redact = (s) => (KEY ? s.split(KEY).join('***REDACTED***') : s);

// Deliberately wide. A narrow box that happens to be empty of traffic looks
// identical to a refused subscription, and telling those apart is the whole
// point of this script.
const BOX = [
    [
        [-90, -180],
        [90, 180],
    ],
];

const SECONDS = 30;
let frames = 0;
let firstAt = null;

console.log(`Connecting to aisstream.io …  (key length ${KEY.length}, listening ${SECONDS}s, worldwide)`);

const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

ws.on('open', () => {
    console.log('Socket OPEN. Sending subscription …');
    // Same shape the worker sends.
    ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: BOX }));
    console.log('Subscription sent. Waiting for frames …\n');
});

ws.on('message', (data) => {
    frames++;
    if (firstAt === null) firstAt = Date.now();
    if (frames <= 3) {
        console.log(`--- frame ${frames} ---\n${redact(data.toString()).slice(0, 500)}\n`);
    } else if (frames === 4) {
        console.log('… (further frames suppressed; they are clearly flowing)\n');
    }
});

ws.on('error', (err) => console.error('SOCKET ERROR:', redact(err.message)));

ws.on('close', (code, reason) => {
    const why = reason?.toString?.() || '';
    console.log(`Socket CLOSED (code ${code})${why ? ': ' + redact(why) : ''}`);
});

setTimeout(() => {
    console.log('═'.repeat(60));
    if (frames > 0) {
        console.log(`VERDICT: KEY IS GOOD — ${frames} frames in ${SECONDS}s.`);
        console.log('The fault is downstream, in the worker or its config, not the key.');
    } else {
        console.log('VERDICT: NOTHING RECEIVED in ' + SECONDS + 's, worldwide.');
        console.log('There is always AIS traffic somewhere on Earth, so silence on a');
        console.log('global bounding box means the subscription was refused. The key');
        console.log('or the aisstream.io account behind it is not accepted.');
    }
    console.log('═'.repeat(60));
    ws.close();
    process.exit(frames > 0 ? 0 : 1);
}, SECONDS * 1000);
