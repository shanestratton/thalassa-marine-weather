# Exact JSX display templates

The source hook shares 40–4096 character compiler-cooked static template values
and quasis from JSX children and eight display attributes: `className`, `title`,
`label`, `description`, `placeholder`, `aria-label`, `aria-description`, `alt`.
It precedes JSX lowering; the existing literal/CSS post-transform is unchanged.
Inserted values are immutable primitive strings. Original template expressions,
their coercion/exception order, JSX properties, handlers and geometry stay put.
Identifier reservation uses normalized TypeScript identifiers as well as raw
source, so escaped declarations and free references cannot be captured.

The nearest JSX sink must qualify before any intervening call, constructor or
standalone object property. A call can interpret ordinary prose as a prompt or
program, regardless of its name. Dynamic expression calls are retained; nested
JSX inside an outer `map` still finds its own sink. Tags, scripts, styles,
event/asset attributes, imports, URL/Worker/glob trees, program/protocol-looking
values, ChatPage, bootstrap, services and worker modules remain untouched.
Worker builds explicitly disable the new hook.

Collection first performs the previous exact four-pool selection. It retains
every one of those values, excludes the existing class/SVG values, and adds the
qualified template values. Deterministic grouping by trimmed first token then
lexical value improves compression; it never trims or changes the stored text.
Each prefix must pass the existing compact packer. If four pools cannot retain
the complete cohort the build fails, rather than dropping old values.

There are still four UI tables and the same decoder/tuple grammar: 128,000 raw
bytes, 64,000 encoded bytes, 4,096 entries per table, 16,384 entries and 960,000
restored code units across the four pools. Class, SVG and authored-prose tables
and their limits are unchanged. The existing inert HTML mechanism owns each
content-derived table identity during normal Vite hashing; there is no changed
chunk under an old hash, new codec, network request or runtime source evaluation.

The read-only source estimate against configured source `095422182f35` was
26,322 fewer counted JavaScript bytes after conservative reference/index costs.
The narrower call boundary then leaves one former `header(...)` occurrence
verbatim. This estimate is not a production budget pass; the exact configured
build, worker/MPA fences and release/browser gates remain required.

Tests retain the complete previous 10,559-value UI cohort and the original
legacy UI/SVG cohort, restore every bounded table through the unchanged decoder,
and retain checksum/schema/expansion refusals. New cases cover cooked Unicode,
source boundaries, context exclusions, source-cache identity, identifier escapes,
minified property/handler/coercion/exception behavior and a real separate Vite
worker without UI tables or DOM/decoder imports. Earlier broad-call and raw-name
prototypes and their passing preliminary suites remain historical evidence;
only the reviewed conservative source qualifies the final proof.
