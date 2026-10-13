/**
 * CAP 1.2 (OASIS Common Alerting Protocol) for the official-warnings ingest (129-05).
 *
 * One small XML reader and the CAP and Atom shapes built on it, shared by every
 * provider adapter (_shared/official-alerts/adapters.ts) and by the tests. No
 * dependency: the edge tier has no XML library, and this tree is also type-checked
 * and run by the app's own tests under Node.
 *
 * Global from the start:
 * - A CAP alert carries one <info> per language (MeteoAlarm Greece sends en-GB
 *   and el-GR; ECCC sends fr-CA and en-CA). Every block is kept, in the issuer's
 *   order. pickInfo() chooses the reader's language, else the issuer's first.
 * - Text is the issuer's, byte for byte after XML decoding: never translated,
 *   re-cased, re-wrapped or summarised. Only the whitespace around a value is
 *   trimmed.
 * - CAP polygons are "lat,lon lat,lon ..."; they are turned into GeoJSON order
 *   ([lon, lat]) here, once.
 *
 * The XML reader decodes the five predefined entities and numeric character
 * references only. A DOCTYPE is skipped and its entities are never expanded, so a
 * feed cannot make it fetch anything or blow up in memory. A document that does
 * not nest properly is null, never half a tree.
 */

export interface XmlNode {
    /** The local name: "cap:identifier" is "identifier". */
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    /** The element's own text (its text and CDATA children, in order), decoded. */
    text: string;
}

const MAX_XML_CHARS = 16_000_000;
const MAX_DEPTH = 96;
const MAX_NODES = 400_000;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
    if (!raw.includes('&')) return raw;
    return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,5});/g, (whole, ref: string) => {
        if (ref[0] === '#') {
            const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[ref] ?? whole;
    });
}

const localName = (qname: string): string => {
    const at = qname.indexOf(':');
    return at >= 0 ? qname.slice(at + 1) : qname;
};

function parseAttrs(source: string): Record<string, string> | null {
    const attrs: Record<string, string> = {};
    const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let rest = source;
    for (const m of source.matchAll(re)) {
        attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? '');
        rest = rest.replace(m[0], '');
    }
    // Anything left over that is not whitespace is a broken attribute list.
    return /^\s*$/.test(rest) ? attrs : null;
}

/** The root element of an XML document, or null when it is not well formed. */
export function parseXml(input: string): XmlNode | null {
    if (typeof input !== 'string' || input.length === 0 || input.length > MAX_XML_CHARS) return null;
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const stack: XmlNode[] = [];
    const parts: string[][] = [];
    let root: XmlNode | null = null;
    let nodes = 0;
    let i = 0;
    const len = text.length;
    while (i < len) {
        const lt = text.indexOf('<', i);
        const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
        if (chunk.length > 0) {
            if (stack.length > 0) parts[parts.length - 1].push(decodeEntities(chunk));
            else if (/\S/.test(chunk)) return null; // text outside the root element
        }
        if (lt < 0) break;
        if (text.startsWith('<!--', lt)) {
            const end = text.indexOf('-->', lt + 4);
            if (end < 0) return null;
            i = end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', lt)) {
            const end = text.indexOf(']]>', lt + 9);
            if (end < 0 || stack.length === 0) return null;
            parts[parts.length - 1].push(text.slice(lt + 9, end));
            i = end + 3;
            continue;
        }
        if (text.startsWith('<?', lt)) {
            const end = text.indexOf('?>', lt + 2);
            if (end < 0) return null;
            i = end + 2;
            continue;
        }
        if (text.startsWith('<!', lt)) {
            // DOCTYPE (with or without an internal subset): skipped, never expanded.
            let depth = 0;
            let j = lt + 2;
            for (; j < len; j++) {
                const c = text[j];
                if (c === '[') depth++;
                else if (c === ']') depth--;
                else if (c === '>' && depth <= 0) break;
            }
            if (j >= len) return null;
            i = j + 1;
            continue;
        }
        // The tag ends at the first '>' outside a quoted attribute value (a title may hold "a > b").
        let gt = -1;
        let quote = '';
        for (let j = lt + 1; j < len; j++) {
            const c = text[j];
            if (quote) {
                if (c === quote) quote = '';
            } else if (c === '"' || c === "'") quote = c;
            else if (c === '>') {
                gt = j;
                break;
            } else if (c === '<') return null;
        }
        if (gt < 0) return null;
        const inner = text.slice(lt + 1, gt);
        if (inner[0] === '/') {
            const name = localName(inner.slice(1).trim());
            const open = stack.pop();
            const own = parts.pop();
            if (!open || open.name !== name || !own) return null;
            open.text = own.join('').trim();
            if (stack.length === 0) {
                if (root) return null;
                root = open;
            }
            i = gt + 1;
            continue;
        }
        const selfClosing = inner.endsWith('/');
        const body = selfClosing ? inner.slice(0, -1) : inner;
        const nameMatch = /^([^\s/>]+)/.exec(body);
        if (!nameMatch) return null;
        const attrs = parseAttrs(body.slice(nameMatch[1].length));
        if (!attrs) return null;
        const node: XmlNode = { name: localName(nameMatch[1]), attrs, children: [], text: '' };
        if (++nodes > MAX_NODES) return null;
        if (stack.length > 0) stack[stack.length - 1].children.push(node);
        else if (root) return null; // a second root element
        if (selfClosing) {
            if (stack.length === 0) root = node;
        } else {
            if (stack.length >= MAX_DEPTH) return null;
            stack.push(node);
            parts.push([]);
        }
        i = gt + 1;
    }
    return stack.length === 0 ? root : null;
}

