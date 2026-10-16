/** Called only after the strict disposable 17.6 adapter and 79 ACL/state checks. */
export async function runOverduePostgresCases({ db, scalar, service, cfg, configuration, owner, revision, eq, race }) {
    if (
        process.env.THALASSA_DISPOSABLE_OVERDUE_TEST !== '1' ||
        (await scalar('SELECT current_database()')) !== 'overdue137_test'
    )
        throw new Error('Disposable fixture required');
    const run = async (c, sql, args = []) => Object.values((await c.query(sql, args)).rows[0] ?? {})[0];
    await db.exec(
        `UPDATE private_overdue.control SET enabled=true,function_version=1,delivery_version=1,worker_at=now(),entitlement_until=now()+interval '1 day';UPDATE private_shore.control SET worker_at=now();UPDATE cron.job SET active=true;DELETE FROM public.overdue_watches;DELETE FROM private_overdue.quotas;DELETE FROM private_overdue.global_quotas;UPDATE private_shore.quotas SET deliveries=0;`,
    );
    const candidates = [];
    for (let i = 0; i < 16; i++) {
        const b = `80000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            cid = `90000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        await db.query('INSERT INTO public.boats VALUES($1,$2,NULL)', [b, owner]);
        await db.query(
            "INSERT INTO private_shore.contacts(id,owner_id,boat_id,revision,configuration,consent,consented_at,invite_policy_version) VALUES($1,$2,$3,$4,$5::jsonb,'confirmed',now(),2)",
            [cid, owner, b, revision, JSON.stringify(configuration({ enabled: true, allowOverdue: true }))],
        );
        candidates.push({ boat: b, cfg: { ...cfg(), enabled: true, contacts: [{ id: cid, revision }] } });
    }
    const ownerLock = "SELECT pg_advisory_xact_lock(hashtextextended('overdue:'||$1::text,0))";
    const slots = await race('overdue-owner-slots', 16, 'authenticated', owner, ownerLock, [owner], (c, i) =>
        run(c, 'SELECT public.configure_overdue_watch($1,NULL,$2::jsonb)', [
            candidates[i].boat,
            JSON.stringify(candidates[i].cfg),
        ]),
    );
    eq(
        slots.filter((r) => r.status === 'fulfilled').length,
        5,
        '16 concurrent owner configurations admit exact five active watches',
    );
    eq(
        slots.filter((r) => r.status === 'rejected' && r.reason.code === '54000').length,
        11,
        'remaining concurrent owner configurations receive quota refusal',
    );
    const selected = await scalar(
        "SELECT boat_id FROM public.overdue_watches WHERE configuration->'enabled'='true'::jsonb ORDER BY boat_id LIMIT 1",
    );
    const w = (await db.query('SELECT revision,configuration FROM public.overdue_watches WHERE boat_id=$1', [selected]))
        .rows[0];
    const edits = await race('overdue-configuration-CAS', 2, 'authenticated', owner, ownerLock, [owner], (c) =>
        run(c, 'SELECT public.configure_overdue_watch($1,$2,$3::jsonb)', [
            selected,
            w.revision,
            JSON.stringify({ ...w.configuration, enabled: true }),
        ]),
    );
    eq(edits.filter((r) => r.status === 'fulfilled').length, 1, 'same-revision competing writes have one winner');
    eq(
        edits.filter((r) => r.status === 'rejected' && r.reason.code === '40001').length,
        1,
        'CAS loser cannot adopt replacement plan',
    );
    await db.query(
        "UPDATE public.overdue_watches SET configuration=jsonb_set(configuration,'{plan,overdueAt}',to_jsonb(floor(extract(epoch FROM now()-interval '1 second')*1000))) WHERE boat_id=$1",
        [selected],
    );
    await service('SELECT public.overdue_watch_work(NULL)');
    const ownerQueue = await scalar('SELECT queue_id FROM private_overdue.owner_deliveries WHERE boat_id=$1', [
        selected,
    ]);
    const attempts = await race(
        'owner-http-attempt',
        16,
        'service_role',
        null,
        'SELECT boat_id FROM public.overdue_watches WHERE boat_id=$1 FOR UPDATE',
        [selected],
        (c) => run(c, 'SELECT public.overdue_owner_attempt($1)', [ownerQueue]),
    );
    eq(
        attempts.filter((r) => r.status === 'fulfilled' && r.value === true).length,
        16,
        'parallel actual-device attempt gates refer to one incident',
    );
    eq(
        await scalar('SELECT owner_attempted_at IS NOT NULL FROM public.overdue_watches WHERE boat_id=$1', [selected]),
        true,
        'one original incident attempt timestamp',
    );
    await db.query(
        "UPDATE public.overdue_watches SET owner_queued_at=now()-interval '12 minutes',owner_attempted_at=now()-interval '11 minutes',configuration=jsonb_set(configuration,'{plan,overdueAt}',to_jsonb(floor(extract(epoch FROM now()-interval '13 minutes')*1000))) WHERE boat_id=$1",
        [selected],
    );
    await service('SELECT public.overdue_watch_work(NULL)');
    const claims = await race(
        'overdue-contact-claim',
        16,
        'service_role',
        null,
        'SELECT boat_id FROM public.overdue_watches WHERE boat_id=$1 FOR UPDATE',
        [selected],
        (c) => run(c, 'SELECT public.overdue_contact_claim()'),
    );
    const won = claims.filter((r) => r.status === 'fulfilled' && r.value?.id);
    eq(won.length, 1, '16 parallel claims consume only one delivery/quota slot');
    const d = won[0].value;
    eq(
        await scalar('SELECT attempts FROM private_overdue.contact_deliveries WHERE id=$1', [d.id]),
        1,
        'attempt counter increments once',
    );
    const guards = await race(
        'overdue-provider-attempt',
        16,
        'service_role',
        null,
        'SELECT boat_id FROM public.overdue_watches WHERE boat_id=$1 FOR UPDATE',
        [selected],
        (c) => run(c, 'SELECT public.overdue_contact_guard($1,$2,$3)', [d.id, d.revision, d.contactRevision]),
    );
    eq(
        guards.filter((r) => r.status === 'fulfilled' && r.value === true).length,
        1,
        'only one last provider guard consumes claim',
    );
    eq(
        guards.filter((r) => r.status === 'fulfilled' && r.value === false).length,
        15,
        'other provider contenders explicitly refuse',
    );
}
