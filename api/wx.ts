/**
 * /api/wx — weather + server portal.
 *
 * Top half: a consumer-style weather page for nine locations — hourly chart
 * (temp/precip/wind/pressure), 10-day strip, current-conditions tiles, and
 * Blue Book tide events for the QLD spots. Bottom half: the server monitor.
 *
 * All data is PUSHED by the outbound-only server (wx-forecast every 30 min,
 * wx-metrics every 2 min) to public storage; this page renders whatever was
 * last pushed and turns red when the metrics snapshot goes silent.
 *
 * HONESTY RULES BAKED INTO THE RENDER, deliberately:
 *  - The forecast is ONE model (DWD ICON) and says so, linking /api/spread —
 *    models disagreed 2.3x on Newport wind the day this was built.
 *  - Tide events are labelled with their GAUGE (Scarborough is not "Newport"),
 *    marked astronomical/LAT, and called HIGH/LOW — never slack.
 *  - All times are the LOCATION's local time, rendered from the ISO strings
 *    the server produced. Date() is never used on them: parsing local-naive
 *    strings through the browser's timezone is how Venice ends up ten hours
 *    wrong on a Brisbane phone.
 */
export const config = { runtime: 'edge' };

const BASE = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/weather/status';
const STORAGE_FETCH_TIMEOUT_MS = 8_000;
const STORAGE_OBJECT_LIMITS = {
    current: 512 * 1024,
    history: 2 * 1024 * 1024,
    forecast: 12 * 1024 * 1024,
    report: 1024 * 1024,
} as const;

const COMMON_SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'strict-transport-security': 'max-age=31536000',
} as const;

function createCspNonce(): string {
    return crypto.randomUUID().replaceAll('-', '');
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.toLowerCase().includes('json')) {
        throw new Error('Weather storage returned a non-JSON response');
    }

    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        if (Number.isFinite(bytes) && bytes > maxBytes) {
            throw new Error('Weather storage response exceeded its size limit');
        }
    }
    if (!response.body) throw new Error('Weather storage returned an empty response');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel('response too large');
                throw new Error('Weather storage response exceeded its size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

async function fetchStorageJson<T>(path: string, maxBytes: number, fallback: T): Promise<T> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), STORAGE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(`${BASE}/${path}`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
            cache: 'no-store',
        });
        if (!response.ok) return fallback;
        return (await readBoundedJson(response, maxBytes)) as T;
    } catch {
        return fallback;
    } finally {
        clearTimeout(deadline);
    }
}

