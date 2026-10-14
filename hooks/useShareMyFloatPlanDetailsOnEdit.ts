/**
 * Crew: your own name, mobile and age from Settings → Vessel Profile go on
 * your skipper's float plan (Shane 2026-10-04). Shared shortly after an edit,
 * never on just opening the screen, and at once if the screen closes inside
 * the wait (Settings mounts this tab only while it is open). The service does
 * nothing for an account that is not crew, and is loaded only when sharing.
 *
 * Your date of birth too since 129-14. Clearing one this screen had (opened
 * with, or entered here) clears the shared one; an edit on a device that
 * never had one leaves another device's alone.
 */
import { useEffect, useRef } from 'react';
import { floatPlanSelfDetails, type FloatPlanSelfDetails } from '../services/crew/floatPlanPeople';

function share(details: FloatPlanSelfDetails, clearDateOfBirth: boolean): void {
    void import('../services/crew/crewFloatPlanDetails')
        .then(({ shareMyFloatPlanDetails }) =>
            shareMyFloatPlanDetails(details, { from: 'edit', ...(clearDateOfBirth ? { clearDateOfBirth } : {}) }),
        )
        .catch(() => undefined);
}

export function useShareMyFloatPlanDetailsOnEdit(
    vessel: Parameters<typeof floatPlanSelfDetails>[0],
    delayMs = 1500,
): void {
    const key = JSON.stringify(floatPlanSelfDetails(vessel));
    const openedWith = useRef(key);
    const edited = useRef(false);
    const pending = useRef<{ details: FloatPlanSelfDetails; clearDateOfBirth: boolean } | null>(null);
    const hadDateOfBirth = useRef(false);

    useEffect(() => {
        const details = JSON.parse(key) as FloatPlanSelfDetails;
        const clearDateOfBirth = hadDateOfBirth.current && !details.dateOfBirth;
        if (details.dateOfBirth) hadDateOfBirth.current = true;
        if (!edited.current && key === openedWith.current) return undefined;
        edited.current = true;
        pending.current = { details, clearDateOfBirth };
        const timer = setTimeout(() => {
            pending.current = null;
            share(details, clearDateOfBirth);
        }, delayMs);
        return () => clearTimeout(timer);
    }, [key, delayMs]);

    useEffect(
        () => () => {
            const last = pending.current;
            pending.current = null;
            if (last) share(last.details, last.clearDateOfBirth);
        },
        [],
    );
}
