import type { ReactNode } from 'react';
export interface AtmosCredit {
    readonly key: string;
    readonly title: string;
    readonly text: string;
    readonly warning: boolean;
}
export interface AtmosPresentation {
    readonly legend: ReactNode | null;
    readonly credits: readonly AtmosCredit[];
}
