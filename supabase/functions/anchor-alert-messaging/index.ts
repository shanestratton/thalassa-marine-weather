import { createShoreHandler } from './handler.ts';
Deno.serve(createShoreHandler(Deno.env));
