/** Separate real-session receipts. Imported only by the exact PG17.6 fixture. */
export async function runAisReceiverRaces({
    pool,
    eq,
    binding,
    owner,
    boat,
    relay,
    key,
    token,
    admitSql,
    args,
    grantSql,
    races,
}) {
    const scalar = async (c, sql, a = []) => Object.values((await c.query(sql, a)).rows[0] ?? {})[0];
    async function client() {
        const c = await pool.connect();
        await c.query("SELECT set_config('request.jwt.claim.role','service_role',false);SET ROLE service_role");
        return c;
    }
    async function done(c) {
        try {
            await c.query('ROLLBACK;RESET ROLE');
        } finally {
            c.release();
        }
    }
    async function blocked(waiter, holder) {
        const until = Date.now() + 5000;
        do {
            if ((await scalar(pool, 'SELECT pg_blocking_pids($1)', [waiter])).includes(holder)) {
                eq(true, true, 'actual competing transaction observed blocked');
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        } while (Date.now() < until);
        throw Error('No actual competing lock wait was observed');
    }
    // A fresh explicit owner grant after the single-session cases.
    let rev = await scalar(pool, 'SELECT revision FROM private_ais_receiver.consents WHERE boat_id=$1', [boat(2)]);
    const c = await client(),
        d = await client();
    try {
        await c.query('BEGIN');
        const admitted = await scalar(c, admitSql, args(2, rev, 100, null, false));
        eq(admitted, true, 'first replica atomically admits sequence');
        const pending = scalar(d, admitSql, args(2, rev, 100, null, false));
        void pending.catch(() => {});
        await blocked(d.processID, c.processID);
        await c.query('COMMIT');
        eq(await pending, false, 'second replica cannot replay sequence');
        races.push({ name: 'same-sequence', blocked: true, loserRefused: true });
    } finally {
        await done(c);
        await done(d);
    }
    for (const retirement of ['withdrawal', 'archive', 'relay-token']) {
        if (retirement === 'archive')
            await pool.query('UPDATE public.boats SET archived_at=NULL WHERE id=$1', [boat(2)]);
        await pool.query('UPDATE public.pi_diary_relays SET token_hash=$1,enabled=true WHERE relay_id=$2', [
            token,
            relay(2),
        ]);
        rev = await scalar(pool, 'SELECT revision FROM private_ais_receiver.consents WHERE boat_id=$1', [boat(2)]);
        const g = await client();
        try {
            rev = (await scalar(g, grantSql, [owner(2), JSON.stringify(binding(2)), rev, true, key])).revision;
        } finally {
            await done(g);
        }
        const a = await pool.connect(),
            b = await client();
        try {
            await a.query('BEGIN');
            if (retirement === 'withdrawal') {
                await a.query("SELECT set_config('request.jwt.claim.role','service_role',false);SET ROLE service_role");
                await scalar(a, grantSql, [owner(2), JSON.stringify(binding(2)), rev, false, null]);
            } else if (retirement === 'archive') {
                await a.query('UPDATE public.boats SET archived_at=now() WHERE id=$1', [boat(2)]);
            } else
                await a.query('UPDATE public.pi_diary_relays SET token_hash=$1 WHERE relay_id=$2', [
                    'f'.repeat(64),
                    relay(2),
                ]);
            const pending = scalar(b, admitSql, args(2, rev, 101, null, false));
            void pending.catch(() => {});
            await blocked(b.processID, a.processID);
            await a.query('COMMIT');
            eq(await pending, false, retirement + ' wins before late batch admission');
            races.push({ name: retirement, blocked: true, loserRefused: true, deadlock: false });
        } finally {
            await done(a);
            await done(b);
        }
        await pool.query('UPDATE public.boats SET archived_at=NULL WHERE id=$1', [boat(2)]);
    }
}
