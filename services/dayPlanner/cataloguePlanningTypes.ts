import type { CatalogueCheckpoint, CatalogueDetail, CatalogueVersionRef } from './catalogue';

/** A deliberate exact-version choice, never an instruction to pick the latest. */
export interface CataloguePlanSelection extends CatalogueVersionRef {
    outbound?: CatalogueVersionRef;
    return?: CatalogueVersionRef;
}

export interface CatalogueRouteConstraint {
    variant: CatalogueVersionRef;
    direction: 'outbound' | 'return';
    checkpoints: CatalogueCheckpoint[];
}

/** Detached public evidence captured before calculation and re-read before save. */
export interface CataloguePlanBinding {
    mode: 'return' | 'overnight';
    selection: CataloguePlanSelection;
    details: CatalogueDetail[];
    outbound?: CatalogueRouteConstraint;
    return?: CatalogueRouteConstraint;
}
