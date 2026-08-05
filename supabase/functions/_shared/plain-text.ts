/**
 * Converts bounded, untrusted HTML/XML fragments into display-only plain text.
 *
 * Edge functions cannot rely on a browser DOM. This scanner deliberately does
 * not try to repair or reserialize markup: it skips tag tokens, suppresses
 * executable/style bodies, decodes each entity at most once, normalises
 * whitespace, rejects control characters, and stops at explicit input/output
 * budgets.
 */

export interface PlainTextOptions {
    maxInputChars?: number;
    maxOutputChars?: number;
    preserveLineBreaks?: boolean;
}

const DEFAULT_MAX_INPUT_CHARS = 100_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const ABSOLUTE_MAX_INPUT_CHARS = 5_000_000;
const ABSOLUTE_MAX_OUTPUT_CHARS = 5_000_000;
const MAX_TAG_CHARS = 8_192;
const MAX_ENTITY_CHARS = 32;

const BLOCK_TAGS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'br',
    'dd',
    'div',
    'dl',
    'dt',
    'figcaption',
    'figure',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
]);

const HIDDEN_BODY_TAGS = new Set(['script', 'style', 'template']);

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    amp: '&',
    apos: "'",
    bull: '•',
    copy: '©',
    deg: '°',
    emdash: '—',
    ensp: ' ',
    gt: '>',
    hellip: '…',
    laquo: '«',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    middot: '·',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    raquo: '»',
    rdquo: '”',
    reg: '®',
    rsquo: '’',
    thinsp: ' ',
    trade: '™',
});

interface TagToken {
    end: number;
    name: string;
    closing: boolean;
    selfClosing: boolean;
}

interface EntityToken {
    end: number;
    value: string;
}

function boundedLimit(value: number | undefined, fallback: number, absoluteMaximum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return fallback;
    return Math.min(value, absoluteMaximum);
}

