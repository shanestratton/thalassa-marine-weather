/** Test-database metadata only; accepts one explicit coordinator and 16 PIDs. */
export async function countBlockedReplanBackends(client, pids) {
    if (
        !Array.isArray(pids) ||
        pids.length !== 16 ||
        new Set(pids).size !== 16 ||
        !pids.every((n) => Number.isInteger(n) && n > 0)
    )
        throw Error('Sixteen distinct actual backend PIDs are required');
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query(
        "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND state='active' AND wait_event_type='Lock'",
        [pids],
    );
    const count = result.rows[0]?.blocked;
    if (!Number.isInteger(count) || count < 0 || count > 16) throw Error('Invalid actual backend lock observation');
    return count;
}
