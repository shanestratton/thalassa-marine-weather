/** Chart content identity, independent of cloud manifests and import timestamps. */
export interface EncCellContentIdentityInput {
    id: string;
    edition?: number;
    issued?: string;
    sizeBytes?: number;
    updateNumber?: number;
    contentSha256?: string;
}

export function encCellContentIdentity(cell: EncCellContentIdentityInput): string {
    // Keep legacy persisted route fingerprints valid until chart content changes
    // or stronger revision metadata becomes available for that cell.
    const legacy = `${cell.id}@${cell.edition ?? 'unknown'}@${cell.issued ?? ''}@${cell.sizeBytes ?? 'unknown'}`;
    const update = cell.updateNumber === undefined ? '' : `@update-${cell.updateNumber}`;
    const content = cell.contentSha256 === undefined ? '' : `@sha256-${cell.contentSha256}`;
    return `${legacy}${update}${content}`;
}
