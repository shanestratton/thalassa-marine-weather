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

export default async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.searchParams.get('data')) {
        const bust = `?t=${Math.floor(Date.now() / 30000)}`;
        const [c, h, f] = await Promise.all([
            fetch(`${BASE}/current.json${bust}`).then((r) => (r.ok ? r.json() : null)),
            fetch(`${BASE}/history.json${bust}`).then((r) => (r.ok ? r.json() : [])),
            fetch(`${BASE}/forecast.json${bust}`).then((r) => (r.ok ? r.json() : null)),
        ]);
        return new Response(JSON.stringify({ current: c, history: h, forecast: f }), {
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
    }
    return new Response(PAGE, {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300',
        },
    });
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>wx — weather & server</title>
<style>
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
<div class="row" id="agree" style="margin:8px 0 0"></div>
<div class="chips" id="chips"></div><div class="note" id="wts"></div></div>
<div class="tiles" id="curTiles"></div>
<div class="panel" style="margin-top:12px"><h3>10 days</h3><div class="daily" id="daily"></div></div>
<div class="panel" id="tidePanel" style="display:none"><h3 id="tideTitle">Tides</h3>
<div class="tideband" id="tides"></div><div class="note" id="tideNote"></div></div>
<div class="note" id="fcNote"></div>

<h2>server</h2>
<div class="sub" id="asof"></div>
<div class="row" id="health"></div>
<div class="tiles" id="tiles"></div>
<div class="charts" id="charts"></div>
<table id="timers"></table>
<footer id="foot"></footer>
<script>
const $=id=>document.getElementById(id);
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
const hh=t=>t.slice(11,13), dkey=t=>t.slice(0,10);
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dow=t=>{const[y,m,d]=t.slice(0,10).split('-').map(Number);
  return DOW[new Date(Date.UTC(y,m-1,d)).getUTCDay()]+' '+d};

let F=null,M=null,H=[],sel=localStorage.wxloc||'newport',
    mdl=localStorage.wxmdl||'',metric='temp';

function sunMap(loc){const m={};const s=loc.sun||{};
  (s.time||[]).forEach((d,i)=>{m[d]=[(s.sunrise||[])[i]||'',(s.sunset||[])[i]||'']});return m}
function isDay(t,sm){const s=sm[dkey(t)];if(!s||!s[0])return true;
  const x=t.slice(11,16);return x>=s[0].slice(11,16)&&x<s[1].slice(11,16)}

const METRICS={
 temp:{title:'Temperature °C',key:'temperature_2m',kind:'line',cvar:'--curve'},
 precip:{title:'Precipitation mm/h',key:'precipitation',kind:'bar',cvar:'--rain'},
 wind:{title:'Wind kt + gusts',key:'wind_speed_10m',key2:'wind_gusts_10m',kind:'line',cvar:'--ok'},
 pressure:{title:'Pressure hPa',key:'pressure_msl',kind:'line',cvar:'--dim'}};

function drawHourly(loc,mo){
  const c=$('hourly'),dpr=devicePixelRatio||1,W=c.clientWidth,Hh=c.clientHeight;
  c.width=W*dpr;c.height=Hh*dpr;const x=c.getContext('2d');x.scale(dpr,dpr);
  const css=v=>getComputedStyle(document.body).getPropertyValue(v).trim();
  const m=METRICS[metric],hr=mo.hourly,vals=(hr[m.key]||[]).map(v=>v==null?null:+v);
  const t=hr.time||[],n=Math.min(vals.length,48);if(!n)return;
  const sm=sunMap(loc);
  const v2=m.key2?(hr[m.key2]||[]):null;
  const bmin=hr[m.key+'_min'],bmax=hr[m.key+'_max'];
  const all=vals.slice(0,n).concat(v2?v2.slice(0,n).filter(v=>v!=null):[],
    bmin?bmin.slice(0,n).filter(v=>v!=null):[],
    bmax?bmax.slice(0,n).filter(v=>v!=null):[]).filter(v=>v!=null);
  if(!all.length)return;
  let lo=Math.min(...all),hi=Math.max(...all);
  if(metric==='precip'){lo=0;hi=Math.max(hi,1)}
  if(hi-lo<2){const c0=(hi+lo)/2;lo=c0-1;hi=c0+1}
  const pad=(hi-lo)*.18;lo-=metric==='precip'?0:pad;hi+=pad;
  const top=26,bot=44,ph=Hh-top-bot;
  const X=i=>i/(n-1)*(W-16)+8, Y=v=>top+ph-(v-lo)/(hi-lo)*ph;
  x.fillStyle=css('--rule');
  for(let i=0;i<n;i++)if(!isDay(t[i],sm)){x.globalAlpha=.28;
    x.fillRect(X(i)-(W-16)/(n-1)/2,top,(W-16)/(n-1),ph);x.globalAlpha=1}
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
  for(let i=0;i<n;i+=4)x.fillText(ic((hr.weather_code||[])[i],isDay(t[i],sm),
    (hr.cloud_cover||[])[i],(hr.precipitation||[])[i]),X(i),Hh-30);
  x.fillStyle=css('--dim');x.font='9.5px ui-monospace';
  for(let i=0;i<n;i+=4)x.fillText(hh(t[i]),X(i),Hh-12);
}

function renderForecast(){
  const loc=F.locations[sel];if(!loc)return;
  if(!loc.models[mdl])mdl=loc.models[F.primary]?F.primary:Object.keys(loc.models)[0];
  const mo=loc.models[mdl];
  $('picker').innerHTML=Object.entries(F.locations).map(([k,l])=>
    '<button class="loc'+(k===sel?' sel':'')+'" data-k="'+k+'">'+l.name+'</button>').join('');
  document.querySelectorAll('.loc[data-k]').forEach(b=>b.onclick=()=>{sel=b.dataset.k;
    localStorage.wxloc=sel;renderForecast()});
  $('mdl').innerHTML=Object.entries(loc.models).map(([k,m])=>
    '<option value="'+k+'"'+(k===mdl?' selected':'')+'>'+m.label+'</option>').join('');
  $('mdl').onchange=e=>{mdl=e.target.value;localStorage.wxmdl=mdl;renderForecast()};
  $('cadence').textContent=mo.cadence+' · grid '+mo.grid.map(g=>(+g).toFixed(2)).join(', ');
  const lo2=mo.current.wind_speed_10m_min,hi2=mo.current.wind_speed_10m_max;
  if(lo2!=null&&hi2!=null){const spread=hi2-lo2;
    $('agree').innerHTML=spread<=5
      ?'<span class="pill ok">models agree · wind '+lo2+'–'+hi2+' kt</span>'
      :'<span class="pill warn">models split · wind '+lo2+'–'+hi2+' kt — trust the band, not the line</span>';
  } else $('agree').innerHTML='';
  if(mo.weights){
    $('wts').innerHTML='today&#39;s weights ('+(mo.weights_status||'')+'): '+
      Object.entries(mo.weights).map(([k,w])=>
        (mo.member_labels&&mo.member_labels[k]||k)+' '+(w*100).toFixed(0)+'%').join(' · ')+
      '<br>'+(mo.weights_scope||'');
  } else $('wts').textContent='';
  $('hTitle').textContent='Hourly · '+loc.name+' · '+mo.label+' ('+(loc.tz||'')+')';
  $('chips').innerHTML=Object.entries(METRICS).map(([k,m])=>
    '<button class="chip'+(k===metric?' sel':'')+'" data-m="'+k+'">'+m.title.split(' ')[0]+'</button>').join('');
  document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{metric=b.dataset.m;renderForecast()});
  drawHourly(loc,mo);
  const c=mo.current,tile=(k,v,u)=>'<div class="tile"><div class="k">'+k+
    '</div><div class="v">'+(v==null?'—':v)+' <span class="u">'+(u||'')+'</span></div></div>';
  $('curTiles').innerHTML=
    tile('Temperature',c.temperature_2m,'°C')+
    tile('Feels like*',c.feels_like,'°C')+
    tile('Precip',c.precipitation,'mm/h')+
    tile('Cloud',c.cloud_cover,'%')+
    tile('Wind '+arrow(c.wind_direction_10m),c.wind_speed_10m,'kt')+
    tile('Gusts',c.wind_gusts_10m,'kt')+
    tile('Pressure',c.pressure_msl&&Math.round(c.pressure_msl),'hPa')+
    tile('Humidity',c.relative_humidity_2m,'%')+
    tile('Dew point*',c.dew_point,'°C')+
    tile('Sky',ic(c.weather_code,true,c.cloud_cover,c.precipitation),
      c.weather_code!=null?label(c.weather_code):'derived');
  const d=mo.daily;
  $('daily').innerHTML=(d.time||[]).map((t,i)=>{
    const mx=(d.temperature_2m_max||[])[i],mn=(d.temperature_2m_min||[])[i];
    if(mx==null||mn==null)return '';
    return '<div class="day"><div class="dow">'+dow(t)+'</div><div class="ico">'+
    ic((d.weather_code||[])[i],true,null,((d.precipitation_sum||[])[i]||0)/24)+
    '</div><div class="hi">'+Math.round(mx)+'°</div><div class="lo">'+Math.round(mn)+
    '°</div><div class="pr">'+
    (((d.precipitation_sum||[])[i]||0)>0.05?((d.precipitation_sum[i]).toFixed(1)+'mm'):'')+
    '</div></div>'}).join('');
  const td=loc.tides;
  if(td&&td.events&&td.events.length){
    $('tidePanel').style.display='';
    $('tideTitle').textContent='Tides · '+td.station+' gauge';
    $('tides').innerHTML=td.events.slice(0,8).map(e=>
      '<div class="tide '+(e.type==='high'?'hw':'lw')+'"><div class="tt">'+
      e.time_local.slice(11,16)+'</div><div class="th"><b>'+e.type.toUpperCase()+
      '</b> '+e.height_m.toFixed(2)+'m</div><div class="th">'+dow(e.time_local)+'</div></div>').join('');
    $('tideNote').textContent=td.note+' · '+td.attribution;
  } else if(td&&td.error){
    $('tidePanel').style.display='';
    $('tideTitle').textContent='Tides · '+(td.station||'');
    $('tides').innerHTML='<span class="bad">'+td.error+'</span>';$('tideNote').textContent='';
  } else $('tidePanel').style.display='none';
  $('fcNote').textContent=F.model_note+' * feels-like and dew point are computed, not model output. '+F.attribution;
}

