/** GDAL's DSID CSV uses quoted fields, which may contain commas/newlines.
 * Return real values, not the ogrinfo schema's "String (10.0)" labels. */
export function dsidCsvRows(csv: string): [string[], string[]] {
    if (Buffer.byteLength(csv) > 1024 * 1024) throw Error('DSID CSV exceeds limit');
    const rows: string[][] = [];
    let row: string[] = [],
        value = '',
        quoted = false,
        closed = false;
    for (let i = 0; i < csv.length; i++) {
        const char = csv[i];
        if (char === '"') {
            if (quoted && csv[i + 1] === '"') {
                value += '"';
                i++;
            } else if (quoted) {
                quoted = false;
                closed = true;
            } else if (!value && !closed) quoted = true;
            else throw Error('Malformed DSID quoting');
        } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
            row.push(value);
            value = '';
            closed = false;
            if (char !== ',') {
                if (row.some((field) => field !== '')) rows.push(row);
                row = [];
                if (char === '\r' && csv[i + 1] === '\n') i++;
                if (rows.length === 2) break;
            }
        } else {
            if (closed) throw Error('Malformed DSID field');
            value += char;
        }
    }
    if (quoted) throw Error('Truncated DSID CSV');
    if (rows.length < 2 && (row.length || value)) {
        row.push(value);
        rows.push(row);
    }
    if (rows.length !== 2 || rows[0].length !== rows[1].length || !rows[0].length) throw Error('Missing DSID row');
    const headers = rows[0].map((field) => field.toUpperCase());
    if (new Set(headers).size !== headers.length) throw Error('Duplicate DSID headers');
    return [headers, rows[1]];
}

export function dsidDate(value: string | undefined): string | undefined {
    if (!value || !/^\d{8}$/.test(value)) return undefined;
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const parsed = Date.parse(date + 'T00:00:00Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? date : undefined;
}
export function dsidRevision(value: string | undefined): number | undefined {
    if (!value || !/^\d{1,5}$/.test(value)) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= 65535 ? number : undefined;
}
