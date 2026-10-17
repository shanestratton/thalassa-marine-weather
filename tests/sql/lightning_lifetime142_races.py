"""Disposable PostgreSQL17.6 competing sessions; no provider or live DB access.

Actual migration/retirement functions execute. The upstream position transport
is explicitly synthetic, as in the canonical core fixture. No race is counted
as blocking-proven until pg_blocking_pids confirms the actual waiting backend.
"""
import json
import os
import queue
import subprocess
import threading
import time

A = '10000000-0000-4000-8000-000000000001'
B = '20000000-0000-4000-8000-000000000001'
BOAT = '30000000-0000-4000-8000-000000000001'
ENV = dict(os.environ, PGOPTIONS='-c statement_timeout=8000 -c lock_timeout=4000')
SESSIONS = []
CASES = []
BLOCKS = []


def check(value, label):
    if not value:
        raise AssertionError(label)


def query(sql):
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
                             "SET request.jwt.claim.role='service_role';" + sql],
                            text=True, capture_output=True, env=ENV, timeout=10, check=False)
    check(result.returncode == 0, result.stderr[-5000:])
    return result.stdout.strip()


class Session:
    def __init__(self, name):
        check(name.replace('-', '').isalnum(), 'fixed session name')
        self.name, self.counter, self.lines, self.errors = name, 0, queue.Queue(), []
        self.process = subprocess.Popen(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                                        text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=ENV, bufsize=1)
        SESSIONS.append(self)

        def stdout():
            for line in self.process.stdout:
                self.lines.put(line.rstrip('\r\n'))
            self.lines.put(None)

        def stderr():
            for line in self.process.stderr:
                self.errors.append(line)
        threading.Thread(target=stdout, daemon=True).start()
        threading.Thread(target=stderr, daemon=True).start()
        self.pid = int(self.execute("SET application_name='lightning142-" + name +
                                    "';SET request.jwt.claim.role='service_role';SELECT pg_backend_pid();")[-1])

    def send(self, sql):
        self.counter += 1
        marker = f'LIGHTNING142_{self.name}_{self.counter}'
        self.process.stdin.write(sql + f"\nSELECT '{marker}';\n")
        self.process.stdin.flush()
        return marker

    def receive(self, marker, seconds=5):
        deadline, output = time.monotonic() + seconds, []
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty as error:
                raise AssertionError('Session marker timed out: ' + marker) from error
            check(line is not None, 'Backend exited: ' + ''.join(self.errors)[-5000:])
            if line == marker:
                return output
            if line:
                output.append(line)
        raise AssertionError('Session marker missing: ' + marker)

    def execute(self, sql):
        return self.receive(self.send(sql))

    def close(self):
        if self.process.poll() is None:
            self.execute('ROLLBACK;')
            self.process.stdin.close()
            check(self.process.wait(timeout=3) == 0, ''.join(self.errors)[-5000:])


def reset():
    for session in SESSIONS:
        session.close()
    SESSIONS.clear()
    query('SELECT fixture.reset_watch();')


def record(name):
    CASES.append(name)
    print('PASS ' + name, flush=True)


def wait_for(sql, label, seconds=1.8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if query(sql) == 't':
            return
        time.sleep(0.02)
    raise AssertionError(label)


def blocked(waiter, holder, label):
    wait_for(f"SELECT coalesce((SELECT wait_event_type='Lock' AND {holder.pid}=ANY(pg_blocking_pids(pid)) "
             f"FROM pg_stat_activity WHERE pid={waiter.pid}),false);", label)
    BLOCKS.append({'case': label, 'waiter': waiter.pid, 'holder': holder.pid})
    print('OBSERVED_BLOCK ' + json.dumps(BLOCKS[-1]), flush=True)


def owner_config(sql_expected, enabled='false'):
    return ("SET ROLE authenticated;SET request.jwt.claim.role='authenticated';"
            f"SET request.jwt.claim.sub='{A}';"
            f"SELECT public.configure_lightning_watch('{BOAT}',{sql_expected},{enabled});")


def expect_busy_config():
    expected = query("SELECT document#>>'{}' FROM fixture.state WHERE key='expected';")
    # Assert the actual SQLSTATE; an arbitrary psql/setup failure is not a pass.
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=
                            "SET ROLE authenticated;SET request.jwt.claim.role='authenticated';"
                            f"SET request.jwt.claim.sub='{A}';"
                            f"SELECT fixture.error($q$SELECT public.configure_lightning_watch('{BOAT}','{expected}'::uuid,false)$q$,'40001','busy configuration refuses');\n",
                            text=True, capture_output=True, env=ENV, timeout=4, check=False)
    check(result.returncode == 0, result.stderr[-5000:])


