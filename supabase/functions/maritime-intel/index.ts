/**
 * maritime-intel — Supabase Edge Function
 *
 * Proxies RSS feeds from gCaptain and The Maritime Executive,
 * parses XML with regex (most reliable in Deno), returns combined headlines.
 *
 * Returns: { articles: Array<{ title, snippet, url, source, icon, image, publishedAt }> }
 */

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

/** Strip HTML tags and decode entities */
function stripHtml(html: string): string {
    return html
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#8217;/g, "'")
        .replace(/&#8216;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"')
        .replace(/&#8211;/g, '–')
        .replace(/&#8212;/g, '—')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
    const clean = stripHtml(text);
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

        const xml = await resp.text();
        console.log(`[RSS] ${feed.source}: got ${xml.length} bytes`);

        // Extract all <item> blocks with regex
        const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
        const articles: Article[] = [];
        let match;

        while ((match = itemRegex.exec(xml)) !== null) {
            if (articles.length >= 8) break;

            const itemXml = match[1];
            const title = stripHtml(getTag(itemXml, 'title'));
            const link = stripHtml(getTag(itemXml, 'link'));
            const description = getTag(itemXml, 'description');
            const contentEncoded = getTag(itemXml, 'content:encoded');
            const pubDate = stripHtml(getTag(itemXml, 'pubDate'));

            if (!title || !link) continue;

            const image = extractImage(itemXml);
            const snippet = toSnippet(description || contentEncoded);

            articles.push({
                title,
                snippet,
                url: link,
                source: feed.source,
                icon: feed.icon,
                image,
                publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
            });
        }

        console.log(`[RSS] ${feed.source}: parsed ${articles.length} articles`);
        return articles;
    } catch (e) {
        console.warn(`[RSS] ${feed.source} fetch failed:`, e);
        return [];
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
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

        return new Response(JSON.stringify({ articles: limited }), {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=1800',
            },
        });
    } catch (e) {
        console.error('[maritime-intel] error:', e);
        return new Response(JSON.stringify({ error: 'Internal server error', articles: [] }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
