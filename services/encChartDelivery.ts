/** Parse pasted deliveries locally. Download URLs are secrets: never log or
 * persist the input, and use only `label` in user-visible package summaries. */
export const ENC_DELIVERY_MAX_PACKAGES = 4;
export const ENC_DELIVERY_MAX_TEXT = 65_536;

export interface EncChartDeliveryPackage {
    url: string;
    label: string;
    /** Only a genuine, safe archive/cell basename, never an endpoint name. */
    filename?: string;
    expectedSha256?: string;
}
export interface EncChartDelivery {
    packages: EncChartDeliveryPackage[];
    errors: string[];
}

interface Link {
    url: string;
    start: number;
    end: number;
    basename: string;
    direct: boolean;
}
const archive = /\.(?:zip|000|00[1-9])$/i;
const fail = (message: string): EncChartDelivery => ({ packages: [], errors: [message] });
const safeLabel = (value: string): string | undefined => {
    const clean = value.trim().replace(/\s+/g, ' ');
    return clean.length > 0 &&
        clean.length <= 100 &&
        !/[<>@?=#\\]/.test(clean) &&
        !Array.from(clean).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
        !/https?:|[a-f0-9]{20}|[a-z0-9_-]{40}/i.test(clean)
        ? clean
        : undefined;
};
const safeFilename = (value: string): string | undefined =>
    archive.test(value) && /^[a-z0-9][a-z0-9._ ()-]*$/i.test(value) ? safeLabel(value) : undefined;

/** Missing checksums are allowed. Supplied checksums are bound only by an
 * explicit filename, a single-package email, or an unambiguous URL/hash block.
 * We never guess the pairing from the order of two unlabelled hash lists. */
export function parseEncChartDelivery(input: string): EncChartDelivery {
    if (!input.trim()) return fail('Paste a chart delivery email or download link to continue.');
    if (input.length > ENC_DELIVERY_MAX_TEXT) return fail('Paste up to four delivery emails or links at a time.');
    // Decode only email HTML separators, not arbitrary URL escapes or signed query strings.
    const text = input
        .replace(/\r\n?/g, '\n')
        .replace(/&amp;/gi, '&')
        .replace(/<br\s*\/?\s*>|<\/(?:p|div|tr|td|th|li|h[1-6])\s*>/gi, '\n');
    const links: Link[] = [];
    const matches = [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi)];
    if (matches.length > 64) return fail('There are too many links. Paste only the chart delivery emails.');
    for (const match of matches) {
        // Strip a surrounding prose bracket only when its opening mate was
        // outside the URL. Never trim signed query punctuation speculatively.
        const closing = ({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[text[match.index! - 1]];
        const raw = closing && match[0].endsWith(closing) ? match[0].slice(0, -1) : match[0];
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            return fail('One of the download links is incomplete or invalid.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol))
            return fail('Only HTTP or HTTPS download links are supported.');
        if (parsed.username || parsed.password)
            return fail('Links containing a username or password are not supported.');
        if (raw.length > 4096) return fail('A download link is too long. Copy its direct link again.');
        parsed.hash = '';
        let basename = parsed.pathname.split('/').pop() ?? '';
        try {
            basename = decodeURIComponent(basename);
        } catch {
            return fail('One of the download links is invalid.');
        }
        links.push({
            url: parsed.href,
            start: match.index!,
            end: match.index! + match[0].length,
            basename,
            direct:
                archive.test(basename) ||
                /(?:^|\/)(?:download|downloads|getchart|getfile)(?:\/|\.|$)/i.test(parsed.pathname),
        });
    }
    // Bare direct-link lists can use opaque endpoints. In whole emails, ignore
    // unrelated shop/help/footer links instead of trying to install the website.
    const remainder = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '').replace(/[\s<>()[\],;]+/g, '');
    const linkOnly = remainder.length === 0;
    const selected = links.filter((link) => link.direct || linkOnly);
    const urls = [...new Set(selected.map((link) => link.url))];
    if (!urls.length)
        return fail('No direct chart download link was found. Copy the delivery email or its download link.');
    if (urls.length > ENC_DELIVERY_MAX_PACKAGES) return fail('Add up to four chart packages at a time.');

    const packages = urls.map((url, index): EncChartDeliveryPackage => {
        const filename = safeFilename(selected.find((link) => link.url === url)!.basename);
        return { url, label: `Chart package ${index + 1}`, ...(filename ? { filename } : {}) };
    });
    const byUrl = new Map(packages.map((entry) => [entry.url, entry]));
    const errors = new Set<string>();
    const bind = (url: string, checksum: string) => {
        const entry = byUrl.get(url)!;
        if (entry.expectedSha256 && entry.expectedSha256 !== checksum)
            errors.add(
                'Conflicting checksums were supplied for the same package. Paste the latest delivery separately.',
            );
        else entry.expectedSha256 = checksum;
    };
    // Remove URL bodies before looking for checksums: a private 64-character
    // token in a download link is not a SHA256 supplied by the chart publisher.
    let visible = text;
    for (const link of [...links].reverse())
        visible = visible.slice(0, link.start) + ' '.repeat(link.end - link.start) + visible.slice(link.end);
    // Keep positions aligned with the URL spans while allowing text copied from
    // HTML (including table cells) to use the same delivery boundaries/titles.
    visible = visible.replace(
        /<\/?(?:html|body|p|div|span|strong|b|i|em|a|table|tbody|tr|td|th|br|ul|ol|li|h[1-6])\b[^>]*>/gi,
        (tag) => ' '.repeat(tag.length),
    );
    const boundaries = [
        0,
        ...[
            ...visible.matchAll(
                /^[ \t]*(?:From:|Subject:|(?:Hi|Hello|Dear)\b[^\n]*|(?:Your[ \t]+)?chart(?:[ \t]+has[ \t]+been)?[ \t]+successfully[ \t]+processed\b|[- ]*(?:Forwarded|Original) message|Begin forwarded message)/gim,
            ),
        ].map((m) => m.index!),
        text.length,
    ];
    const segments = [...new Set(boundaries)].sort((a, b) => a - b);
    for (let segment = 0; segment < segments.length - 1; segment++) {
        const from = segments[segment],
            to = segments[segment + 1];
        const block = visible.slice(from, to);
        const blockLinks = selected.filter((link) => link.start >= from && link.start < to);
        const blockUrls = [...new Set(blockLinks.map((link) => link.url))];
        // The real delivery puts Chart: AFTER its download link. Chart metadata
        // is never an email boundary: its following checksum belongs to that URL.
        const titles = [
            ...new Set(
                [...block.matchAll(/^[ \t]*Chart:[ \t]*(?:\n[ \t]*)?([^\n<]+)/gim)]
                    .map((match) => match[1].trim())
                    .filter((title) => !/^[a-z][a-z -]{0,30}:/i.test(title))
                    .map(safeLabel)
                    .filter((title): title is string => !!title),
            ),
        ];
        if (titles.length === 1 && blockUrls.length === 1) {
            byUrl.get(blockUrls[0])!.label = titles[0];
        }
        const hashes = [...block.matchAll(/\b[a-f0-9]{64}\b/gi)];
        // Every explicit SHA label needs its own complete digest. A second
        // malformed checksum must not disappear just because the first is valid.
        const checksumLabels = [...block.matchAll(/\bsha[- ]?256\b/gi)];
        for (const [index, label] of checksumLabels.entries()) {
            const until = checksumLabels[index + 1]?.index ?? block.length;
            if (!/\b[a-f0-9]{64}\b/i.test(block.slice(label.index! + label[0].length, until).slice(0, 512)))
                errors.add('A supplied SHA256 checksum is incomplete. Paste the full delivery email again.');
        }
        for (const hash of hashes) {
            const position = from + hash.index!;
            const lineStart = visible.lastIndexOf('\n', position - 1) + 1;
            const nextLine = visible.indexOf('\n', position);
            const line = visible.slice(lineStart, nextLine < 0 ? visible.length : nextLine);
            const explicitFilename =
                /sha[- ]?256\s*\(([^)]+)\)/i.exec(line)?.[1]?.trim() ??
                /^[a-f0-9]{64}\s+\*?([^\s]+\.(?:zip|000|00[1-9]))\s*$/i.exec(line.trim())?.[1];
            if (explicitFilename) {
                const matches = [
                    ...new Set(selected.filter((link) => link.basename === explicitFilename).map((link) => link.url)),
                ];
                const localMatches = matches.filter((url) => blockUrls.includes(url));
                const matching = localMatches.length === 1 ? localMatches : matches;
                if (matching.length === 1) bind(matching[0], hash[0].toLowerCase());
                else
                    errors.add(
                        'A checksum names a package that cannot be identified safely. Paste its matching delivery separately.',
                    );
                continue;
            }
            const named = [
                ...new Set(
                    selected.filter((link) => link.basename && line.includes(link.basename)).map((link) => link.url),
                ),
            ];
            if (named.length === 1) {
                bind(named[0], hash[0].toLowerCase());
                continue;
            }
            if (blockUrls.length === 1) {
                bind(blockUrls[0], hash[0].toLowerCase());
                continue;
            }
            const before = text.lastIndexOf('\n\n', position);
            const after = text.indexOf('\n\n', position);
            const paragraphUrls = [
                ...new Set(
                    selected
                        .filter((link) => link.start > before && link.start < (after < 0 ? text.length : after))
                        .map((link) => link.url),
                ),
            ];
            if (paragraphUrls.length === 1) bind(paragraphUrls[0], hash[0].toLowerCase());
            else
                errors.add(
                    'A checksum cannot be matched safely to one package. Paste each delivery separately, or keep each link and checksum together.',
                );
        }
    }
    return errors.size ? { packages: [], errors: [...errors] } : { packages, errors: [] };
}