def profile_wait_case(kind):
    reset()
    holder, waiter = Session('hold-' + kind), Session('claim-' + kind)
    # All sessions are connected before the short source deadline is armed.
    if kind == 'lease':
        query("UPDATE private_lightning142.attempts SET expires_at=clock_timestamp()+interval '800 milliseconds';")
        expiry = 'SELECT clock_timestamp()>=expires_at FROM private_lightning142.attempts;'
        claim = 'SELECT fixture.claim();'
    elif kind == 'position':
        query("UPDATE fixture.positions SET measured_at=clock_timestamp()-interval '119.2 seconds';"
              "UPDATE private_lightning142.attempts SET position_at=(SELECT date_trunc('milliseconds',measured_at) FROM fixture.positions);")
        expiry = "SELECT clock_timestamp()>=measured_at+interval '120 seconds' FROM fixture.positions;"
        claim = 'SELECT fixture.claim();'
    elif kind == 'rights':
        query("UPDATE private_lightning142.health SET entitlement_until=clock_timestamp()+interval '800 milliseconds';")
        expiry = 'SELECT clock_timestamp()>=entitlement_until FROM private_lightning142.health;'
        claim = 'SELECT fixture.claim();'
    elif kind == 'pulse':
        query("INSERT INTO fixture.state VALUES('pulse',to_jsonb(date_trunc('milliseconds',clock_timestamp())-interval '299.2 seconds'));")
        expiry = "SELECT clock_timestamp()>=(document#>>'{}')::timestamptz+interval '5 minutes' FROM fixture.state WHERE key='pulse';"
        claim = "SELECT fixture.claim('expiring-pulse',(SELECT (document#>>'{}')::timestamptz FROM fixture.state WHERE key='pulse'));"
    else:
        raise AssertionError(kind)
    check(query('SELECT fixture.old_current();') == 't', kind + ' authority must be current before the actual wait')
    holder.execute('BEGIN;SELECT boat_id FROM public.lightning_watch_profiles FOR UPDATE;')
    mark = waiter.send('BEGIN;' + claim)
    blocked(waiter, holder, 'post-lock-' + kind + '-expiry')
    wait_for(expiry, kind + ' source clock must actually expire')
    holder.execute('COMMIT;')
    check(waiter.receive(mark)[-1] == 'f', kind + ' must refuse after wait')
    waiter.execute('COMMIT;')
    check(query('SELECT fixture.queue_empty();') == 't', kind + ' cannot consume queue/quota')
    record('post-lock-' + kind + '-expiry')


