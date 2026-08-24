#pragma once

// Dashboard served by the ESP32 itself. Everything is inline: the board has no
// internet in access-point mode, so no external stylesheet, font or script can
// be fetched. Kept in flash via PROGMEM and sent with server.send_P().

static const char DASHBOARD_HTML[] PROGMEM = R"HTMLPAGE(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SPL Wind Logger</title>
<style>
  :root {
    --bg:#0d1620; --panel:#14212e; --panel2:#1a2937; --line:#26394b;
    --ink:#e8f1f7; --dim:#8ba6b8; --faint:#5f7d92;
    --accent:#35d2e0; --ok:#3ddc91; --warn:#ffb454; --bad:#ff5f56;
    --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0 auto;max-width:1180px;padding:18px;background:var(--bg);color:var(--ink);
       font:15px/1.5 "Segoe UI",system-ui,sans-serif}
  h1{margin:0;font-size:20px;letter-spacing:-.2px}
  h2{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.09em;
     color:var(--dim);font-weight:600}
  .sub{color:var(--faint);font-size:13px;margin-top:2px}
  header{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;
         justify-content:space-between;margin-bottom:16px}
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .status{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--dim)}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--faint);flex:none}
  .dot.live{background:var(--ok);box-shadow:0 0 0 4px rgba(61,220,145,.18);animation:p 1.9s infinite}
  .dot.err{background:var(--bad)}
  @keyframes p{50%{opacity:.45}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:11px;
         padding:16px;margin-bottom:15px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}
  .tile{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
  .tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint)}
  .tile .v{font:600 26px/1.15 var(--mono);margin-top:4px;letter-spacing:-.5px}
  .tile .u{font-size:12px;color:var(--faint);font-weight:400}
  .tile.hero{background:linear-gradient(160deg,#16374a,#14212e);border-color:#2c5468}
  .tile.hero .v{font-size:40px;color:var(--accent)}
  canvas#chart{width:100%;height:240px;display:block}
  button{background:var(--panel2);color:var(--ink);border:1px solid var(--line);
         border-radius:7px;padding:9px 14px;font:inherit;font-size:14px;cursor:pointer;transition:.13s}
  button:hover:not(:disabled){background:#21374a;border-color:#38566e}
  button:disabled{opacity:.38;cursor:not-allowed}
  button.primary{background:var(--accent);color:#06222a;border-color:var(--accent);font-weight:640}
  button.primary:hover:not(:disabled){background:#52e2ee}
  input[type=number],select{background:var(--panel2);color:var(--ink);border:1px solid var(--line);
    border-radius:7px;padding:9px 11px;font:inherit;font-size:14px;width:104px}
  select{width:auto}
  label.fld{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--dim)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{padding:8px 9px;text-align:right;border-bottom:1px solid var(--line)}
  th{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
  th:first-child,td:first-child{text-align:left}
  td{font-family:var(--mono)}
  tbody tr:last-child td{border-bottom:none}
  .g{color:var(--ok)}.m{color:var(--warn)}.b{color:var(--bad)}
  .empty{color:var(--faint);font-style:italic;text-align:center;padding:16px;font-family:inherit}
  .row{display:flex;flex-wrap:wrap;gap:15px}
  .row>*{flex:1 1 360px;margin-bottom:0}
  .hint{font-size:12.5px;color:var(--faint);margin-top:9px}
  code{font-family:var(--mono);font-size:12.5px;color:var(--accent)}
  .note{border-left:3px solid var(--bad);background:rgba(255,95,86,.1);
        border-radius:0 7px 7px 0;padding:10px 13px;font-size:13.5px;margin-bottom:15px}
  footer{color:var(--faint);font-size:12.5px;margin-top:4px;text-align:center}
</style>
</head>
<body>

<header>
  <div>
    <h1>SPL Wind Logger</h1>
    <div class="sub">XIAO ESP32-C3 &middot; served over Wi-Fi &middot; no USB needed</div>
  </div>
  <div class="bar">
    <div class="status"><span class="dot" id="dot"></span><span id="state">Connecting&hellip;</span></div>
    <label class="fld">Units
      <select id="units">
        <option value="kmh">km/h</option>
        <option value="ms">m/s</option>
        <option value="sensor">Sensor V</option>
      </select></label>
  </div>
</header>

<div class="note" id="lost" hidden>
  <b>Lost contact with the logger.</b> If you are on its hotspot, your phone may have
  switched to mobile data because the hotspot has no internet. Reconnect and this will resume.
</div>

<div class="panel">
  <div class="tiles">
    <div class="tile hero"><div class="k">Wind speed</div>
      <div class="v"><span id="t-kmh">&mdash;</span> <span class="u">km/h</span></div></div>
    <div class="tile"><div class="k">Wind speed</div>
      <div class="v"><span id="t-ms">&mdash;</span> <span class="u">m/s</span></div></div>
    <div class="tile"><div class="k">Gust (3 s)</div>
      <div class="v"><span id="t-gust">&mdash;</span> <span class="u">km/h</span></div></div>
    <div class="tile"><div class="k">Sensor</div>
      <div class="v"><span id="t-sensor">&mdash;</span> <span class="u">V</span></div></div>
    <div class="tile"><div class="k">WIND_ADC</div>
      <div class="v"><span id="t-adc">&mdash;</span> <span class="u">V</span></div></div>
    <div class="tile"><div class="k">ADC raw</div>
      <div class="v"><span id="t-raw">&mdash;</span></div></div>
  </div>
</div>

<div class="panel">
  <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:6px">
    <h2 style="margin:0">Live trace</h2>
    <div class="bar">
      <label class="fld">Window
        <select id="win">
          <option value="60">Last 60</option>
          <option value="120" selected>Last 120</option>
          <option value="0">Everything</option>
        </select></label>
      <button id="clear">Clear</button>
    </div>
  </div>
  <canvas id="chart"></canvas>
  <div class="tiles" style="margin-top:13px">
    <div class="tile"><div class="k">Window min</div><div class="v"><span id="s-min">&mdash;</span></div></div>
    <div class="tile"><div class="k">Window mean</div><div class="v"><span id="s-mean">&mdash;</span></div></div>
    <div class="tile"><div class="k">Window max</div><div class="v"><span id="s-max">&mdash;</span></div></div>
    <div class="tile"><div class="k">Samples</div><div class="v"><span id="s-n">0</span></div></div>
    <div class="tile"><div class="k">Uptime</div><div class="v"><span id="s-up">&mdash;</span></div></div>
  </div>
</div>

<div class="row">
  <div class="panel">
    <h2>Calibration sweep</h2>
    <p style="margin:0 0 11px;font-size:13.5px;color:var(--dim)">
      Set the supply, read WIND_RAW on your meter, type it here, then capture.
      Error compares the firmware SENSOR figure against your meter.</p>
    <div class="bar" style="margin-bottom:13px">
      <label class="fld">Meter WIND_RAW
        <input type="number" id="set-v" step="0.001" min="0" max="5" placeholder="V"></label>
      <button class="primary" id="capture">Capture</button>
      <button id="exp-cal" disabled>CSV</button>
    </div>
    <table>
      <thead><tr><th>Meter (V)</th><th>SENSOR (V)</th><th>WIND_ADC</th><th>Error</th><th></th></tr></thead>
      <tbody id="cal"><tr><td colspan="5" class="empty">No points captured</td></tr></tbody>
    </table>
    <div id="fit" class="hint"></div>
  </div>

  <div class="panel">
    <h2>Session log</h2>
    <p style="margin:0 0 11px;font-size:13.5px;color:var(--dim)">
      Readings collected since this page was opened. The board keeps only its most recent
      readings, so leave the page open to build a longer record.</p>
    <div class="bar">
      <button id="exp-log" disabled>Export log (CSV)</button>
    </div>
    <div class="hint" id="net"></div>
  </div>
</div>

<footer id="foot"></footer>

<script>
"use strict";
var $=function(i){return document.getElementById(i)};
var samples=[],cal=[],latest=null,fails=0,seeded=false,period=500,redraw=false;
var MAXPTS=3000;
var U={kmh:{k:"kmh",l:"km/h",d:1},ms:{k:"ms",l:"m/s",d:2},sensor:{k:"sensor",l:"V",d:3}};
function unit(){return U[$("units").value]}

function setState(kind,label){
  $("dot").className="dot"+(kind?" "+kind:"");
  $("state").textContent=label;
  $("lost").hidden=(kind!=="err");
}

function fmtUp(ms){
  var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);
  return h?h+"h "+m+"m":m?m+"m "+(s%60)+"s":s+"s";
}

async function seed(){
  try{
    var r=await fetch("api/history",{cache:"no-store"});
    if(!r.ok)throw 0;
    var d=await r.json();
    period=d.period||500;
    samples.length=0;
    for(var i=0;i<d.kmh.length;i++){
      samples.push({t:i*period,kmh:d.kmh[i],ms:d.kmh[i]/3.6,
                    sensor:d.sensor[i],adc:d.sensor[i]/3,raw:0});
    }
    seeded=true;
  }catch(e){/* history is optional; live polling still works */}
}

async function poll(){
  try{
    var r=await fetch("api/live",{cache:"no-store"});
    if(!r.ok)throw new Error("HTTP "+r.status);
    var d=await r.json();
    fails=0;
    setState("live","Live");
    period=d.period||period;
    latest=d;
    samples.push({t:d.up,raw:d.raw,adc:d.adc,sensor:d.sensor,ms:d.ms,kmh:d.kmh});
    if(samples.length>MAXPTS)samples.shift();
    $("s-up").textContent=fmtUp(d.up);
    $("net").textContent="Device "+(d.mode||"")+" at "+(d.ip||location.host)+
      " · publishing every "+(period/1000).toFixed(1)+" s";
    queue();
  }catch(e){
    if(++fails>=3)setState("err","No response");
  }
}

function queue(){
  if(redraw)return;
  redraw=true;
  requestAnimationFrame(function(){redraw=false;render()});
}

function view(){
  var n=parseInt($("win").value,10);
  return n>0?samples.slice(-n):samples;
}

function render(){
  var u=unit();
  if(latest){
    $("t-kmh").textContent=latest.kmh.toFixed(1);
    $("t-ms").textContent=latest.ms.toFixed(2);
    $("t-gust").textContent=latest.gust.toFixed(1);
    $("t-sensor").textContent=latest.sensor.toFixed(3);
    $("t-adc").textContent=latest.adc.toFixed(3);
    $("t-raw").textContent=latest.raw.toFixed(0);
  }
  var w=view(),ser=[];
  for(var i=0;i<w.length;i++)ser.push(w[i][u.k]);
  if(ser.length){
    var sum=0,lo=Infinity,hi=-Infinity;
    for(var j=0;j<ser.length;j++){sum+=ser[j];if(ser[j]<lo)lo=ser[j];if(ser[j]>hi)hi=ser[j]}
    $("s-min").textContent=lo.toFixed(u.d);
    $("s-mean").textContent=(sum/ser.length).toFixed(u.d);
    $("s-max").textContent=hi.toFixed(u.d);
  }else{
    $("s-min").textContent=$("s-mean").textContent=$("s-max").textContent="—";
  }
  $("s-n").textContent=samples.length;
  $("exp-log").disabled=samples.length===0;
  draw(ser,u);
}

function nice(v){
  if(!(v>0))return 0;
  var mag=Math.pow(10,Math.floor(Math.log10(v))),n=v/mag;
  var s=n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10;
  return s*mag;
}

function draw(ser,u){
  var cv=$("chart"),dpr=window.devicePixelRatio||1;
  var w=cv.clientWidth,h=cv.clientHeight;
  if(!w||!h)return;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){
    cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);
  }
  var g=cv.getContext("2d");
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,w,h);
  var pl=54,pr=12,pt=14,pb=20,pw=w-pl-pr,ph=h-pt-pb;
  var peak=0;
  for(var i=0;i<ser.length;i++)if(ser[i]>peak)peak=ser[i];
  var top=nice(peak*1.15)||1;
  g.lineWidth=1;
  g.font="11px ui-monospace,Consolas,monospace";
  for(var k=0;k<=5;k++){
    var val=top/5*k,y=Math.round(pt+ph-val/top*ph)+.5;
    g.strokeStyle="rgba(141,190,216,.11)";
    g.beginPath();g.moveTo(pl,y);g.lineTo(pl+pw,y);g.stroke();
    g.fillStyle="#5f7d92";g.textAlign="right";g.textBaseline="middle";
    g.fillText(val.toFixed(u.d),pl-9,y);
  }
  g.fillStyle="#5f7d92";g.textAlign="left";g.textBaseline="top";
  g.fillText(u.l,5,pt-4);
  if(ser.length<2){
    g.fillStyle="#5f7d92";g.textAlign="center";g.textBaseline="middle";
    g.font="13px 'Segoe UI',sans-serif";
    g.fillText("Waiting for data...",pl+pw/2,pt+ph/2);
    return;
  }
  var X=function(i){return pl+i/(ser.length-1)*pw};
  var Y=function(v){return pt+ph-v/top*ph};
  var gr=g.createLinearGradient(0,pt,0,pt+ph);
  gr.addColorStop(0,"rgba(53,210,224,.30)");
  gr.addColorStop(1,"rgba(53,210,224,0)");
  g.beginPath();g.moveTo(X(0),pt+ph);
  for(var a=0;a<ser.length;a++)g.lineTo(X(a),Y(ser[a]));
  g.lineTo(X(ser.length-1),pt+ph);g.closePath();
  g.fillStyle=gr;g.fill();
  g.beginPath();
  for(var b=0;b<ser.length;b++){if(b)g.lineTo(X(b),Y(ser[b]));else g.moveTo(X(b),Y(ser[b]))}
  g.strokeStyle="#35d2e0";g.lineWidth=2;g.lineJoin="round";g.lineCap="round";g.stroke();
  g.beginPath();g.arc(X(ser.length-1),Y(ser[ser.length-1]),3.5,0,Math.PI*2);
  g.fillStyle="#35d2e0";g.fill();
}

/* calibration */
$("capture").onclick=function(){
  var v=parseFloat($("set-v").value);
  if(!isFinite(v)||v<0){$("set-v").focus();return}
  if(!latest)return;
  cal.push({set:v,sensor:latest.sensor,adc:latest.adc});
  cal.sort(function(a,b){return a.set-b.set});
  $("set-v").value="";
  renderCal();
};
$("set-v").onkeydown=function(e){if(e.key==="Enter")$("capture").click()};

function renderCal(){
  var b=$("cal");b.innerHTML="";
  if(!cal.length){
    b.innerHTML='<tr><td colspan="5" class="empty">No points captured</td></tr>';
    $("exp-cal").disabled=true;$("fit").textContent="";return;
  }
  $("exp-cal").disabled=false;
  cal.forEach(function(p,i){
    var e=p.set>0?(p.sensor-p.set)/p.set*100:NaN;
    var c=!isFinite(e)?"":Math.abs(e)<=2?"g":Math.abs(e)<=5?"m":"b";
    var tr=document.createElement("tr");
    tr.innerHTML="<td>"+p.set.toFixed(3)+"</td><td>"+p.sensor.toFixed(3)+"</td><td>"+
      p.adc.toFixed(3)+'</td><td class="'+c+'">'+
      (isFinite(e)?(e>=0?"+":"")+e.toFixed(1)+"%":"—")+
      '</td><td><button class="del" data-i="'+i+'">Remove</button></td>';
    b.appendChild(tr);
  });
  Array.prototype.forEach.call(b.querySelectorAll("button.del"),function(x){
    x.onclick=function(){cal.splice(parseInt(x.getAttribute("data-i"),10),1);renderCal()};
  });
  var num=0,den=0,used=0;
  for(var i=0;i<cal.length;i++){
    if(cal[i].set<=0)continue;
    num+=cal[i].sensor*cal[i].set;den+=cal[i].sensor*cal[i].sensor;used++;
  }
  if(used>=2&&den>0){
    var f=num/den;
    $("fit").innerHTML="Best-fit correction across "+used+" non-zero points: <b>&times;"+
      f.toFixed(4)+"</b>, equivalent to <code>DIVIDER_MULTIPLIER = "+(3*f).toFixed(4)+
      "f</code> in main.cpp (currently 3.0). Only worth changing if it sits consistently "+
      "more than about 2% from 1.0.";
  }else{
    $("fit").textContent="Capture at least two non-zero points to get a fit.";
  }
}

/* export */
function dl(name,text){
  var url=URL.createObjectURL(new Blob([text],{type:"text/csv"}));
  var a=document.createElement("a");
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url)},1000);
}
$("exp-log").onclick=function(){
  var t0=samples.length?samples[0].t:0;
  var r=["seconds,adc_raw,wind_adc_v,sensor_v,wind_ms,wind_kmh"];
  for(var i=0;i<samples.length;i++){
    var s=samples[i];
    r.push([((s.t-t0)/1000).toFixed(2),s.raw.toFixed(0),s.adc.toFixed(4),
            s.sensor.toFixed(4),s.ms.toFixed(3),s.kmh.toFixed(2)].join(","));
  }
  dl("wind-log.csv",r.join("\n"));
};
$("exp-cal").onclick=function(){
  var r=["meter_wind_raw_v,firmware_sensor_v,wind_adc_v,error_pct"];
  for(var i=0;i<cal.length;i++){
    var p=cal[i],e=p.set>0?((p.sensor-p.set)/p.set*100).toFixed(2):"";
    r.push([p.set.toFixed(3),p.sensor.toFixed(3),p.adc.toFixed(3),e].join(","));
  }
  dl("calibration-sweep.csv",r.join("\n"));
};

$("clear").onclick=function(){samples.length=0;render()};
$("units").onchange=render;
$("win").onchange=render;
window.addEventListener("resize",queue);

$("foot").textContent="SEN0170 0-5 V → 20k/10k divider → D1/GPIO3 · wind = sensor V × 6 m/s";

seed().then(function(){render();poll();setInterval(poll,500)});
</script>
</body>
</html>
)HTMLPAGE";