/** The first direct child with this local name. */
export const child = (node: XmlNode | null | undefined, name: string): XmlNode | undefined =>
    node?.children.find((c) => c.name === name);

/** Every direct child with this local name. */
export const childrenNamed = (node: XmlNode | null | undefined, name: string): XmlNode[] =>
    node ? node.children.filter((c) => c.name === name) : [];

/** A direct child's text, or null when it is missing or empty. */
export const childText = (node: XmlNode | null | undefined, name: string): string | null => {
    const t = child(node, name)?.text;
    return t ? t : null;
};

/** Every element with this local name anywhere below the node, in document order. */
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
    for (const c of node.children) {
        if (c.name === name) out.push(c);
        descendants(c, name, out);
    }
    return out;
}

// ── CAP 1.2 ─────────────────────────────────────────────────────────────

export interface CapValue {
    valueName: string;
    value: string;
}

export interface CapCircle {
    lat: number;
    lon: number;
    radiusKm: number;
}

export interface CapArea {
    areaDesc: string;
    /** Rings in GeoJSON order, [lon, lat], each closed. */
    polygons: [number, number][][];
    circles: CapCircle[];
    geocodes: CapValue[];
}

export interface CapInfo {
    language: string;
    category: string[];
    event: string;
    responseType: string[];
    urgency: string;
    severity: string;
    certainty: string;
    audience: string | null;
    eventCodes: CapValue[];
    effective: string | null;
    onset: string | null;
    expires: string | null;
    senderName: string | null;
    headline: string | null;
    description: string | null;
    instruction: string | null;
    web: string | null;
    contact: string | null;
    parameters: CapValue[];
    areas: CapArea[];
}

export interface CapReference {
    sender: string;
    identifier: string;
    sent: string;
}

export interface CapAlert {
    identifier: string;
    sender: string;
    sent: string;
    status: string;
    msgType: string;
    source: string | null;
    scope: string;
    code: string[];
    note: string | null;
    references: CapReference[];
    infos: CapInfo[];
}

const STATUS = new Set(['Actual', 'Exercise', 'System', 'Test', 'Draft']);
const MSG_TYPE = new Set(['Alert', 'Update', 'Cancel', 'Ack', 'Error']);

/** True for a CAP dateTime with a zone ("2026-10-13T18:28:01-00:00"): CAP requires the offset. */
export function isCapTime(value: string | null | undefined): value is string {
    return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        Number.isFinite(Date.parse(value));
}

/** A CAP or ISO time as an ISO instant, or null. */
export function toIso(value: string | null | undefined): string | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const values = (node: XmlNode | undefined, name: string): CapValue[] =>
    childrenNamed(node, name)
        .map((v) => ({ valueName: childText(v, 'valueName') ?? '', value: child(v, 'value')?.text ?? '' }))
        .filter((v) => v.valueName.length > 0);

/** One CAP polygon: at least four "lat,lon" pairs, closed (the first again at the end), as [lon, lat]. */
export function parseCapPolygon(text: string): [number, number][] | null {
    const ring: [number, number][] = [];
    for (const pair of text.trim().split(/\s+/)) {
        const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(pair);
        if (!m) return null;
        const lat = Number(m[1]);
        const lon = Number(m[2]);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
        ring.push([lon, lat]);
    }
    if (ring.length < 3) return null;
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
    return ring.length >= 4 ? ring : null;
}

