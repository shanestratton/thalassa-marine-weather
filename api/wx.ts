/**
 * /api/wx — server monitoring portal for the weather box.
 *
 * The server is outbound-only, so this page cannot query it. Instead the box
 * pushes a metrics snapshot + 24 h history ring to public object storage
 * every 2 minutes (ops/bin/wx-metrics in the thalassa-weather-server repo),
 * and this edge function renders whatever was last pushed.
 *
 * THE MOST IMPORTANT ELEMENT IS THE STALENESS BANNER. A dead server and a
 * healthy server produce identical dashboards in every respect except the
 * snapshot timestamp — so when that goes quiet, the page must turn loudly
 * red rather than continuing to display the last good numbers as if current.
 *
 * ?data=1 proxies the two JSON objects same-origin (no CORS dependency, and
 * a cache-buster defeats the storage CDN for a file that changes every 2 min).
 */
export const config = { runtime: 'edge' };

const BASE = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/weather/status';

export default async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.searchParams.get('data')) {
        const bust = `?t=${Math.floor(Date.now() / 30000)}`;
        const [c, h] = await Promise.all([
            fetch(`${BASE}/current.json${bust}`).then((r) => (r.ok ? r.json() : null)),
            fetch(`${BASE}/history.json${bust}`).then((r) => (r.ok ? r.json() : [])),
        ]);
        return new Response(JSON.stringify({ current: c, history: h }), {
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
<title>wx — server status</title>
<style>
:root{--paper:#F4F6F2;--ink:#12201A;--dim:#5A6B62;--rule:#D5DED6;--panel:#FFF;
--ok:#0E7C55;--warn:#C4703A;--bad:#A33A2B}
@media(prefers-color-scheme:dark){:root{--paper:#0B1410;--ink:#DCE8E0;--dim:#7C8F85;
--rule:#1E2E27;--panel:#101C17;--ok:#4FBE8B;--warn:#D98A4E;--bad:#D4614F}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:14px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;
font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 60px}
h1{font-family:Georgia,serif;font-weight:400;font-size:30px;margin:0 0 2px;letter-spacing:-.02em}
h1 em{font-style:italic;color:var(--ok)}
.sub{color:var(--dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.08em}
#banner{display:none;margin:16px 0;padding:12px 16px;border:2px solid var(--bad);
color:var(--bad);font-weight:600}
#banner.on{display:block}
.row{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
.pill{padding:4px 12px;border:1px solid currentColor;font-size:11.5px;
text-transform:uppercase;letter-spacing:.06em}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--rule);padding:12px 14px}
.tile .k{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.tile .v{font-size:24px;margin-top:2px}
.tile .u{font-size:12px;color:var(--dim)}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:18px}
.chart{background:var(--panel);border:1px solid var(--rule);padding:12px 14px 6px}
.chart h3{margin:0 0 6px;font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-weight:500}
canvas{width:100%;height:64px;display:block}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:18px}
th{text-align:left;color:var(--dim);font-size:10.5px;text-transform:uppercase;
letter-spacing:.08em;padding:0 8px 6px 0;border-bottom:1px solid var(--rule);font-weight:500}
td{padding:6px 8px 6px 0;border-bottom:1px solid var(--rule)}
tr:last-child td{border-bottom:none}
footer{margin-top:34px;padding-top:14px;border-top:1px solid var(--rule);
color:var(--dim);font-size:11.5px;line-height:1.7}
</style></head><body><div class="wrap">
<h1>wx <em>status</em></h1>
<div class="sub" id="asof">loading…</div>
<div id="banner"></div>
<div class="row" id="health"></div>
<div class="tiles" id="tiles"></div>
<div class="charts" id="charts"></div>
<table id="timers"></table>
<footer id="foot"></footer>
<script>
const $=id=>document.getElementById(id);
const tile=(k,v,u)=>'<div class="tile"><div class="k">'+k+'</div><div class="v">'+
 (v==null?'—':v)+' <span class="u">'+(u||'')+'</span></div></div>';
const pill=(t,c)=>'<span class="pill '+c+'">'+t+'</span>';
function spark(id,pts,color){
  const c=$(id);if(!c)return;const dpr=devicePixelRatio||1;
  const w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;
  const x=c.getContext('2d');x.scale(dpr,dpr);
  const vals=pts.filter(v=>v!=null);if(vals.length<2)return;
  let lo=Math.min(...vals),hi=Math.max(...vals);if(hi-lo<1e-9){lo-=.5;hi+=.5}
  x.strokeStyle=color;x.lineWidth=1.4;x.beginPath();let started=false;
  pts.forEach((v,i)=>{if(v==null){started=false;return}
    const px=i/(pts.length-1)*w,py=h-4-((v-lo)/(hi-lo))*(h-8);
    started?x.lineTo(px,py):x.moveTo(px,py);started=true});
  x.stroke();
  x.fillStyle=getComputedStyle(document.body).getPropertyValue('--dim');
  x.font='9px ui-monospace,monospace';
  x.fillText(hi.toFixed(1),2,9);x.fillText(lo.toFixed(1),2,h-2);
}
async function load(){
  const r=await fetch('/api/wx?data=1');const {current:c,history:h}=await r.json();
  if(!c){$('banner').textContent='No snapshot found in storage.';$('banner').className='on';return}
  const age=(Date.now()-Date.parse(c.ts))/60000;
  $('asof').textContent='snapshot '+new Date(c.ts).toLocaleString()+' · '+age.toFixed(0)+' min ago · auto-refreshes';
  const b=$('banner');
  if(age>5){b.textContent='SERVER SILENT — last snapshot '+age.toFixed(0)+
    ' min ago. Everything below is history, not current state.';b.className='on'}
  else b.className='';
  const oh=c.om_health||{};
  const fails=(c.failed_units||[]).filter(u=>u!=='systemd-networkd-wait-online.service');
  $('health').innerHTML=
    pill('data '+(oh.status||'?'),oh.status==='ok'?'ok':'bad')+
    pill('api '+c.docker_om_api,c.docker_om_api==='running'?'ok':'bad')+
    pill('residual '+c.residual_verdict,c.residual_verdict==='fresh'?'ok':'warn')+
    pill(fails.length?fails.length+' failed unit(s)':'units clean',fails.length?'bad':'ok');
  $('tiles').innerHTML=
    tile('CPU',c.cpu_pct,'%')+tile('Load 1m',c.load&&c.load[0],'')+
    tile('Memory',c.mem_used_pct,'% of '+c.mem_total_gb+'G')+
    tile('CPU pkg power',c.cpu_pkg_w,'W')+
    tile('CPU temp',c.cpu_pkg_c,'°C')+tile('NVMe temp',c.nvme_c&&c.nvme_c.toFixed(0),'°C')+
    tile('Weather disk',c.disk_weather&&c.disk_weather.used_gb,'/'+ (c.disk_weather&&c.disk_weather.total_gb)+'G')+
    tile('Uptime',c.uptime_h,'h')+
    Object.entries(c.net||{}).map(([i,n])=>tile(i+' ↓↑',n.rx_kbs+' / '+n.tx_kbs,'kB/s')).join('');
  const charts=[['CPU %','cpu','#0E7C55'],['CPU pkg W','w','#3E6E8E'],
    ['CPU temp °C','tc','#C4703A'],['Net ↓ kB/s','rx','#8B4A7D']];
  $('charts').innerHTML=charts.map(([t],i)=>
    '<div class="chart"><h3>'+t+' · 24h</h3><canvas id="c'+i+'"></canvas></div>').join('');
  charts.forEach(([,k,col],i)=>spark('c'+i,(h||[]).map(p=>p[k]),col));
  $('timers').innerHTML='<tr><th>timer</th><th>last</th><th>next</th><th>result</th></tr>'+
    Object.entries(c.timers||{}).map(([u,t])=>{
      const bad=t.result&&t.result!=='success';
      return '<tr><td>'+u+'</td><td>'+(t.last||'—').replace(/^\\w+ /,'')+
        '</td><td>'+(t.next||'—').replace(/^\\w+ /,'')+
        '</td><td class="'+(bad?'bad':'ok')+'">'+(t.result||'—')+'</td></tr>'}).join('');
  $('foot').textContent=(c.power_note||'')+
    ' · Read-only: the server pushes, this page renders. Nothing here can reach the box.';
}
load();setInterval(load,60000);
</script></div></body></html>`;