export function weatherPortalContentSecurityPolicy(nonce: string): string {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "script-src-attr 'none'",
        `style-src-elem 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        'upgrade-insecure-requests',
    ].join('; ');
}

export function renderWeatherPortalPage(nonce: string): string {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('Invalid CSP nonce');
    return PAGE_TEMPLATE.replaceAll('__WX_CSP_NONCE__', nonce);
}

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response(null, {
            status: 405,
            headers: { ...COMMON_SECURITY_HEADERS, allow: 'GET, HEAD', 'cache-control': 'no-store' },
        });
    }
    const url = new URL(req.url);
    if (url.searchParams.has('data')) {
        const responseHeaders = {
            ...COMMON_SECURITY_HEADERS,
            'content-type': 'application/json',
            'cache-control': 'no-store',
        };
        if (req.method === 'HEAD') {
            return new Response(null, { headers: responseHeaders });
        }

        const bust = `?t=${Math.floor(Date.now() / 30000)}`;
        const [c, h, f, rp] = await Promise.all([
            fetchStorageJson(`current.json${bust}`, STORAGE_OBJECT_LIMITS.current, null),
            fetchStorageJson<unknown[]>(`history.json${bust}`, STORAGE_OBJECT_LIMITS.history, []),
            fetchStorageJson(`forecast.json${bust}`, STORAGE_OBJECT_LIMITS.forecast, null),
            fetchStorageJson(`report.json${bust}`, STORAGE_OBJECT_LIMITS.report, null),
        ]);
        return new Response(JSON.stringify({ current: c, history: h, forecast: f, report: rp }), {
            headers: responseHeaders,
        });
    }
    const nonce = createCspNonce();
    return new Response(req.method === 'HEAD' ? null : renderWeatherPortalPage(nonce), {
        headers: {
            ...COMMON_SECURITY_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300',
            'content-security-policy': weatherPortalContentSecurityPolicy(nonce),
        },
    });
}

const PAGE_TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>wx — weather & server</title>
<style nonce="__WX_CSP_NONCE__">
:root{--paper:#F4F6F2;--ink:#12201A;--dim:#5A6B62;--rule:#D5DED6;--panel:#FFF;
--ok:#0E7C55;--warn:#C4703A;--bad:#A33A2B;--curve:#E0A83C;--rain:#3E6E8E}
@media(prefers-color-scheme:dark){:root{--paper:#0B1410;--ink:#DCE8E0;--dim:#7C8F85;
--rule:#1E2E27;--panel:#101C17;--ok:#4FBE8B;--warn:#D98A4E;--bad:#D4614F;
--curve:#E8BC63;--rain:#6FA3C4}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:14px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;
font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:26px 18px 60px}
h1{font-family:Georgia,serif;font-weight:400;font-size:30px;margin:0 0 2px;letter-spacing:-.02em}
h1 em{font-style:italic;color:var(--ok)}
h2{font-family:Georgia,serif;font-weight:400;font-size:21px;margin:34px 0 10px;
border-top:2px solid var(--ink);padding-top:14px}
.sub{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
#banner{display:none;margin:14px 0;padding:11px 15px;border:2px solid var(--bad);
color:var(--bad);font-weight:600}
#banner.on{display:block}
.picker{display:flex;flex-wrap:wrap;gap:7px;margin:16px 0 14px}
.loc{padding:5px 13px;border:1px solid var(--rule);background:var(--panel);
color:var(--ink);cursor:pointer;font:inherit;font-size:12.5px}
.loc.sel{border-color:var(--ok);color:var(--ok);font-weight:600}
.panel{background:var(--panel);border:1px solid var(--rule);padding:14px 16px;margin-bottom:12px}
.panel h3{margin:0 0 8px;font-size:10.5px;color:var(--dim);
text-transform:uppercase;letter-spacing:.08em;font-weight:500}
.chips{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}
.chip{padding:3px 11px;border:1px solid var(--rule);background:none;color:var(--dim);
cursor:pointer;font:inherit;font-size:11.5px}
.chip.sel{border-color:var(--ok);color:var(--ok)}
#hourly{width:100%;height:190px;display:block}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:9px}
.tile .k{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em}
.tile .v{font-size:21px;margin-top:1px}
.tile .u{font-size:11px;color:var(--dim)}
.tile{background:var(--panel);border:1px solid var(--rule);padding:10px 12px}
.daily{display:flex;overflow-x:auto;gap:4px}
.day{min-width:74px;flex:1;text-align:center;padding:8px 2px;border:1px solid var(--rule);
background:var(--panel)}
.day .dow{font-size:11px;color:var(--dim)}
.day .ico{font-size:21px;margin:3px 0}
.day .hi{font-size:15px}.day .lo{font-size:12px;color:var(--dim)}
.day .pr{font-size:10.5px;color:var(--rain);min-height:14px}
.tideband{display:flex;flex-wrap:wrap;gap:8px}
.tide{border:1px solid var(--rule);background:var(--panel);padding:7px 12px;text-align:center}
.tide .tt{font-size:15px}
.tide .th{font-size:12px;color:var(--dim)}
.tide.hw .th b{color:var(--ok)}.tide.lw .th b{color:var(--rain)}
.note{color:var(--dim);font-size:11px;line-height:1.6;margin-top:9px}
/* Chart key. The shading and the dashed line were unexplained marks — a reader
   had to guess that grey meant night and that the dotted trace was gusts. */
.hkey{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:6px}
.hkey i{display:inline-block;vertical-align:middle;margin-right:5px}
.hkey .sw-night{width:13px;height:11px;background:var(--rule);opacity:.55;border-radius:2px}
.hkey .sw-band{width:13px;height:11px;border-radius:2px}
.hkey .sw-dash{width:16px;height:0;border-top:1.6px dashed;opacity:.9}
.hkey .sw-line{width:16px;height:0;border-top:2px solid}
.hkey .sw-bar{width:4px;height:11px;border-radius:1px}
.row{display:flex;flex-wrap:wrap;gap:9px;margin:14px 0}
.pill{padding:4px 12px;border:1px solid currentColor;font-size:11px;
text-transform:uppercase;letter-spacing:.06em}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px;margin-top:14px}
.chart{background:var(--panel);border:1px solid var(--rule);padding:11px 13px 5px}
canvas.spark{width:100%;height:58px;display:block}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}
th{text-align:left;color:var(--dim);font-size:10px;text-transform:uppercase;
letter-spacing:.08em;padding:0 8px 6px 0;border-bottom:1px solid var(--rule);font-weight:500}
td{padding:5px 8px 5px 0;border-bottom:1px solid var(--rule)}
tr:last-child td{border-bottom:none}
footer{margin-top:30px;padding-top:13px;border-top:1px solid var(--rule);
color:var(--dim);font-size:11px;line-height:1.7}
footer a{color:var(--ok)}
</style></head><body><div class="wrap">
<h1>wx <em>weather</em></h1>
<div class="sub" id="fcAsof">loading…</div>
<div id="banner"></div>
<div class="picker" id="picker"></div>
<div class="picker"><select id="mdl" class="loc"></select>
<span class="sub" id="cadence" style="align-self:center"></span></div>
<div class="panel"><h3 id="hTitle">Hourly</h3><canvas id="hourly"></canvas>
<div class="note hkey" id="hkey"></div>
<div class="row" id="agree" style="margin:8px 0 0"></div>
<div class="chips" id="chips"></div><div class="note" id="wts"></div></div>
<div class="tiles" id="curTiles"></div>
<div class="panel" style="margin-top:12px"><h3>10 days</h3><div class="daily" id="daily"></div></div>
<div class="panel" id="tidePanel" style="display:none"><h3 id="tideTitle">Tides</h3>
<div class="tideband" id="tides"></div><div class="note" id="tideNote"></div></div>
<div class="note" id="fcNote"></div>

<h2>morning report</h2>
<div class="sub" id="rpDate"></div>
<div class="panel" id="rpPanel"><div id="rpBody" class="note" style="margin:0">loading…</div></div>

<h2>server</h2>
<div class="sub" id="asof"></div>
<div class="row" id="health"></div>
<div class="tiles" id="tiles"></div>
<div class="charts" id="charts"></div>
<table id="timers"></table>
<footer id="foot"></footer>
<script nonce="__WX_CSP_NONCE__">
const $=id=>document.getElementById(id);
// Every string below originates in public pushed storage. CSP is the backstop;
// E() is the primary defence against markup/style injection in innerHTML.
function E(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
const S=(v,d)=>typeof v==='string'?v:(d==null?'':d);
const A=v=>Array.isArray(v)?v:[];
const O=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const N=v=>{if(v==null||v===''||typeof v==='boolean')return null;const n=Number(v);return Number.isFinite(n)?n:null};
const FX=(v,d)=>{const n=N(v);return n==null?'—':n.toFixed(d)};
const WMO={0:['☀️','🌙','Clear'],1:['🌤️','🌙','Mostly clear'],2:['⛅','☁️','Partly cloudy'],
3:['☁️','☁️','Overcast'],45:['🌫️','🌫️','Fog'],48:['🌫️','🌫️','Rime fog'],
51:['🌦️','🌧️','Drizzle'],53:['🌦️','🌧️','Drizzle'],55:['🌧️','🌧️','Drizzle'],
61:['🌦️','🌧️','Light rain'],63:['🌧️','🌧️','Rain'],65:['🌧️','🌧️','Heavy rain'],
66:['🌧️','🌧️','Freezing rain'],67:['🌧️','🌧️','Freezing rain'],
71:['🌨️','🌨️','Snow'],73:['🌨️','🌨️','Snow'],75:['❄️','❄️','Heavy snow'],77:['🌨️','🌨️','Snow grains'],
80:['🌦️','🌧️','Showers'],81:['🌧️','🌧️','Showers'],82:['⛈️','⛈️','Violent showers'],
95:['⛈️','⛈️','Thunderstorm'],96:['⛈️','⛈️','Storm + hail'],99:['⛈️','⛈️','Storm + hail']};
// Some models publish no WMO code — fall back to cloud+precip rather than
// showing nothing or, worse, a wrong-but-confident icon.
function ic(code,day,cloud,pr){
  if(code!=null&&WMO[code])return WMO[code][day?0:1];
  if(pr!=null&&pr>0.2)return '🌧️';
  if(cloud!=null){if(cloud>=80)return '☁️';if(cloud>=40)return day?'⛅':'☁️'}
  return day?'☀️':'🌙'}
const label=code=>(WMO[code]||['','','—'])[2];
const arrow=d=>d==null?'':['↓','↙','←','↖','↑','↗','→','↘'][Math.round(((d+180)%360)/45)%8];
const hh=t=>S(t).slice(11,13), dkey=t=>S(t).slice(0,10);
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dow=t=>{const[y,m,d]=S(t).slice(0,10).split('-').map(Number);
  if(!Number.isInteger(y)||!Number.isInteger(m)||!Number.isInteger(d))return '—';
  const dt=new Date(Date.UTC(y,m-1,d));return Number.isFinite(dt.getTime())?DOW[dt.getUTCDay()]+' '+d:'—'};

let F=null,M=null,H=[],sel=localStorage.wxloc||'newport',
    mdl=localStorage.wxmdl||'',metric='temp';

function sunMap(loc){const m={};const s=loc.sun||{};
  A(s.time).forEach((d,i)=>{const key=S(d);if(key)m[key]=[S(A(s.sunrise)[i]),S(A(s.sunset)[i])]});return m}
function isDay(t,sm){const s=sm[dkey(t)];if(!s||!s[0])return true;
  const x=S(t).slice(11,16);return x>=S(s[0]).slice(11,16)&&x<S(s[1]).slice(11,16)}

const METRICS={
 temp:{title:'Temperature °C',key:'temperature_2m',kind:'line',cvar:'--curve'},
 precip:{title:'Precipitation mm/h',key:'precipitation',kind:'bar',cvar:'--rain'},
 wind:{title:'Wind kt + gusts',key:'wind_speed_10m',key2:'wind_gusts_10m',kind:'line',cvar:'--ok'},
 pressure:{title:'Pressure hPa',key:'pressure_msl',kind:'line',cvar:'--dim'}};

// Gridline step: a multiple of the metric's natural unit, chosen so the chart
// carries roughly half a dozen lines. Temperature's unit is 0.5 °C, so a normal
// overnight range lands on half-degree lines and the band's top and bottom can
// be READ rather than eyeballed. A wide range steps up (0.5 -> 1 -> 2 ...)
// rather than drawing forty lines nobody can count.
function niceStep(range,base){
  for(const k of [1,2,4,5,10,20,50,100]){const s=base*k;if(range/s<=8)return s}
  return base*200}
function fmtTick(v,step){return v.toFixed(step<0.5?2:step<1?1:0)}

function drawHourly(loc,mo){
  const c=$('hourly'),dpr=devicePixelRatio||1,W=c.clientWidth,Hh=c.clientHeight;
  c.width=W*dpr;c.height=Hh*dpr;const x=c.getContext('2d');x.scale(dpr,dpr);
  const css=v=>getComputedStyle(document.body).getPropertyValue(v).trim();
  const m=METRICS[metric]||METRICS.temp,hr=mo&&mo.hourly||{},vals=A(hr[m.key]).map(N);
  const t=A(hr.time),n=Math.min(vals.length,t.length,48);if(!n)return;
  const sm=sunMap(loc);
  const v2=m.key2?A(hr[m.key2]).map(N):null;
  const bmin=Array.isArray(hr[m.key+'_min'])?hr[m.key+'_min'].map(N):null;
  const bmax=Array.isArray(hr[m.key+'_max'])?hr[m.key+'_max'].map(N):null;
  const all=vals.slice(0,n).concat(v2?v2.slice(0,n).filter(v=>v!=null):[],
    bmin?bmin.slice(0,n).filter(v=>v!=null):[],
    bmax?bmax.slice(0,n).filter(v=>v!=null):[]).filter(v=>v!=null);
  if(!all.length)return;
  let lo=Math.min(...all),hi=Math.max(...all);
  if(metric==='precip'){lo=0;hi=Math.max(hi,1)}
  if(hi-lo<2){const c0=(hi+lo)/2;lo=c0-1;hi=c0+1}
  const pad=(hi-lo)*.18;lo-=metric==='precip'?0:pad;hi+=pad;
  // Snap the range outward to whole steps, so every gridline is a round number
  // and the top/bottom of the band sit against readable values.
  const base={temp:0.5,wind:1,precip:0.1,pressure:1}[metric]||1;
  const step=niceStep(hi-lo,base);
  lo=Math.floor(lo/step)*step;hi=Math.ceil(hi/step)*step;
  if(hi-lo<step){hi=lo+step}
  const top=26,bot=44,ph=Hh-top-bot;
  // Left gutter for the scale. The plot used to run edge to edge; it now starts
  // after the labels so they never sit on top of the data.
  const GUT=40,PW=Math.max(10,W-GUT-10);
  const X=i=>GUT+i/(n-1)*PW, Y=v=>top+ph-(v-lo)/(hi-lo)*ph;
  const cw=PW/(n-1);
  x.fillStyle=css('--rule');
  for(let i=0;i<n;i++)if(!isDay(t[i],sm)){x.globalAlpha=.28;
    x.fillRect(X(i)-cw/2,top,cw,ph);x.globalAlpha=1}
  // Horizontal rules + left scale. Drawn BEFORE the series so the data always
  // sits on top of them, and kept faint so they read as a background grid.
  // Two tick densities. MINOR lines carry the resolution you actually read the
  // band against — half a degree for temperature — while LABELS sit on the
  // coarser major step so the gutter stays legible. Labelling every 0.5 line
  // over an 8 degree range would be seventeen numbers stacked on top of each
  // other; drawing only the labelled ones would lose the resolution that is
  // the whole point.
  const minor=(hi-lo)/base<=26?base:step/2;
  x.strokeStyle=css('--rule');x.lineWidth=1;
  for(let v=lo;v<=hi+minor*1e-6;v+=minor){
    if(Math.abs(v/step-Math.round(v/step))<1e-6)continue;   // major drawn below
    const yy=Math.round(Y(v))+.5;
    x.globalAlpha=.18;x.beginPath();x.moveTo(GUT,yy);x.lineTo(GUT+PW,yy);x.stroke();
  }
  x.fillStyle=css('--dim');x.font='9.5px ui-monospace,monospace';
  x.textAlign='right';x.textBaseline='middle';
  for(let v=lo;v<=hi+step*1e-6;v+=step){
    const yy=Math.round(Y(v))+.5;                 // crisp 1px line, not a blur
    x.globalAlpha=.45;x.beginPath();x.moveTo(GUT,yy);x.lineTo(GUT+PW,yy);x.stroke();
    x.globalAlpha=.9;x.fillText(fmtTick(v,step),GUT-6,yy);
  }
  x.globalAlpha=1;x.textBaseline='alphabetic';   // restore for the value labels
  const col=css(m.cvar);
  if(m.kind==='bar'){x.fillStyle=col;
    for(let i=0;i<n;i++){const v=vals[i];if(v==null)continue;
      x.fillRect(X(i)-2,Y(v),4,top+ph-Y(v))}}
  else{if(bmin&&bmax){x.fillStyle=col+'2b';x.beginPath();let st=false;
    for(let i=0;i<n;i++){if(bmax[i]==null)continue;
      st?x.lineTo(X(i),Y(bmax[i])):x.moveTo(X(i),Y(bmax[i]));st=true}
    for(let i=n-1;i>=0;i--)bmin[i]!=null&&x.lineTo(X(i),Y(bmin[i]));
    x.closePath();x.fill()}
  if(metric==='temp'){const g=x.createLinearGradient(0,top,0,top+ph);
      g.addColorStop(0,col+'55');g.addColorStop(1,col+'00');x.fillStyle=g;x.beginPath();
      x.moveTo(X(0),top+ph);for(let i=0;i<n;i++)x.lineTo(X(i),Y(vals[i]??lo));
      x.lineTo(X(n-1),top+ph);x.fill()}
    x.strokeStyle=col;x.lineWidth=1.8;x.beginPath();
    for(let i=0;i<n;i++)vals[i]!=null&&(i?x.lineTo(X(i),Y(vals[i])):x.moveTo(X(i),Y(vals[i])));x.stroke();
    if(v2){x.setLineDash([3,3]);x.beginPath();
      for(let i=0;i<n;i++)v2[i]!=null&&(i?x.lineTo(X(i),Y(v2[i])):x.moveTo(X(i),Y(v2[i])));
      x.stroke();x.setLineDash([])}}
  x.fillStyle=css('--ink');x.font='10.5px ui-monospace,monospace';x.textAlign='center';
  for(let i=0;i<n;i+=3)vals[i]!=null&&x.fillText(Math.round(vals[i])+(metric==='temp'?'°':''),X(i),Y(vals[i])-6);
  x.font='13px ui-monospace';x.textBaseline='top';
  for(let i=0;i<n;i+=4)x.fillText(ic(A(hr.weather_code)[i],isDay(t[i],sm),
    A(hr.cloud_cover)[i],A(hr.precipitation)[i]),X(i),Hh-30);
  x.fillStyle=css('--dim');x.font='9.5px ui-monospace';
  for(let i=0;i<n;i+=4)x.fillText(hh(t[i]),X(i),Hh-12);

  // KEY. Every mark above was otherwise unexplained: a reader had to infer that
  // the shaded columns meant night and that the dashed trace meant gusts.
  // Built from what was ACTUALLY drawn on this pass, so it can never advertise
  // a mark that is not on the chart — the night blocks only appear when the
  // window contains darkness, and gusts only exist on the wind metric.
  // NOTE: string concatenation, not template literals. This whole page is a
  // server-side template literal, so a backtick here closes it early — the
  // reason no client code in this file uses them.
  const K=[];
  if(t.slice(0,n).some(tt=>!isDay(tt,sm)))
    K.push('<span><i class="sw-night"></i>shaded = night</span>');
  if(m.kind==='bar')
    K.push('<span><i class="sw-bar" style="background:'+col+'"></i>bar = '
      +m.title.split(' ').pop()+'</span>');
  else{
    if(bmin&&bmax)
      K.push('<span><i class="sw-band" style="background:'+col+'2b;border:1px solid '
        +col+'55"></i>band = model spread</span>');
    K.push('<span><i class="sw-line" style="border-top-color:'+col
      +'"></i>line = forecast</span>');
    if(v2)K.push('<span><i class="sw-dash" style="border-top-color:'+col
      +'"></i>dotted = gusts</span>');
  }
  const kel=$('hkey');if(kel)kel.innerHTML=K.join('');
}

function renderForecast(){
  const locations=O(F&&F.locations),loc=O(locations[sel]);if(!Object.keys(loc).length)return;
  const models=O(loc.models),primary=S(F&&F.primary);
  if(!Object.prototype.hasOwnProperty.call(models,mdl))
    mdl=Object.prototype.hasOwnProperty.call(models,primary)?primary:(Object.keys(models)[0]||'');
  const mo=O(models[mdl]);if(!Object.keys(mo).length)return;
  $('picker').innerHTML=Object.entries(locations).map(([k,l])=>
    '<button class="loc'+(k===sel?' sel':'')+'" data-k="'+E(k)+'">'+E(O(l).name||k)+'</button>').join('');
  document.querySelectorAll('.loc[data-k]').forEach(b=>b.onclick=()=>{sel=b.dataset.k;
    localStorage.wxloc=sel;renderForecast()});
  $('mdl').innerHTML=Object.entries(models).map(([k,m])=>
    '<option value="'+E(k)+'"'+(k===mdl?' selected':'')+'>'+E(O(m).label||k)+'</option>').join('');
  $('mdl').onchange=e=>{mdl=e.target.value;localStorage.wxmdl=mdl;renderForecast()};
  $('cadence').textContent=S(mo.cadence,'—')+' · grid '+A(mo.grid).map(N).filter(v=>v!=null)
    .map(v=>v.toFixed(2)).join(', ');
  const current=O(mo.current),lo2=N(current.wind_speed_10m_min),hi2=N(current.wind_speed_10m_max);
  if(lo2!=null&&hi2!=null){const spread=hi2-lo2;
    $('agree').innerHTML=spread<=5
      ?'<span class="pill ok">models agree · wind '+E(lo2)+'–'+E(hi2)+' kt</span>'
      :'<span class="pill warn">models split · wind '+E(lo2)+'–'+E(hi2)+' kt — trust the band, not the line</span>';
  } else $('agree').innerHTML='';
  const weights=O(mo.weights),memberLabels=O(mo.member_labels);
  if(Object.keys(weights).length){
    $('wts').innerHTML='today&#39;s weights ('+E(mo.weights_status||'')+'): '+
      Object.entries(weights).map(([k,w])=>{
        const weight=N(w);return weight==null?'':E(memberLabels[k]||k)+' '+(weight*100).toFixed(0)+'%';
      }).filter(Boolean).join(' · ')+
      '<br>'+E(mo.weights_scope||'');
  } else $('wts').textContent='';
  $('hTitle').textContent='Hourly · '+S(loc.name,'Unknown')+' · '+S(mo.label,'Unknown')+' ('+S(loc.tz)+')';
  $('chips').innerHTML=Object.entries(METRICS).map(([k,m])=>
    '<button class="chip'+(k===metric?' sel':'')+'" data-m="'+k+'">'+m.title.split(' ')[0]+'</button>').join('');
  document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{metric=b.dataset.m;renderForecast()});
  drawHourly(loc,mo);
  const c=current,tile=(k,v,u)=>'<div class="tile"><div class="k">'+E(k)+
    '</div><div class="v">'+E(v==null?'—':v)+' <span class="u">'+E(u||'')+'</span></div></div>';
  $('curTiles').innerHTML=
    tile('Temperature',c.temperature_2m,'°C')+
    tile('Feels like*',c.feels_like,'°C')+
    tile('Precip',c.precipitation,'mm/h')+
    tile('Cloud',c.cloud_cover,'%')+
    tile('Wind '+arrow(c.wind_direction_10m),c.wind_speed_10m,'kt')+
    tile('Gusts',c.wind_gusts_10m,'kt')+
    tile('Pressure',N(c.pressure_msl)==null?'—':Math.round(N(c.pressure_msl)),'hPa')+
    tile('Humidity',c.relative_humidity_2m,'%')+
    tile('Dew point*',c.dew_point,'°C')+
    tile('Sky',ic(c.weather_code,true,c.cloud_cover,c.precipitation),
      c.weather_code!=null?label(c.weather_code):'derived');
  const d=O(mo.daily);
  $('daily').innerHTML=A(d.time).map((t,i)=>{
    const mx=N(A(d.temperature_2m_max)[i]),mn=N(A(d.temperature_2m_min)[i]);
    if(mx==null||mn==null)return '';
    const rain=N(A(d.precipitation_sum)[i])||0;
    return '<div class="day"><div class="dow">'+E(dow(t))+'</div><div class="ico">'+
    E(ic(A(d.weather_code)[i],true,null,rain/24))+
    '</div><div class="hi">'+Math.round(mx)+'°</div><div class="lo">'+Math.round(mn)+
    '°</div><div class="pr">'+(rain>0.05?rain.toFixed(1)+'mm':'')+
    '</div></div>'}).join('');
  const td=O(loc.tides),events=A(td.events);
  if(events.length){
    $('tidePanel').style.display='';
    $('tideTitle').textContent='Tides · '+S(td.station,'Unknown')+' gauge';
    $('tides').innerHTML=events.slice(0,8).map(raw=>{const e=O(raw),type=e.type==='high'?'high':
      e.type==='low'?'low':null,height=N(e.height_m),time=S(e.time_local);
      if(!type||height==null||!time)return '';
      return '<div class="tide '+(type==='high'?'hw':'lw')+'"><div class="tt">'+
      E(time.slice(11,16))+'</div><div class="th"><b>'+type.toUpperCase()+
      '</b> '+height.toFixed(2)+'m</div><div class="th">'+E(dow(time))+'</div></div>'}).join('');
    $('tideNote').textContent=S(td.note)+' · '+S(td.attribution);
  } else if(td&&td.error){
    $('tidePanel').style.display='';
    $('tideTitle').textContent='Tides · '+S(td.station);
    $('tides').innerHTML='<span class="bad">'+E(td.error)+'</span>';$('tideNote').textContent='';
  } else $('tidePanel').style.display='none';
  $('fcNote').textContent=S(F.model_note)+' * feels-like and dew point are computed, not model output. '+S(F.attribution);
}

function renderReport(rp){
  if(!rp){$('rpBody').textContent='no report yet — first one lands at 07:05 Brisbane';return}
  rp=O(rp);$('rpDate').textContent='yesterday: '+S(rp.date_local,'—')+' · SPITFIRE skill review, Newport';
  const L={dwd_icon:'ICON',ecmwf_ifs025:'IFS',ecmwf_aifs025_single:'AIFS',
    ukmo_global_deterministic_10km:'UKMO',jma_gsm:'JMA'};
  let h='';
  const nc=O(rp.newport_nowcast),samples=N(nc.samples),obs=O(nc.obs_kt);
  if(samples!=null&&samples>0){
    h+='<b>Wind at the beacons:</b> observed '+E(FX(obs.min,1))+'–'+E(FX(obs.max,1))+
      ' kt (mean '+E(FX(obs.mean,1))+') across '+samples.toFixed(0)+' half-hour checks.<br>';
    const weightBlock=O(rp.weights),w=O(weightBlock.weights),dl=O(weightBlock.delta);
    const best=S(nc.best);
    h+='<table style="margin-top:8px"><tr><th>model</th><th>MAE kt</th><th>weight</th><th>Δ</th></tr>'+
      Object.entries(O(nc.mae_kt)).sort((a,b)=>(N(a[1])??Infinity)-(N(b[1])??Infinity)).map(([m,eRaw])=>{
        const e=N(eRaw);if(e==null)return '';
        const d=N(dl[m]);
        const arrow=d==null?'—':d>0.002?'<span class="ok">▲'+(d*100).toFixed(1)+'%</span>'
          :d<-0.002?'<span class="bad">▼'+(-d*100).toFixed(1)+'%</span>':'·';
        const weight=N(w[m])||0;
        return '<tr><td>'+E(L[m]||m)+(m===best?' <span class="ok">★ best</span>':'')+
          '</td><td>'+e.toFixed(2)+'</td><td>'+(weight*100).toFixed(0)+'%</td><td>'+arrow+'</td></tr>'}).join('')+
      '</table>';
    const spitfire=N(nc.spitfire_mae_kt),bestMae=N(O(nc.mae_kt)[best]);
    if(spitfire!=null)h+='<div style="margin-top:6px">SPITFIRE blend MAE: <b>'+
      spitfire.toFixed(2)+' kt</b>'+
      (bestMae!=null?(spitfire<=bestMae
        ?' — <span class="ok">beat every individual model</span>'
        :' vs best single '+bestMae.toFixed(2)+' ('+E(L[best]||best)+')'):'')+'</div>';
  } else h+='<b>Wind skill:</b> '+E(nc.note||'no samples')+'<br>';
  const f24=O(rp.newport_forecast24);
  h+='<div style="margin-top:8px"><b>Day-ahead skill</b> (was the +24 h forecast right?): '+
    (f24.available===true?('issued '+E(f24.issued)+' — '+Object.entries(O(f24.mae_kt))
      .sort((a,b)=>(N(a[1])??Infinity)-(N(b[1])??Infinity)).map(([m,e])=>{
        const mae=N(e);return mae==null?'':E(L[m]||m)+' '+mae.toFixed(1)+' kt'}).filter(Boolean).join(' · ')+
      ' · best '+E(L[S(f24.best)]||S(f24.best))):E(f24.note||''))+'</div>';
  const sp=O(rp.model_spread),rows=A(sp.rows);
  if(sp.available===true&&rows.length){
    h+='<div style="margin-top:8px"><b>Where the models argued</b> ('+E(sp.at)+'):<br>'+
      rows.slice(0,6).map(raw=>{const r=O(raw),spread=N(r.spread_kt),min=N(r.min_kt),max=N(r.max_kt);
        if(spread==null||min==null||max==null)return '';
        return E(r.loc)+' <span class="'+(spread>8?'bad':spread>4?'warn':'ok')+
      '">'+min.toFixed(1)+'–'+max.toFixed(1)+' kt</span>'}).filter(Boolean).join(' · ')+'</div>';
  } else if(sp.note) h+='<div style="margin-top:8px"><b>Model spread:</b> '+E(sp.note)+'</div>';
  h+='<div style="margin-top:8px;opacity:.8">'+E(rp.truth_note||'')+'</div>';
  $('rpBody').innerHTML=h;
}

function renderMonitor(){
  const c=O(M);if(!Object.keys(c).length){$('asof').textContent='no server snapshot';return}
  const snapshotMs=Date.parse(S(c.ts)),age=Number.isFinite(snapshotMs)?(Date.now()-snapshotMs)/60000:Infinity,b=$('banner');
  if(age>5){b.textContent=Number.isFinite(age)
    ?'SERVER SILENT — last snapshot '+Math.max(0,age).toFixed(0)+' min ago. Everything below is history, not current state.'
    :'SERVER SILENT — snapshot timestamp is invalid. Everything below may be stale.';b.className='on'}
  else b.className='';
  $('asof').textContent=Number.isFinite(snapshotMs)
    ?'snapshot '+new Date(snapshotMs).toLocaleString()+' · '+Math.max(0,age).toFixed(0)+' min ago'
    :'snapshot timestamp invalid';
  const pill=(t,cl)=>'<span class="pill '+cl+'">'+E(t)+'</span>';
  const oh=O(c.om_health);
  const fails=A(c.failed_units).filter(u=>u!=='systemd-networkd-wait-online.service'
    &&u!=='residual-gate.service');
  $('health').innerHTML=
    pill('data '+(oh.status||'?'),oh.status==='ok'?'ok':'bad')+
    pill('api '+c.docker_om_api,c.docker_om_api==='running'?'ok':'bad')+
    pill('residual '+c.residual_verdict,c.residual_verdict==='fresh'?'ok':'warn')+
    pill(fails.length?fails.length+' failed unit(s)':'units clean',fails.length?'bad':'ok');
  const tile=(k,v,u)=>'<div class="tile"><div class="k">'+E(k)+'</div><div class="v">'+
    E(v==null?'—':v)+' <span class="u">'+E(u||'')+'</span></div></div>';
  const load=A(c.load),disk=O(c.disk_weather),net=O(c.net);
  $('tiles').innerHTML=
    tile('CPU',c.cpu_pct,'%')+tile('Load 1m',load[0],'')+
    tile('Memory',c.mem_used_pct,'%')+tile('CPU pkg',c.cpu_pkg_w,'W')+
    tile('CPU temp',c.cpu_pkg_c,'°C')+tile('NVMe',N(c.nvme_c)==null?'—':N(c.nvme_c).toFixed(0),'°C')+
    tile('Disk wx',disk.used_gb,'/'+(disk.total_gb==null?'—':disk.total_gb)+'G')+
    tile('Uptime',c.uptime_h,'h')+
    Object.entries(net).map(([i,n])=>{n=O(n);return tile(i+' ↓↑',
      (n.rx_kbs==null?'—':n.rx_kbs)+'/'+(n.tx_kbs==null?'—':n.tx_kbs),'kB/s')}).join('');
  // Net traffic spans ~400,000x (idle 0.3 kB/s vs an 82 MB/s om-sync burst),
  // so on a linear axis ~87% of samples sit in the bottom pixel row and the
  // chart says nothing except "syncs happened". Net is drawn on a LOG axis
  // with decade gridlines; CPU/power/temp keep linear, where it reads better.
  const specs=[{t:'CPU %',k:'cpu'},{t:'CPU pkg W',k:'w'},{t:'CPU °C',k:'tc'},
               {t:'Net ↓ kB/s',k:'rx',log:true,vol:true},
               {t:'Net ↑ kB/s',k:'tx',log:true,vol:true}];
  const fmtB=function(kb){return kb>=1048576?(kb/1048576).toFixed(1)+' GB':
    kb>=1024?(kb/1024).toFixed(1)+' MB':kb.toFixed(0)+' kB'};
  // Sub-heading carries what the shape cannot: total moved, typical idle rate,
  // and the peak with the time it happened — the spike is only interesting if
  // you can line it up against the timer table below.
  const sub=specs.map(function(s){
    const v=A(H).map(function(p){return N(O(p)[s.k])}).filter(function(z){return z!=null});
    if(!v.length)return '';
    const sorted=v.slice().sort(function(a,b){return a-b});
    const med=sorted[Math.floor(sorted.length/2)];
    let pk=-1,pi=0;A(H).forEach(function(p,j){const value=N(O(p)[s.k]);if(value!=null&&value>pk){pk=value;pi=j}});
    const point=O(A(H)[pi]),pointMs=Date.parse(S(point.t));
    const pt=Number.isFinite(pointMs)?new Date(pointMs).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
    // Samples are 2 min apart, so kB/s * 120 = kB moved in that interval.
    const tot=v.reduce(function(a,b){return a+b},0)*120;
    return (s.vol?fmtB(tot)+' total · ':'')+'median '+med.toFixed(1)+
           ' · peak '+pk.toFixed(0)+(pt?' at '+pt:'')});
  $('charts').innerHTML=specs.map(function(s,i){
    return '<div class="chart"><h3>'+s.t+' · 24h</h3>'+
      '<div style="font-size:10px;color:var(--dim);margin:-2px 0 3px">'+(sub[i]||'')+'</div>'+
      '<canvas class="spark" id="sp'+i+'"></canvas></div>'}).join('');
  specs.forEach(function(s,i){const cv=$('sp'+i);if(!cv)return;const dpr=devicePixelRatio||1;
    const w=cv.clientWidth,h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;
    const x=cv.getContext('2d');x.scale(dpr,dpr);
    const pts=A(H).map(function(p){return N(O(p)[s.k])}),vals=pts.filter(function(v){return v!=null});
    if(vals.length<2)return;
    // Log axis floors at 0.1 kB/s: log10(0) is -Infinity, and a genuinely idle
    // interface reports 0, which would otherwise blank the whole line.
    const FL=0.1;
    const tr=function(v){return s.log?Math.log10(Math.max(v,FL)):v};
    let lo=Math.min.apply(null,vals.map(tr)),hi=Math.max.apply(null,vals.map(tr));
    if(s.log){lo=Math.floor(lo);hi=Math.ceil(hi)}
    if(hi-lo<1e-9){lo-=.5;hi+=.5}
    const dim=getComputedStyle(document.body).getPropertyValue('--dim').trim();
    const py=function(v){return h-4-(tr(v)-lo)/(hi-lo)*(h-8)};
    if(s.log){x.strokeStyle=dim;x.globalAlpha=.22;x.lineWidth=1;
      for(let d=lo;d<=hi;d++){const yy=h-4-(d-lo)/(hi-lo)*(h-8);
        x.beginPath();x.moveTo(0,yy);x.lineTo(w,yy);x.stroke()}
      x.globalAlpha=1;x.fillStyle=dim;x.font='8px ui-monospace';
      // A 58px canvas spanning 7 decades cannot carry a label per gridline —
      // they collide and become unreadable, which is the problem this chart
      // was meant to solve. Label every Nth decade so they stay ~11px apart.
      const per=(h-8)/(hi-lo),step=Math.max(1,Math.ceil(11/per));
      for(let d=lo;d<=hi;d+=step){const yy=h-4-(d-lo)/(hi-lo)*(h-8);
        const p10=Math.pow(10,d);
        const lbl=p10>=1000?(p10/1000)+'k':(p10>=1?String(p10):p10.toFixed(1));
        x.fillText(lbl,2,Math.max(7,Math.min(h-1,yy-1)))}}
    x.strokeStyle=getComputedStyle(document.body).getPropertyValue('--ok').trim();
    x.lineWidth=1.3;x.beginPath();let st=false;
    pts.forEach(function(v,j){if(v==null){st=false;return}
      const px=j/(pts.length-1)*w;
      st?x.lineTo(px,py(v)):x.moveTo(px,py(v));st=true});x.stroke();
    if(!s.log){x.fillStyle=dim;x.font='9px ui-monospace';
      x.fillText(hi.toFixed(1),2,9);x.fillText(lo.toFixed(1),2,h-2)}});
  $('timers').innerHTML='<tr><th>timer</th><th>last</th><th>result</th></tr>'+
    Object.entries(O(c.timers)).map(([u,raw])=>{const t=O(raw),result=S(t.result,'—');
      const bad=result!=='—'&&result!=='success'&&u!=='residual-gate';
      return '<tr><td>'+E(u)+'</td><td>'+E(S(t.last,'—').replace(/^\\w+ /,''))+
      '</td><td class="'+(bad?'bad':'ok')+'">'+E(result)+'</td></tr>'}).join('');
  $('foot').innerHTML=E(c.power_note||'')+
    ' · Model spread scored side by side: <a href="/api/spread">/api/spread</a>.'+
    ' Read-only — the server pushes, this page renders.';
}

async function load(){
  try{
    const r=await fetch('/api/wx?data=1',{credentials:'same-origin'});if(!r.ok)throw new Error('HTTP '+r.status);
    const d=O(await r.json());M=Object.keys(O(d.current)).length?O(d.current):null;
    H=A(d.history);F=Object.keys(O(d.forecast)).length?O(d.forecast):null;renderReport(d.report);
    if(F){const generatedMs=Date.parse(S(F.generated_at)),age=Number.isFinite(generatedMs)
        ?Math.max(0,(Date.now()-generatedMs)/60000):null;
      $('fcAsof').textContent=age==null?'forecast timestamp invalid':
        'forecast built '+age.toFixed(0)+' min ago · auto-refreshes';
      const locations=O(F.locations),keys=Object.keys(locations);
      if(!Object.prototype.hasOwnProperty.call(locations,sel))sel=keys[0]||'';
      if(sel)renderForecast()}
    else $('fcAsof').textContent='no forecast payload found';
    renderMonitor();
  }catch(err){
    $('fcAsof').textContent='weather data unavailable';
    const banner=$('banner');banner.textContent='Could not refresh weather/server data. Showing the last successful view.';
    banner.className='on';
  }
}
load();setInterval(load,60000);
addEventListener('resize',()=>{if(F)renderForecast()});
</script></div></body></html>`;
