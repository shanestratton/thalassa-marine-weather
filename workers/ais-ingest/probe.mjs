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

const PER_VARIANT_SECONDS = 12;

/**
 * Payload shapes to try, in order.
 *
 * Measured 2026-08-12: a deliberately bogus key gets the socket CLOSED with
 * code 1006, while Shane's real key leaves it OPEN and silent. Those are
 * different behaviours, so aisstream is reading the key and declining to
 * hang up — the subscription is being accepted and then ignored. That
 * implicates the payload shape rather than the credential, and the shape is
 * exactly what changed today: the worker sent `Apikey` for the months it
 * ingested happily, and I changed it to `APIKey` on the strength of the
 * published docs. Rather than argue about which is right, try both.
 */
const VARIANTS = [
    { label: 'APIKey + BoundingBoxes (current worker)', body: { APIKey: KEY, BoundingBoxes: BOX } },
    { label: 'Apikey + BoundingBoxes (original spelling)', body: { Apikey: KEY, BoundingBoxes: BOX } },
    {
        label: 'APIKey + BoundingBoxes + FilterMessageTypes (full worker payload)',
        body: {
            APIKey: KEY,
            BoundingBoxes: BOX,
            FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
        },
    },
];

console.log(`Testing ${VARIANTS.length} subscription shapes, ${PER_VARIANT_SECONDS}s each.`);
console.log(`(key length ${KEY.length}, worldwide bounding box)\n`);

function tryVariant({ label, body }) {
    return new Promise((resolve) => {
        let frames = 0;
        let closed = null;
        const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
        const done = () => {
            try {
                ws.close();
            } catch {
                /* already gone */
            }
            resolve({ label, frames, closed });
        };

        ws.on('open', () => ws.send(JSON.stringify(body)));
        ws.on('message', (data) => {
            frames++;
            if (frames <= 2) console.log(`    frame: ${redact(data.toString()).slice(0, 300)}`);
        });
        ws.on('error', (err) => console.log(`    socket error: ${redact(err.message)}`));
        ws.on('close', (code, reason) => {
            const why = reason?.toString?.() || '';
            closed = `${code}${why ? ' — ' + redact(why) : ''}`;
        });
        setTimeout(done, PER_VARIANT_SECONDS * 1000);
    });
}

const results = [];
for (const v of VARIANTS) {
    console.log(`→ ${v.label}`);
    const r = await tryVariant(v);
    console.log(`  ${r.frames} frames${r.closed ? `, socket closed ${r.closed}` : ', socket stayed open'}\n`);
    results.push(r);
}

const winner = results.find((r) => r.frames > 0);
console.log('═'.repeat(64));
if (winner) {
    console.log(`VERDICT: THE KEY IS GOOD. Working shape: ${winner.label}`);
    console.log('Make the worker send exactly that payload.');
} else if (results.every((r) => r.closed && r.closed.startsWith('1006'))) {
    console.log('VERDICT: every shape was DISCONNECTED — the key itself is refused.');
    console.log('Generate a fresh key from a signed-in aisstream.io session.');
} else {
    console.log('VERDICT: accepted but silent on every shape.');
    console.log('The socket is not being dropped, so the key is not simply invalid —');
    console.log('aisstream is taking the subscription and sending nothing. That points');
    console.log('at the ACCOUNT (quota, tier, or suspension) rather than the key string.');
    console.log('Check aisstream.io for any notice on the account itself.');
}
console.log('═'.repeat(64));
process.exit(winner ? 0 : 1);
