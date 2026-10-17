/** One aggregate selected-field allowance; a read never evicts map/chart RAM. */
export const RETAINED_AREA_FIELD_BYTES = 4 * 1024 * 1024;
let heldBytes = 0;
export function retainedAreaFieldBytes(): number {
    return heldBytes;
}
export function reserveRetainedAreaField() {
    let bytes = 0,
        active = true;
    return {
        resize(next: number): void {
            if (
                !active ||
                !Number.isSafeInteger(next) ||
                next < 0 ||
                heldBytes - bytes + next > RETAINED_AREA_FIELD_BYTES
            )
                throw Error('Selected chart-area RAM budget is unavailable.');
            heldBytes += next - bytes;
            bytes = next;
        },
        release(): void {
            if (active) {
                active = false;
                heldBytes -= bytes;
                bytes = 0;
            }
        },
    };
}