/** One CAP circle: "lat,lon radius" with the radius in km. */
export function parseCapCircle(text: string): CapCircle | null {
    const m = /^\s*(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/.exec(text);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    const radiusKm = Number(m[3]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && radiusKm > 0 && radiusKm <= 5000
        ? { lat, lon, radiusKm }
        : null;
}

function parseArea(node: XmlNode): CapArea {
    return {
        areaDesc: childText(node, 'areaDesc') ?? '',
        polygons: childrenNamed(node, 'polygon')
            .map((p) => parseCapPolygon(p.text))
            .filter((p): p is [number, number][] => p !== null),
        circles: childrenNamed(node, 'circle')
            .map((c) => parseCapCircle(c.text))
            .filter((c): c is CapCircle => c !== null),
        geocodes: values(node, 'geocode'),
    };
}

function parseInfo(node: XmlNode): CapInfo | null {
    const event = childText(node, 'event');
    const urgency = childText(node, 'urgency');
    const severity = childText(node, 'severity');
    const certainty = childText(node, 'certainty');
    // CAP 1.2: event, urgency, severity and certainty are required in every info.
    if (!event || !urgency || !severity || !certainty) return null;
    return {
        // CAP 1.2: "If not present, an implicit default value of 'en-US' SHALL be assumed."
        language: childText(node, 'language') ?? 'en-US',
        category: childrenNamed(node, 'category').map((c) => c.text).filter(Boolean),
        event,
        responseType: childrenNamed(node, 'responseType').map((c) => c.text).filter(Boolean),
        urgency,
        severity,
        certainty,
        audience: childText(node, 'audience'),
        eventCodes: values(node, 'eventCode'),
        effective: childText(node, 'effective'),
        onset: childText(node, 'onset'),
        expires: childText(node, 'expires'),
        senderName: childText(node, 'senderName'),
        headline: childText(node, 'headline'),
        description: childText(node, 'description'),
        instruction: childText(node, 'instruction'),
        web: childText(node, 'web'),
        contact: childText(node, 'contact'),
        parameters: values(node, 'parameter'),
        areas: childrenNamed(node, 'area').map(parseArea),
    };
}

/** CAP references: space-separated "sender,identifier,sent" triples. */
export function parseCapReferences(text: string | null): CapReference[] {
    if (!text) return [];
    const out: CapReference[] = [];
    for (const triple of text.trim().split(/\s+/)) {
        const parts = triple.split(',');
        if (parts.length !== 3 || !parts[1]) continue;
        out.push({ sender: parts[0], identifier: parts[1], sent: parts[2] });
    }
    return out;
}

/** A CAP 1.2 <alert> (a document, or an element already read), or null when a required part is missing. */
export function parseCapAlert(input: string | XmlNode): CapAlert | null {
    const root = typeof input === 'string' ? parseXml(input) : input;
    if (!root || root.name !== 'alert') return null;
    const identifier = childText(root, 'identifier');
    const sender = childText(root, 'sender');
    const sent = childText(root, 'sent');
    const status = childText(root, 'status');
    const msgType = childText(root, 'msgType');
    const scope = childText(root, 'scope');
    if (!identifier || !sender || !isCapTime(sent) || !status || !STATUS.has(status)) return null;
    if (!msgType || !MSG_TYPE.has(msgType) || !scope) return null;
    // An identifier or sender may not hold spaces, commas or restricted characters (CAP 1.2 §3.2.1).
    if (/[\s,<&]/.test(identifier) || /[\s,<&]/.test(sender)) return null;
    const infos: CapInfo[] = [];
    for (const node of childrenNamed(root, 'info')) {
        const info = parseInfo(node);
        if (!info) return null;
        infos.push(info);
    }
    return {
        identifier,
        sender,
        sent,
        status,
        msgType,
        source: childText(root, 'source'),
        scope,
        code: childrenNamed(root, 'code').map((c) => c.text).filter(Boolean),
        note: childText(root, 'note'),
        references: parseCapReferences(childText(root, 'references')),
        infos,
    };
}

/** The value of a parameter (or eventCode/geocode) by name, or null. */
export const capValue = (list: CapValue[], name: string): string | null =>
    list.find((v) => v.valueName === name)?.value ?? null;

/**
 * The info block for a reader: their language exactly ("el-GR"), else the same
 * language in another region ("el" for "el-GR"), else the issuer's first block.
 * Null only for an alert with no info (a Cancel may have none).
 */
export function pickInfo<T extends { language: string }>(infos: readonly T[], language?: string | null): T | null {
    if (infos.length === 0) return null;
    const want = (language ?? '').trim().toLowerCase();
    if (want) {
        const exact = infos.find((i) => i.language.toLowerCase() === want);
        if (exact) return exact;
        const primary = want.split(/[-_]/)[0];
        const same = infos.find((i) => i.language.toLowerCase().split(/[-_]/)[0] === primary);
        if (same) return same;
    }
    return infos[0];
}

// ── Atom ────────────────────────────────────────────────────────────────

export interface AtomLink {
    href: string;
    rel: string | null;
    type: string | null;
    title: string | null;
}

export interface AtomEntry {
    id: string | null;
    title: string | null;
    updated: string | null;
    published: string | null;
    links: AtomLink[];
    /** The entry element itself, for feeds that carry CAP elements inline (MeteoAlarm). */
    node: XmlNode;
}

export interface AtomFeed {
    id: string | null;
    updated: string | null;
    entries: AtomEntry[];
}

/** An Atom feed, or null when the document is not one. */
export function parseAtom(input: string | XmlNode): AtomFeed | null {
    const root = typeof input === 'string' ? parseXml(input) : input;
    if (!root || root.name !== 'feed') return null;
    return {
        id: childText(root, 'id'),
        updated: childText(root, 'updated'),
        entries: childrenNamed(root, 'entry').map((e) => ({
            id: childText(e, 'id'),
            title: childText(e, 'title'),
            updated: childText(e, 'updated'),
            published: childText(e, 'published'),
            links: childrenNamed(e, 'link')
                .map((l) => ({
                    href: l.attrs.href ?? '',
                    rel: l.attrs.rel ?? null,
                    type: l.attrs.type ?? null,
                    title: l.attrs.title ?? null,
                }))
                .filter((l) => l.href.length > 0),
            node: e,
        })),
    };
}
