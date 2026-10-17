/** Transport adapters for the actual-index proof. This file is never imported by production. */
export const proof = {
    handler: undefined as undefined | ((request: Request) => Promise<Response>),
    record: {} as Record<string, unknown>,
    tokens: [] as Array<{ id: string; device_token: string; platform: string }>,
    events: [] as string[],
    current: true as boolean | null,
    currentChecks: [] as Array<boolean | null>,
    attempt: true as boolean | null,
    initiated: 0,
    updates: [] as Array<Record<string, unknown>>,
};

export function serve(handler: (request: Request) => Promise<Response>) {
    proof.handler = handler;
}

export function registeredHandler() {
    if (!proof.handler) throw Error('Actual handler did not register');
    return proof.handler;
}

export function encode(input: Uint8Array | ArrayBuffer | string) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function createClient(url: string, key: string) {
    if (url !== 'https://fixture.invalid' || key !== 'fixture-service-role') throw Error('Synthetic database required');
    return {
        rpc(name: string) {
            proof.events.push(name);
            if (name === 'claim_push_notification') return Promise.resolve({ data: proof.record, error: null });
            if (name === 'overdue_owner_current') return Promise.resolve({ data: proof.current, error: null });
            if (name === 'lightning_watch_delivery_current') {
                return Promise.resolve({
                    data: proof.currentChecks.length ? proof.currentChecks.shift() : proof.current,
                    error: null,
                });
            }
            if (name === 'overdue_owner_attempt') {
                if (proof.attempt === true) proof.initiated ||= 1;
                return Promise.resolve({ data: proof.attempt, error: null });
            }
            throw Error('Unexpected database RPC');
        },
        from(table: string) {
            if (!['push_device_tokens', 'push_notification_queue'].includes(table)) throw Error('Unexpected table');
            let update = false;
            const query = {
                select() {
                    proof.events.push(table === 'push_device_tokens' ? 'token-lookup' : 'badge-lookup');
                    return query;
                },
                update(value: Record<string, unknown>) {
                    update = true;
                    proof.updates.push(value);
                    return query;
                },
                delete() {
                    update = true;
                    return query;
                },
                eq() {
                    return query;
                },
                is() {
                    return query;
                },
                not() {
                    return query;
                },
                then(resolve: (value: { data: typeof proof.tokens | null; error: null; count: number }) => unknown) {
                    return Promise.resolve(
                        resolve({
                            data: table === 'push_device_tokens' && !update ? proof.tokens : null,
                            error: null,
                            count: 0,
                        }),
                    );
                },
            };
            return query;
        },
    };
}