function isAsciiLetter(char: string): boolean {
    const code = char.charCodeAt(0);
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(char: string): boolean {
    const code = char.charCodeAt(0);
    return (
        isAsciiLetter(char) ||
        (code >= 48 && code <= 57) ||
        char === ':' ||
        char === '-' ||
        char === '_'
    );
}

function isTagWhitespace(char: string): boolean {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function readTagToken(source: string, start: number, scanLimit: number): TagToken | null {
    let cursor = start + 1;
    let closing = false;
    if (source[cursor] === '/') {
        closing = true;
        cursor++;
    }
    while (cursor < scanLimit && isTagWhitespace(source[cursor])) cursor++;
    if (cursor >= scanLimit || !isAsciiLetter(source[cursor])) return null;

    const nameStart = cursor;
    while (cursor < scanLimit && isTagNameChar(source[cursor])) cursor++;
    const name = source.slice(nameStart, cursor).toLowerCase();
    const tagScanEnd = Math.min(scanLimit, start + MAX_TAG_CHARS);
    let quote = '';
    for (; cursor < tagScanEnd; cursor++) {
        const char = source[cursor];
        if (quote) {
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '>') {
            let slashCursor = cursor - 1;
            while (slashCursor > nameStart && isTagWhitespace(source[slashCursor])) slashCursor--;
            return {
                end: cursor + 1,
                name,
                closing,
                selfClosing: source[slashCursor] === '/',
            };
        }
    }
    return null;
}

function numericEntityValue(body: string): string | null {
    let cursor = 1;
    let radix = 10;
    if (body[cursor] === 'x' || body[cursor] === 'X') {
        radix = 16;
        cursor++;
    }
    if (cursor >= body.length) return null;

    let value = 0;
    for (; cursor < body.length; cursor++) {
        const code = body.charCodeAt(cursor);
        let digit = -1;
        if (code >= 48 && code <= 57) digit = code - 48;
        else if (radix === 16 && code >= 65 && code <= 70) digit = code - 55;
        else if (radix === 16 && code >= 97 && code <= 102) digit = code - 87;
        if (digit < 0 || digit >= radix) return null;
        value = value * radix + digit;
        if (value > 0x10ffff) return null;
    }

    if (value === 0 || (value >= 0xd800 && value <= 0xdfff)) return '�';
    if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) return ' ';
    return String.fromCodePoint(value);
}

function readEntityToken(source: string, start: number, scanLimit: number): EntityToken | null {
    const entityLimit = Math.min(scanLimit, start + MAX_ENTITY_CHARS);
    let end = start + 1;
    while (end < entityLimit && source[end] !== ';') end++;
    if (end >= entityLimit || source[end] !== ';') return null;

    const body = source.slice(start + 1, end);
    if (!body) return null;
    const value = body[0] === '#' ? numericEntityValue(body) : NAMED_ENTITIES[body.toLowerCase()] ?? null;
    return value === null ? null : { end: end + 1, value };
}

function isCollapsibleWhitespace(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return (
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0b ||
        code === 0x0c ||
        code === 0x0d ||
        code === 0x20 ||
        code === 0x85 ||
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000
    );
}

function isLineWhitespace(char: string): boolean {
    return char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
}

export function plainTextFromMarkup(markup: string, options: PlainTextOptions = {}): string {
    const maxInputChars = boundedLimit(options.maxInputChars, DEFAULT_MAX_INPUT_CHARS, ABSOLUTE_MAX_INPUT_CHARS);
    const maxOutputChars = boundedLimit(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, ABSOLUTE_MAX_OUTPUT_CHARS);
    const preserveLineBreaks = options.preserveLineBreaks === true;
    const scanLimit = Math.min(markup.length, maxInputChars);

    let output = '';
    let pendingWhitespace: 0 | 1 | 2 = 0;
    let hiddenTag = '';
    let hiddenDepth = 0;

    const queueWhitespace = (lineBreak: boolean): void => {
        const desired = preserveLineBreaks && lineBreak ? 2 : 1;
        if (desired > pendingWhitespace) pendingWhitespace = desired as 1 | 2;
    };

    const appendVisible = (value: string): void => {
        for (const char of value) {
            const code = char.codePointAt(0) ?? 0;
            if (isCollapsibleWhitespace(char)) {
                queueWhitespace(isLineWhitespace(char));
                continue;
            }
            if (code < 0x20 || code === 0x7f) continue;

            const separator = output.length > 0
                ? (pendingWhitespace === 2 ? '\n' : pendingWhitespace === 1 ? ' ' : '')
                : '';
            const required = separator.length + char.length;
            if (output.length + required > maxOutputChars) return;
            output += separator + char;
            pendingWhitespace = 0;
        }
    };

    let cursor = 0;
    while (cursor < scanLimit && output.length < maxOutputChars) {
        if (markup.startsWith(']]>', cursor)) {
            cursor += 3;
            continue;
        }

        const char = markup[cursor];
        if (char === '&' && hiddenDepth === 0) {
            const entity = readEntityToken(markup, cursor, scanLimit);
            if (entity) {
                appendVisible(entity.value);
                cursor = entity.end;
                continue;
            }
        }

        if (char !== '<') {
            if (hiddenDepth === 0) appendVisible(char);
            cursor++;
            continue;
        }

        if (markup.startsWith('<!--', cursor)) {
            const commentEnd = markup.indexOf('-->', cursor + 4);
            if (commentEnd < 0 || commentEnd >= scanLimit) break;
            cursor = commentEnd + 3;
            continue;
        }
        if (markup.startsWith('<![CDATA[', cursor)) {
            cursor += 9;
            continue;
        }
        if (markup.startsWith('<!', cursor) || markup.startsWith('<?', cursor)) {
            const declarationEnd = markup.indexOf('>', cursor + 2);
            if (declarationEnd < 0 || declarationEnd >= scanLimit) break;
            cursor = declarationEnd + 1;
            continue;
        }

        const tag = readTagToken(markup, cursor, scanLimit);
        if (!tag) {
            if (hiddenDepth === 0) appendVisible('<');
            cursor++;
            continue;
        }
        cursor = tag.end;

        if (hiddenDepth > 0) {
            if (tag.name === hiddenTag) {
                if (tag.closing) hiddenDepth--;
                else if (!tag.selfClosing) hiddenDepth++;
                if (hiddenDepth === 0) {
                    hiddenTag = '';
                    queueWhitespace(true);
                }
            }
            continue;
        }

        if (!tag.closing && !tag.selfClosing && HIDDEN_BODY_TAGS.has(tag.name)) {
            hiddenTag = tag.name;
            hiddenDepth = 1;
            queueWhitespace(true);
            continue;
        }
        if (BLOCK_TAGS.has(tag.name)) queueWhitespace(true);
    }

    return output;
}
