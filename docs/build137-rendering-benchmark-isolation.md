# Serial rendering benchmark controls

The four route-worker rendering/timing cases now use the existing `@pixel`
selector. All eight Chrome/WebKit cases run in the required single-worker
rendering job, alongside the wind pixel cases, and are excluded from the
parallel keyboard shards. No case, limit, assertion or negative control is
removed. The existing source-pinned validation workflow already runs both
selectors and needs no authority or matrix change.

The prior full run38968496629 measured one WebKit heartbeat gap of252 ms
against the unchanged250 ms CI limit. Its retry measured91 ms; the intentional
main-thread fallback froze for8,003 ms. These observations do not establish
the operating-system cause. Running the graphics and frame timing controls
without a concurrent software-WebGL browser gives the benchmark an explicit
isolation condition while retaining the same regression threshold.

Actual UI responsiveness, click delay, frame count, Stop latency, satellite
decoder parity and worker-versus-fallback route equality remain required.
Release still requires this job and every other full validation job to pass
on the exact final source.
