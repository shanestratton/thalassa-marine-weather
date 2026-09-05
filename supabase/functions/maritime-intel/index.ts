/**
 * maritime-intel — Supabase Edge Function
 *
 * Proxies RSS feeds from gCaptain and The Maritime Executive,
 * parses XML with regex (most reliable in Deno), returns combined headlines.
 *
 * Returns: { articles: Array<{ title, snippet, url, source, icon, image, publishedAt }> }
 */

import { safeRssHttpsUrl } from './urlSecurity.ts';
import { readResponseTextLimited } from '../_shared/http-security.ts';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { plainTextFromMarkup } from '../_shared/plain-text.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RSS_FEEDS = [
    { url: 'https://gcaptain.com/feed/', source: 'gCaptain', icon: '⚓' },
    { url: 'https://maritime-executive.com/feed', source: 'Maritime Executive', icon: '🚢' },
];

interface Article {
    title: string;
    snippet: string;
    url: string;
    source: string;
    icon: string;
    image: string | null;
    publishedAt: string;
}

function feedPlainText(fragment: string, maxOutputChars = 20_000): string {
    return plainTextFromMarkup(fragment, {
        maxInputChars: 100_000,
        maxOutputChars,
        preserveLineBreaks: false,
    });
}

/** Extract tag content from XML string */
function getTag(xml: string, tag: string): string {
    // Handle CDATA wrapped content
    const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
    const cdataMatch = xml.match(cdataRe);
    if (cdataMatch) return cdataMatch[1].trim();

    // Plain content
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const match = xml.match(re);
    return match ? match[1].trim() : '';
}

/** Extract first image URL from HTML or media tags */
function extractImage(itemXml: string): string | null {
    // <media:content url="...">
    const mediaMatch = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i);
    if (mediaMatch) return mediaMatch[1];

    // <media:thumbnail url="...">
    const thumbMatch = itemXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
    if (thumbMatch) return thumbMatch[1];

    // <enclosure url="..." type="image/...">
    const encMatch = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
    if (encMatch) return encMatch[1];

    // <img src="..."> inside content
    const imgMatch = itemXml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];

    return null;
}

/** Truncate to ~3-4 sentences */
function toSnippet(text: string, maxLen = 280): string {
    const clean = feedPlainText(text, maxLen + 1);
    if (clean.length <= maxLen) return clean;

    const truncated = clean.substring(0, maxLen);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const lastExcl = truncated.lastIndexOf('!');
    const breakAt = Math.max(lastPeriod, lastQuestion, lastExcl);

    return breakAt > maxLen * 0.4 ? truncated.substring(0, breakAt + 1) : truncated + '…';
}

async function fetchFeed(feed: { url: string; source: string; icon: string }): Promise<Article[]> {
    try {
        const resp = await fetch(feed.url, {
            headers: {
                'User-Agent': 'ThalassaBot/1.0 (Maritime Weather App)',
                Accept: 'application/rss+xml, application/xml, text/xml, */*',
            },
            signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
            console.warn(`[RSS] ${feed.source} returned ${resp.status}`);
            return [];
        }

        const xml = await readResponseTextLimited(resp, 2_000_000);
        if (xml === null) {
            console.warn(`[RSS] ${feed.source} response exceeded limit`);
            return [];
        }
        console.log(`[RSS] ${feed.source}: got ${xml.length} bytes`);

        // Extract all <item> blocks with regex
        const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
        const articles: Article[] = [];
        let match;

        while ((match = itemRegex.exec(xml)) !== null) {
            if (articles.length >= 8) break;

            const itemXml = match[1];
            const title = feedPlainText(getTag(itemXml, 'title'), 500);
            const link = safeRssHttpsUrl(feedPlainText(getTag(itemXml, 'link'), 2_048));
            const description = getTag(itemXml, 'description');
            const contentEncoded = getTag(itemXml, 'content:encoded');
            const pubDate = feedPlainText(getTag(itemXml, 'pubDate'), 200);

            if (!title || !link) continue;

            const imageCandidate = extractImage(itemXml);
            const image = safeRssHttpsUrl(imageCandidate ? feedPlainText(imageCandidate, 2_048) : null);
            const snippet = toSnippet(description || contentEncoded);
            const publishedMs = pubDate ? Date.parse(pubDate) : Number.NaN;

            articles.push({
                title,
                snippet,
                url: link,
                source: feed.source,
                icon: feed.icon,
                image,
                publishedAt: Number.isFinite(publishedMs)
                    ? new Date(publishedMs).toISOString()
                    : new Date().toISOString(),
            });
        }

        console.log(`[RSS] ${feed.source}: parsed ${articles.length} articles`);
        return articles;
    } catch {
        console.warn(`[RSS] ${feed.source} fetch failed`);
        return [];
    }
}

/**
 * One aggregated result per isolate, reused for CACHE_TTL_MS. Five upstream
 * RSS fetches per request was the whole cost of this function, and every
 * client asked the same question; the answer changes a few times an hour.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { at: number; body: string } | null = null;

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    // Audit item 16: this public news feed had no caller or volume control, so
    // one script could make it fan out to five upstream publishers without
    // limit. A signed-in caller gets an authenticated quota; anyone else a
    // lower per-client one keyed by address hash — the helper get-weather uses.
    const caller = await requireAuthenticatedOrPublicQuota(req, 'maritime_intel', 120, 30, 3600);
    if (caller instanceof Response) return withCors(caller, corsHeaders);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return new Response(cached.body, {
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
        });
    }
    try {
        // Fetch all feeds in parallel
        const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));

        const articles: Article[] = [];
        for (const result of results) {
            if (result.status === 'fulfilled') {
                articles.push(...result.value);
            }
        }

        // Sort by date, newest first
        articles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

        // Limit to 12 total
        const limited = articles.slice(0, 12);

        console.log(`[maritime-intel] Returning ${limited.length} articles`);

        const body = JSON.stringify({ articles: limited });

        if (limited.length > 0) cached = { at: Date.now(), body };

        return new Response(body, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=1800',
            },
        });
    } catch {
        console.error('[maritime-intel] request failed');
        return new Response(JSON.stringify({ error: 'Internal server error', articles: [] }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
