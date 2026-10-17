import React, { type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { openLocalChartDisplay } from '../../services/charts/localChartDisplay';
import { subscribeLocalChartLibrary } from '../../services/charts/localChartLibrary';
import type { AtmosCredit } from './atmosPresentation';
import { mountLocalChartPresentation, type LocalChartPresentationStatus } from './localChartPresentation';
import LocalChartLibrarySheet from './LocalChartLibrarySheet';
import { chartFitBearing } from './chartOrientation';

export default function LocalChartLibrarySurface({
    mapRef,
    mapReady,
    open,
    onClose,
    clearRevision,
    onCredit,
    onActive,
}: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    open: boolean;
    onClose(): void;
    clearRevision: number;
    onCredit(credit: AtmosCredit | null): void;
    onActive(active: boolean): void;
}) {
    const [id, setId] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<LocalChartPresentationStatus>('off');
    const [error, setError] = React.useState('');
    const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
    const owner = React.useRef<ReturnType<typeof mountLocalChartPresentation> | null>(null);
    const pending = React.useRef<AbortController | null>(null);
    const stop = React.useCallback(() => {
        pending.current?.abort();
        owner.current?.retire();
        setError('');
        if (!owner.current || owner.current.done()) setStatus('off');
        setId(null);
    }, []);
    React.useEffect(() => {
        const auth = subscribeAuthIdentityScope(() => {
            stop();
            onClose();
        });
        const storage = subscribeLocalChartLibrary(() => {
            owner.current?.verify();
            refresh();
        });
        return () => {
            auth();
            storage();
        };
    }, [onClose, stop]);
    React.useEffect(() => {
        stop();
    }, [clearRevision, stop]);
    React.useEffect(() => {
        const map = mapRef.current;
        if (!id || !mapReady || !map) return;
        owner.current?.retire();
        if (owner.current && !owner.current.done()) {
            setError('The previous local chart could not be cleared. Reopen Obs before displaying another.');
            return;
        }
        const controller = new AbortController();
        pending.current = controller;
        let live = true;
        setStatus('loading');
        setError('');
        void openLocalChartDisplay(id, { signal: controller.signal, isCurrent: () => live && mapRef.current === map })
            .then((display) => {
                if (!live || controller.signal.aborted || !display.isCurrent() || mapRef.current !== map) {
                    display.release();
                    return;
                }
                const presentation = mountLocalChartPresentation(
                    map,
                    display,
                    () => live && !controller.signal.aborted && mapRef.current === map,
                    (next) => {
                        if (live) setStatus(next);
                        onCredit(
                            next === 'off'
                                ? null
                                : {
                                      key: 'local-chart',
                                      title: 'Private local chart',
                                      warning: next !== 'displayed',
                                      text:
                                          next === 'stuck-visible'
                                              ? 'A private local chart may still be visible; removal is unverified. Do not rely on it.'
                                              : display.note,
                                  },
                        );
                    },
                );
                owner.current = presentation;
                if (display.bounds && !controller.signal.aborted && display.isCurrent()) {
                    const [west, south, east, north] = display.bounds;
                    map.fitBounds(
                        [
                            [west, south],
                            [east, north],
                        ],
                        { padding: 40, duration: 500, retainPadding: false, bearing: chartFitBearing(map) },
                    );
                }
            })
            .catch((reason: unknown) => {
                if (live && !controller.signal.aborted) {
                    setStatus('unavailable');
                    setError(reason instanceof Error ? reason.message : 'Local chart unavailable.');
                }
            });
        return () => {
            live = false;
            controller.abort();
            owner.current?.retire();
        };
    }, [id, mapReady, mapRef, onCredit]);
    React.useEffect(() => {
        // A remove request invalidates its source proof synchronously. The
        // presentation's clock/auth checks retire it without opening any file.
        if (revision && owner.current?.done()) setId(null);
    }, [revision]);
    React.useEffect(() => {
        onActive(id !== null);
    }, [id, onActive]);
    return open ? (
        <LocalChartLibrarySheet
            onClose={onClose}
            activeId={id}
            onDisplay={setId}
            onStop={stop}
            status={
                error ||
                (status === 'displayed'
                    ? 'Overlay displayed. Coverage and chart currency remain unverified.'
                    : status === 'loading'
                      ? 'Opening selected chart…'
                      : status === 'unavailable'
                        ? 'This chart could not be displayed. Close the chart and check its format or try again.'
                        : status === 'stuck-visible'
                          ? 'The previous local chart may still be visible. Reopen Obs to clear it.'
                          : '')
            }
        />
    ) : null;
}
