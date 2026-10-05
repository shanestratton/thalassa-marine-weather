/**
 * Crew: your own name, mobile and age from Settings → Vessel Profile go on
 * your skipper's float plan (Shane 2026-10-04). Shared shortly after an edit,
 * never on just opening the screen, and at once if the screen closes inside
 * the wait (Settings mounts this tab only while it is open). The service does
 * nothing for an account that is not crew, and is loaded only when sharing.
 */
import { useEffect, useRef } from 'react';
import { floatPlanSelfDetails, type FloatPlanSelfDetails } from '../services/crew/floatPlanPeople';

function share(details: FloatPlanSelfDetails): void {
    void import('../services/crew/crewFloatPlanDetails')
        .then(({ shareMyFloatPlanDetails }) => shareMyFloatPlanDetails(details, { from: 'edit' }))
        .catch(() => undefined);
}

export function useShareMyFloatPlanDetailsOnEdit(
    vessel: Parameters<typeof floatPlanSelfDetails>[0],
    delayMs = 1500,
): void {
    const key = JSON.stringify(floatPlanSelfDetails(vessel));
    const openedWith = useRef(key);
    const edited = useRef(false);
    const pending = useRef<FloatPlanSelfDetails | null>(null);

    useEffect(() => {
        if (!edited.current && key === openedWith.current) return undefined;
        edited.current = true;
        const details = JSON.parse(key) as FloatPlanSelfDetails;
        pending.current = details;
        const timer = setTimeout(() => {
            pending.current = null;
            share(details);
        }, delayMs);
        return () => clearTimeout(timer);
    }, [key, delayMs]);

    useEffect(
        () => () => {
            const details = pending.current;
            pending.current = null;
            if (details) share(details);
        },
        [],
    );
}
