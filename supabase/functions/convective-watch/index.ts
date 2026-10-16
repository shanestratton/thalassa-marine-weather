import { createWeatherWatchHandler } from '../_shared/weather-watch/http.ts';
Deno.serve(createWeatherWatchHandler(['storm', 'gust'], Deno.env));
