// UKHO (UK Hydrographic Office) MSI Proxy
//
// Scrapes the UKHO Maritime Safety Information radio navigational warnings
// page at msi.admiralty.co.uk and normalises each warning into the same
// RawBroadcastWarn shape the iOS app's NoticeToMarinersService consumes
// for NGA and AMSA notices.
//
// UKHO is the NAVAREA I coordinator (NE Atlantic) for the WWNWS and also
// publishes UK Coastal Warnings (WZ). Both appear in the same table.
//
// Source: https://msi.admiralty.co.uk/RadioNavigationalWarnings
//   — a public, login-free HTML page rendering an "in-force" warnings
//   table. Updated continuously from UKHO's broadcast feed.
//
// Endpoint:
//   GET /proxy-ukho-msi
//
// Response: same shape as NGA's broadcast-warn:
//   { "broadcast-warn": [ { msgYear, msgNumber, navArea, … }, … ] }
//
// Edge-cached for 1 hour (UKHO refreshes their MSI page within minutes
// of an Inmarsat SafetyNET broadcast; we don't need to hammer them).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const UKHO_URL = 'https://msi.admiralty.co.uk/RadioNavigationalWarnings';

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

// Decode common HTML entities. UKHO's <pre> bodies use &#xA; for the
// internal line breaks, plus standard &amp; / &lt; / &gt; / &quot;.
function decodeEntities(s: string): string {
    return s
        .replace(/&#xA;/gi, '\n')
        .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

// Strip any leftover tags (we ran on a <pre> block already, but defend
// against stray <span> wrappers etc. that UKHO sometimes adds for
// hyperlinking chart references).
function stripTags(s: string): string {
    return s.replace(/<[^>]+>/g, '');
}

// Normalise a UKHO datetime string like "122320 UTC May 26" into the
// NGA-style "DDHHMMZ MON YYYY" the iOS-side parseIssueDate understands.
function normaliseDate(raw: string): string {
    // Match "DDHHMM UTC <Month> YY" — month is human-cased, year is 2-digit.
    const m = raw.trim().match(/^(\d{6})\s+UTC\s+([A-Za-z]+)\s+(\d{2,4})$/);
    if (!m) return raw.trim();
    const ddhhmm = m[1];
    const month = m[2].slice(0, 3).toUpperCase();
    let year = Number(m[3]);
    if (year < 100) year = 2000 + year;
    return `${ddhhmm}Z ${month} ${year}`;
}

// UKHO references look like:
//   "NAVAREA I 91/26"     — NAVAREA I (NE Atlantic), msg 91 of 2026
//   "WZ 317/26"           — UK Coastal warning (Warning Zone), msg 317 of 2026
//   "WS 042/26"           — UK Subfacts (occasionally on the same page)
function parseReference(ref: string): { navArea: string; msgNumber: number; msgYear: number } | null {
    const navarea = ref.match(/NAVAREA\s+I\s+(\d+)\/(\d+)/i);
    if (navarea) {
        let year = Number(navarea[2]);
        if (year < 100) year = 2000 + year;
        return { navArea: 'I', msgNumber: Number(navarea[1]), msgYear: year };
    }
    const wz = ref.match(/\bWZ\s+(\d+)\/(\d+)/i);
    if (wz) {
        let year = Number(wz[2]);
        if (year < 100) year = 2000 + year;
        return { navArea: 'WZ', msgNumber: Number(wz[1]), msgYear: year };
    }
    return null;
}

async function fetchAndParse(): Promise<{ 'broadcast-warn': RawBroadcastWarn[] }> {
    const res = await fetch(UKHO_URL, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (compatible; ThalassaMarine/1.0; +https://github.com/shanestratton/thalassa-marine-weather)',
            Accept: 'text/html,application/xhtml+xml',
        },
    });
    if (!res.ok) throw new Error(`UKHO MSI returned ${res.status}`);
    const html = await res.text();

    // UKHO renders one tr per warning in the body table, then a
    // sibling <tr id="collapse_N">…<pre id="Details_Description_N">…
    // We pull the structured cells from the row + the full body
    // from the collapse <pre>.
    //
    // Header cells per row N:
    //   <td id="Reference_N">     → "NAVAREA I 91/26"
    //   <td id="DateTimeGroupRnwFormat_N"> → "122320 UTC May 26"
    //   <td id="Description_N">   → first line / summary
    //
    // Full body:
    //   <pre id="Details_Description_N" class="warning-description">…</pre>

    const warns: RawBroadcastWarn[] = [];
    const seen = new Set<string>();

    const refRe = /<td\s+id=["']Reference_(\d+)["'][^>]*>([\s\S]*?)<\/td>/gi;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(html))) {
        const idx = m[1];
        const refText = stripTags(decodeEntities(m[2])).trim();
        const parsed = parseReference(refText);
        if (!parsed) continue;

        // DateTime cell
        const dtRe = new RegExp(`<td\\s+id=["']DateTimeGroupRnwFormat_${idx}["'][^>]*>([\\s\\S]*?)<\\/td>`, 'i');
        const dtMatch = html.match(dtRe);
        const issueDate = dtMatch ? normaliseDate(stripTags(decodeEntities(dtMatch[1]))) : '';

        // Full description from the collapse <pre>. Falls back to the
        // short Description_N cell if the <pre> isn't present.
        let body = '';
        const preRe = new RegExp(`<pre\\s+id=["']Details_Description_${idx}["'][^>]*>([\\s\\S]*?)<\\/pre>`, 'i');
        const preMatch = html.match(preRe);
        if (preMatch) {
            body = stripTags(decodeEntities(preMatch[1])).trim();
        } else {
            const descRe = new RegExp(`<td\\s+id=["']Description_${idx}["'][^>]*>([\\s\\S]*?)<\\/td>`, 'i');
            const descMatch = html.match(descRe);
            body = descMatch ? stripTags(decodeEntities(descMatch[1])).trim() : '';
        }

        // Prepend the reference as the first body line so the iOS-side
        // title builder grabs the reference number first rather than the
        // first body sentence (same pattern as the AMSA proxy).
        const text = `${refText}\n${body}`.trim();

        const id = `${parsed.navArea}-${parsed.msgYear}/${parsed.msgNumber}`;
        if (seen.has(id)) continue;
        seen.add(id);

        warns.push({
            msgYear: parsed.msgYear,
            msgNumber: parsed.msgNumber,
            navArea: parsed.navArea,
            subregion: '',
            text,
            status: 'A',
            issueDate,
            authority: 'UKHO',
        });
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
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
            return new Response(JSON.stringify(cache.payload), {
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
            });
        }
        const payload = await fetchAndParse();
        cache = { fetchedAt: Date.now(), payload };
        return new Response(JSON.stringify(payload), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
