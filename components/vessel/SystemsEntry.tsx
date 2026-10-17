import React, { lazy, Suspense, useState } from 'react';
import { OfficeRow } from '../vesselHub/listRows';
import { SignalIcon } from '../vesselHub/icons';
const SystemsPage = lazy(() => import('./SystemsPage'));
export function SystemsEntry() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <OfficeRow
                icon={<SignalIcon color="var(--day-ui-accent, #7dd3fc)" />}
                label="Systems"
                status="Tanks, batteries & power"
                statusColor="#94a3b8"
                onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    setOpen(true);
                }}
            />
            {open && (
                <Suspense fallback={<p role="status">Opening systems...</p>}>
                    <SystemsPage onClose={() => setOpen(false)} />
                </Suspense>
            )}
        </>
    );
}