function renderMonitor(){
  const c=M;if(!c){$('asof').textContent='no server snapshot';return}
  const age=(Date.now()-Date.parse(c.ts))/60000,b=$('banner');
  if(age>5){b.textContent='SERVER SILENT — last snapshot '+age.toFixed(0)+
    ' min ago. Everything below is history, not current state.';b.className='on'}
  else b.className='';
  $('asof').textContent='snapshot '+new Date(c.ts).toLocaleString()+' · '+age.toFixed(0)+' min ago';
  const pill=(t,cl)=>'<span class="pill '+cl+'">'+t+'</span>';
  const oh=c.om_health||{};
  const fails=(c.failed_units||[]).filter(u=>u!=='systemd-networkd-wait-online.service'
    &&u!=='residual-gate.service');
  $('health').innerHTML=
    pill('data '+(oh.status||'?'),oh.status==='ok'?'ok':'bad')+
    pill('api '+c.docker_om_api,c.docker_om_api==='running'?'ok':'bad')+
    pill('residual '+c.residual_verdict,c.residual_verdict==='fresh'?'ok':'warn')+
    pill(fails.length?fails.length+' failed unit(s)':'units clean',fails.length?'bad':'ok');
  const tile=(k,v,u)=>'<div class="tile"><div class="k">'+k+'</div><div class="v">'+
    (v==null?'—':v)+' <span class="u">'+(u||'')+'</span></div></div>';
  $('tiles').innerHTML=
    tile('CPU',c.cpu_pct,'%')+tile('Load 1m',c.load&&c.load[0],'')+
    tile('Memory',c.mem_used_pct,'%')+tile('CPU pkg',c.cpu_pkg_w,'W')+
    tile('CPU temp',c.cpu_pkg_c,'°C')+tile('NVMe',c.nvme_c&&c.nvme_c.toFixed(0),'°C')+
    tile('Disk wx',c.disk_weather&&c.disk_weather.used_gb,'/'+(c.disk_weather&&c.disk_weather.total_gb)+'G')+
    tile('Uptime',c.uptime_h,'h')+
    Object.entries(c.net||{}).map(([i,n])=>tile(i+' ↓↑',n.rx_kbs+'/'+n.tx_kbs,'kB/s')).join('');
  const specs=[['CPU %','cpu'],['CPU pkg W','w'],['CPU °C','tc'],['Net ↓ kB/s','rx']];
  $('charts').innerHTML=specs.map(([t],i)=>
    '<div class="chart"><h3>'+t+' · 24h</h3><canvas class="spark" id="sp'+i+'"></canvas></div>').join('');
  specs.forEach(([,k],i)=>{const cv=$('sp'+i);const dpr=devicePixelRatio||1;
    const w=cv.clientWidth,h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;
    const x=cv.getContext('2d');x.scale(dpr,dpr);
    const pts=H.map(p=>p[k]),vals=pts.filter(v=>v!=null);if(vals.length<2)return;
    let lo=Math.min(...vals),hi=Math.max(...vals);if(hi-lo<1e-9){lo-=.5;hi+=.5}
    x.strokeStyle=getComputedStyle(document.body).getPropertyValue('--ok').trim();
    x.lineWidth=1.3;x.beginPath();let st=false;
    pts.forEach((v,j)=>{if(v==null){st=false;return}
      const px=j/(pts.length-1)*w,py=h-4-(v-lo)/(hi-lo)*(h-8);
      st?x.lineTo(px,py):x.moveTo(px,py);st=true});x.stroke();
    x.fillStyle=getComputedStyle(document.body).getPropertyValue('--dim');
    x.font='9px ui-monospace';x.fillText(hi.toFixed(1),2,9);x.fillText(lo.toFixed(1),2,h-2)});
  $('timers').innerHTML='<tr><th>timer</th><th>last</th><th>result</th></tr>'+
    Object.entries(c.timers||{}).map(([u,t])=>{
      const bad=t.result&&t.result!=='success'&&u!=='residual-gate';
      return '<tr><td>'+u+'</td><td>'+(t.last||'—').replace(/^\\w+ /,'')+
      '</td><td class="'+(bad?'bad':'ok')+'">'+(t.result||'—')+'</td></tr>'}).join('');
  $('foot').innerHTML=(c.power_note||'')+
    ' · Model spread scored side by side: <a href="/api/spread">/api/spread</a>.'+
    ' Read-only — the server pushes, this page renders.';
}

async function load(){
  const r=await fetch('/api/wx?data=1');const d=await r.json();
  M=d.current;H=d.history||[];F=d.forecast;
  if(F){const age=(Date.now()-Date.parse(F.generated_at))/60000;
    $('fcAsof').textContent='forecast built '+age.toFixed(0)+' min ago · auto-refreshes';
    if(!F.locations[sel])sel=Object.keys(F.locations)[0];
    renderForecast()}
  else $('fcAsof').textContent='no forecast payload found';
  renderMonitor();
}
load();setInterval(load,60000);
addEventListener('resize',()=>{if(F)renderForecast()});
</script></div></body></html>`;
