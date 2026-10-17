// Pure control parser; no imports, I/O, native decoder or configurable limits.
export function assertJsAddressSpaceLimit(text) {
    if (typeof text !== 'string' || text.length > 16384) throw new Error('Invalid proc limits text');
    const rows = text.split('\n').filter(line => line.startsWith('Max address space'));
    if (rows.length !== 1 || !/^Max address space[ \t]+17179869184[ \t]+17179869184[ \t]+bytes[ \t]*$/.test(rows[0])) {
        throw new Error('Expected exact 16GiB soft/hard address-space limit in bytes');
    }
}
