import React, { useEffect, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { readPiMarineBulletins, type PiMarineBulletin } from '../../services/PiOfflineWeatherService';
import { MARINE_BULLETIN_SOURCES } from '../../services/weather/marineBulletins';

const utc = (value: string | number): string => new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export default function MarineBulletinsSheet({
    onClose,
    point,
}: {
    onClose: () => void;
    point: { lat: number; lon: number } | null;
}): React.ReactNode {
    const [data, setData] = useState<{ bulletins: PiMarineBulletin[]; coverage: string } | null>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let cancelled = false;
        void readPiMarineBulletins().then((value) => {
            if (!cancelled) {
                setData(value);
                setLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const sources = point ? MARINE_BULLETIN_SOURCES.filter((source) => source.area(point.lat, point.lon)) : [];
    const bulletins = data?.bulletins.filter((bulletin) => sources.some((source) => source.id === bulletin.id)) ?? [];
    return (
        <ModalSheet isOpen onClose={onClose} title="Marine bulletins" zIndex="z-1200">
            <p className="text-sm text-white/70">
                Copies received by your boat. Read each product&apos;s exact area and validity. An old copy is not a
                current warning.
            </p>
            {loading && (
                <p role="status" className="mt-3 text-sm text-white/60">
                    Reading the boat&apos;s saved bulletins…
                </p>
            )}
            {!loading && !bulletins.length && (
                <p className="mt-3 text-sm text-white/70">
                    No cached official marine bulletin for this area. Australia, New Zealand and other services remain
                    available through their official websites.
                </p>
            )}
            {data?.coverage && <p className="mt-2 text-xs text-white/50">{data.coverage}</p>}
            <div className="mt-3 space-y-4">
                {bulletins.map((bulletin) => (
                    <article key={bulletin.id} className="rounded-xl border border-white/15 p-3">
                        <h4 className="text-sm font-semibold text-white">
                            {MARINE_BULLETIN_SOURCES.find((source) => source.id === bulletin.id)!.title}
                        </h4>
                        <p className="mt-1 text-xs text-white/60">
                            Issued {utc(bulletin.issuedAt)} · Received {utc(bulletin.fetchedAt)}
                        </p>
                        <p className="text-xs text-white/60">
                            Issued {Math.max(0, Math.floor((Date.now() - Date.parse(bulletin.issuedAt)) / 3_600_000))} h
                            ago · received {Math.max(0, Math.floor((Date.now() - bulletin.fetchedAt) / 3_600_000))} h
                            ago · NOAA/NWS public domain
                        </p>
                        <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-white/80">
                            {bulletin.text}
                        </pre>
                        <a
                            className="mt-2 inline-flex min-h-11 items-center text-sm text-sky-300 underline"
                            href={MARINE_BULLETIN_SOURCES.find((source) => source.id === bulletin.id)!.file}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Official source
                        </a>
                    </article>
                ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-4 text-sm text-sky-300 underline">
                <a
                    className="inline-flex min-h-11 items-center"
                    href="https://wwmiws.wmo.int/"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Worldwide official services
                </a>
                {point && point.lat < 0 && point.lon >= 110 && point.lon <= 155 && (
                    <a
                        className="inline-flex min-h-11 items-center"
                        href="https://www.bom.gov.au/marine/"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        BOM marine
                    </a>
                )}
                {point && point.lat < -28 && (point.lon >= 160 || point.lon <= -170) && (
                    <a
                        className="inline-flex min-h-11 items-center"
                        href="https://www.metservice.com/marine"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        MetService marine
                    </a>
                )}
            </div>
        </ModalSheet>
    );
}
