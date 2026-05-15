// AMSA (Australian Maritime Safety Authority) MSI Proxy
//
// Scrapes the JRCC Australia / AMSA Maritime Safety Information bulletin
// (NAVAREA X navigational warnings — the Australian-coordinated SafetyNET
// area) and normalises each warning into the same shape the iOS app's
// NoticeToMarinersService consumes for NGA notices.
//
// NGA MSI publishes for US-assigned areas only (NAVAREA IV/XII +
// HYDROLANT/PAC/ARC). Australian users would otherwise see 300+ notices
// with nothing relevant to their actual cruising waters. This function
// adds the AHO-coordinated NAVAREA X feed so the same UI surfaces local
// warnings too.
//
// Source: https://www.operations.amsa.gov.au/AMSA.Web.MSIPublication/Home
//   — a public, login-free HTML bulletin board. AMSA broadcasts the
//   same warnings via Inmarsat SafetyNET / Iridium SafetyCast / HF
//   radio; this page is the public-internet mirror.
//
// Endpoint:
//   GET /proxy-amsa-msi
//
// Response:
//   { "broadcast-warn": [
//       {
//         msgYear, msgNumber, navArea, subregion, text, status,
//         issueDate, authority,
//       }, …
//     ],
//     fetchedAt: 1234567890 (epoch ms)
//   }
//
// Cached at the edge for 1 hour (AMSA refreshes their bulletin board
// every few hours; we don't need to hammer them).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const AMSA_URL = 'https://www.operations.amsa.gov.au/AMSA.Web.MSIPublication/Home';

// In-memory edge cache. Deno deploy keeps the isolate warm for a few
// minutes between requests, so this skips the AMSA round-trip for
// repeat callers within the TTL. 1 hour is generous (AMSA refreshes
// roughly hourly).
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { fetchedAt: number; payload: unknown } | null = null;

interface RawBroadcastWarn {
    msgYear: number;
    msgNumber: number;
    navArea: string;
    subregion: string;
    text: string;
    status: string;
    issueDate: string;
    authority: string;
}

// Strip HTML tags + decode the common entities. We don't need a full
// HTML parser because the AMSA bulletin is wrapped in <pre>-style
// content — the warning text is already preformatted plain text.
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// Warning blocks start with "SECURITE" and end with "NNNN". A single
// bulletin contains many. We split on the SECURITE header so each
// block is one warning; the trailing NNNN is just discarded.
function splitWarnings(text: string): string[] {
    const blocks: string[] = [];
    // Split at each SECURITE that starts a line (case-insensitive).
    const parts = text.split(/(?:^|\n)\s*SECURITE\b/i);
    for (const p of parts) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        // A block must contain a NAVAREA-style header to be a real warning.
        if (/NAVAREA\s+X\s+\d+\/\d+/i.test(trimmed)) {
            blocks.push(trimmed);
        }
    }
    return blocks;
}

// Header parsers — anchored on the predictable two-line opener:
//   FM JRCC AUSTRALIA 132333Z MAY 26
//   NAVAREA X 045/26
const HEADER_RE = /FM\s+JRCC\s+AUSTRALIA\s+(\d{6}Z\s+[A-Z]{3}\s+\d{2,4})/i;
const ID_RE = /NAVAREA\s+X\s+(\d+)\/(\d+)/i;

function parseWarning(block: string): RawBroadcastWarn | null {
    const headerMatch = block.match(HEADER_RE);
    const idMatch = block.match(ID_RE);
    if (!idMatch) return null;

    const msgNumber = Number(idMatch[1]);
    let msgYear = Number(idMatch[2]);
    // AMSA uses 2-digit years (e.g. 26 for 2026). Promote to 4-digit.
    if (msgYear < 100) msgYear = 2000 + msgYear;
    if (!Number.isFinite(msgNumber) || !Number.isFinite(msgYear)) return null;

    // Issue date: normalise AMSA's 2-digit year to 4-digit so it
    // matches the NGA shape ("DDHHMMZ MON YYYY") that parseIssueDate
    // already understands on the iOS side.
    let issueDate = '';
    if (headerMatch) {
        issueDate = headerMatch[1].toUpperCase().replace(/(\d{6}Z\s+[A-Z]{3}\s+)(\d{2})$/i, (_, prefix, yy) => {
            return prefix + (Number(yy) < 100 ? '20' + yy : yy);
        });
    }

    // The body: everything after the ID line, up to (but not including)
    // a trailing NNNN if present.
    const idLineEnd = block.indexOf(idMatch[0]) + idMatch[0].length;
    let body = block
        .slice(idLineEnd)
        .replace(/\bNNNN\b\s*$/i, '')
        .trim();
    // Re-prepend the header so the caller sees the full message text
    // — title extraction on the iOS side reads the first body line as
    // the title, and that should be the chart/area context, not a
    // truncated mid-sentence line.
    const headerLine = `NAVAREA X ${idMatch[1]}/${idMatch[2]}`;
    body = `${headerLine}\n${body}`;

    return {
        msgYear,
        msgNumber,
        navArea: 'X',
        subregion: '',
        text: body,
        status: 'A', // AMSA only publishes in-force warnings on this page
        issueDate,
        authority: 'JRCC AUSTRALIA',
    };
}

async function fetchAndParse(): Promise<{ 'broadcast-warn': RawBroadcastWarn[] }> {
    const res = await fetch(AMSA_URL, {
        headers: {
            // AMSA's IIS server gates on a real-looking UA. Without one
            // it occasionally serves a redirect / "site is being updated"
            // page instead of the bulletin.
            'User-Agent':
                'Mozilla/5.0 (compatible; ThalassaMarine/1.0; +https://github.com/shanestratton/thalassa-marine-weather)',
            Accept: 'text/html,application/xhtml+xml',
        },
    });
    if (!res.ok) {
        throw new Error(`AMSA MSI returned ${res.status}`);
    }
    const html = await res.text();
    const text = htmlToText(html);
    const blocks = splitWarnings(text);
    const warns: RawBroadcastWarn[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
        const w = parseWarning(block);
        if (!w) continue;
        const id = `${w.navArea}-${w.msgYear}/${w.msgNumber}`;
        if (seen.has(id)) continue;
        seen.add(id);
        warns.push(w);
    }
    return { 'broadcast-warn': warns };
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
    }
    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
            status: 405,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }

    try {
        // Edge-level cache to avoid hammering AMSA's IIS box.
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
            return new Response(JSON.stringify(cache.payload), {
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json',
                    'X-Cache': 'HIT',
                },
            });
        }

        const payload = await fetchAndParse();
        cache = { fetchedAt: Date.now(), payload };
        return new Response(JSON.stringify(payload), {
            headers: {
                ...CORS_HEADERS,
                'Content-Type': 'application/json',
                'X-Cache': 'MISS',
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // If we have stale cache, serve it on error rather than failing
        // — bulletin downtime shouldn't break the client's notice page.
        if (cache) {
            return new Response(JSON.stringify({ ...(cache.payload as object), _stale: true }), {
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json',
                    'X-Cache': 'STALE',
                    'X-Error': message,
                },
            });
        }
        return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }
});
