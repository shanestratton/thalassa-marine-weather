/** Visit every closed grid cell touched by a segment, including both sides of
 * grid edges and all four cells at a corner. Coordinates use grid edges (cell
 * centres are x + 0.5, y + 0.5). No sampling interval can skip a thin crossing. */
export function visitGridSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    visit: (x: number, y: number, t: number) => boolean,
    maxVisits = 20_000,
): boolean {
    if (![ax, ay, bx, by, maxVisits].every(Number.isFinite) || maxVisits < 1) return false;
    const dx = bx - ax;
    const dy = by - ay;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    let visits = 0;
    const emit = (x: number, y: number, t: number) => ++visits <= maxVisits && visit(x, y, t);
    const onEdge = (value: number) => Math.abs(value - Math.round(value)) <= 1e-10;
    const point = (x: number, y: number, t: number): boolean => {
        const edgeX = onEdge(x);
        const edgeY = onEdge(y);
        const cx = edgeX ? Math.round(x) : Math.floor(x);
        const cy = edgeY ? Math.round(y) : Math.floor(y);
        return (
            emit(cx, cy, t) &&
            (!edgeX || emit(cx - 1, cy, t)) &&
            (!edgeY || emit(cx, cy - 1, t)) &&
            (!edgeX || !edgeY || emit(cx - 1, cy - 1, t))
        );
    };
    if (!point(ax, ay, 0)) return false;
    if (dx === 0 && dy === 0) return true;

    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    let x = Math.floor(ax) - (dx < 0 && Number.isInteger(ax) ? 1 : 0);
    let y = Math.floor(ay) - (dy < 0 && Number.isInteger(ay) ? 1 : 0);
    let nextX = dx > 0 ? (x + 1 - ax) / dx : dx < 0 ? (x - ax) / dx : Infinity;
    let nextY = dy > 0 ? (y + 1 - ay) / dy : dy < 0 ? (y - ay) / dy : Infinity;
    const deltaX = dx === 0 ? Infinity : 1 / Math.abs(dx);
    const deltaY = dy === 0 ? Infinity : 1 / Math.abs(dy);
    let previous = 0;
    while (previous < 1) {
        const next = Math.min(1, nextX, nextY);
        if (!Number.isFinite(next) || next < previous) return false;
        const middle = (previous + next) / 2;
        if (!emit(x, y, middle)) return false;
        // A segment along a grid edge touches the cells on both sides for its
        // entire length, not just at its endpoint/intersection events.
        if (dx === 0 && onEdge(ax) && !emit(x - 1, y, middle)) return false;
        if (dy === 0 && onEdge(ay) && !emit(x, y - 1, middle)) return false;
        if (!point(ax + dx * next, ay + dy * next, next)) return false;
        if (next === 1) return true;
        // Do not merge merely near-simultaneous events: even a tiny interval
        // between them can pass through a blocked corner cell.
        const crossX = nextX <= next;
        const crossY = nextY <= next;
        if (!crossX && !crossY) return false;
        if (crossX) {
            x += stepX;
            nextX += deltaX;
        }
        if (crossY) {
            y += stepY;
            nextY += deltaY;
        }
        previous = next;
    }
    return false;
}