def main():
    check(os.environ.get('THALASSA_DISPOSABLE_LIGHTNING142') == '1', 'explicit disposable mode required')
    check(os.environ.get('PGHOST') == '127.0.0.1', 'loopback only')
    check(os.environ.get('PGDATABASE') == 'lightning142_test', 'disposable database only')
    check(query('SELECT current_database();') == 'lightning142_test', 'actual DB identity')

    reset()
    first, second = Session('claim-first'), Session('claim-second')
    check(first.execute('BEGIN;SELECT fixture.claim();')[-1] == 't', 'first atomic claim')
    check(second.execute('SELECT fixture.claim();')[-1] == 'f', 'busy duplicate must hold')
    first.execute('COMMIT;')
    check(second.execute('SELECT fixture.claim();')[-1] == 'f', 'committed duplicate must hold')
    check(query('SELECT count(*)=1 FROM public.push_notification_queue;') == 't', 'exactly one queue row')
    record('competing-claims-exactly-one')

    reset()
    claimant, archive = Session('held-claim'), Session('archive-wait')
    check(claimant.execute('BEGIN;SELECT fixture.claim();')[-1] == 't', 'held claim admitted')
    mark = archive.send(f"BEGIN;UPDATE public.boats SET archived_at=clock_timestamp() WHERE id='{BOAT}';")
    blocked(archive, claimant, 'archive-waits-boat-before-owner')
    claimant.execute('COMMIT;')
    archive.receive(mark)
    archive.execute('COMMIT;')
    check(query('SELECT fixture.delivery_current();') == 'f', 'archive retires committed delivery')
    check(query("SELECT tier='off' AND boat_id IS NULL FROM private_presence.boat_presence;") == 't', 'actual presence retirement body executes')
    check(query('SELECT count(*)=0 FROM private_comfort.cohorts;') == 't', 'actual comfort retirement body executes')
    record('claim-then-archive-integrated-lock-order')

    reset()
    archive = Session('archive-held')
    archive.execute(f"BEGIN;UPDATE public.boats SET archived_at=clock_timestamp() WHERE id='{BOAT}';")
    check(query('SELECT fixture.claim();') == 'f', 'claim cannot wait behind archive with owner authority')
    check(query('SELECT public.lightning_watch_work();') == '[]', 'work skips locked actual boat')
    expect_busy_config()
    archive.execute('COMMIT;')
    query(f"UPDATE public.boats SET archived_at=NULL WHERE id='{BOAT}';")
    check(query('SELECT enabled FROM public.lightning_watch_profiles;') == 'f', 'restore cannot re-enable')
    check(query('SELECT fixture.old_current();') == 'f', 'restore cannot revive old lease')
    record('archive-first-claim-work-cas-hold')

    reset()
    configure = Session('cas-first')
    expected = query("SELECT document#>>'{}' FROM fixture.state WHERE key='expected';")
    configure.execute('BEGIN;' + owner_config("'" + expected + "'::uuid"))
    expect_busy_config()
    check(query('SELECT public.lightning_watch_work();') == '[]', 'work cannot bypass pending revision')
    configure.execute('COMMIT;')
    check(query('SELECT fixture.old_current();') == 'f', 'old lease retired by committed CAS')
    record('configuration-cas-versus-work')

    reset()
    owner = Session('owner-aba')
    owner.execute(f"BEGIN;UPDATE public.boats SET owner_id='{B}' WHERE id='{BOAT}';UPDATE public.boats SET owner_id='{A}' WHERE id='{BOAT}';")
    check(query('SELECT fixture.claim();') == 'f', 'claim cannot cross owner transition')
    owner.execute('COMMIT;')
    check(query('SELECT enabled FROM public.lightning_watch_profiles;') == 'f', 'owner ABA stays off')
    check(query('SELECT fixture.old_current();') == 'f', 'owner ABA retires lease')
    record('competing-owner-aba-retirement')

    reset()
    deletion = Session('deletion-owner')
    deletion.execute(f"BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('{A}',20260806));INSERT INTO public.account_deletion_jobs VALUES('{A}');")
    check(query('SELECT fixture.claim();') == 'f', 'claim refuses busy deleting authority')
    check(query('SELECT public.lightning_watch_work();') == '[]', 'work refuses busy deleting authority')
    expect_busy_config()
    # The canonical account fence blocks on this same owner authority. The
    # earlier admission trigger must refuse first, even on metadata/no-op
    # updates, instead of holding the boat while waiting for account deletion.
    for assignment in ["name='Changed metadata'", 'archived_at=archived_at']:
        query(f"SELECT fixture.error($q$UPDATE public.boats SET {assignment} WHERE id='{BOAT}'$q$,'40001','boat write refuses busy deleting authority');")
    deletion.execute(f"DELETE FROM auth.users WHERE id='{A}';COMMIT;")
    check(query('SELECT count(*)=0 FROM public.lightning_watch_profiles;') == 't', 'actual cascade retires profile')
    record('owner-deletion-versus-claim-work-cas-metadata-noop')

    for kind in ['lease', 'position', 'rights', 'pulse']:
        profile_wait_case(kind)

    reset()
    clock = Session('queue-clock')
    rows = clock.execute("BEGIN;SELECT pg_sleep(0.15);SELECT fixture.claim();SELECT extract(epoch FROM created_at-transaction_timestamp())>0.1 FROM public.push_notification_queue;")
    check(rows[-2:] == ['t', 't'], 'queue creation uses actual admission clock, not transaction start')
    clock.execute('COMMIT;')
    record('actual-queue-created-clock')
    check(len(CASES) == 11 and len(BLOCKS) == 5, 'fixed complete race inventory')
    print(json.dumps({'schema': 1, 'cases': CASES, 'observedBlocking': BLOCKS, 'failures': 0,
                      'skips': 0, 'positionTransport': 'synthetic', 'production': False,
                      'providerRequests': 0, 'pushDelivery': False}), flush=True)
    print('LIGHTNING142_LIFETIME_RACES_PASSED', flush=True)


try:
    main()
finally:
    for session in SESSIONS:
        try:
            session.close()
        except Exception:
            if session.process.poll() is None:
                session.process.kill()
                session.process.wait(timeout=3)
