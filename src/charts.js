/**
 * charts.js — interactive dark-mode tearsheet charts for QuantStats.js
 *
 * Splits cleanly into two halves:
 *   1. buildChartData()  — runs in Node, shapes every chart into plain JSON
 *                          {x, y, ...} reusing the existing math layer.
 *   2. CLIENT_RUNTIME    — string injected into the HTML; runs in the browser,
 *                          draws each chart with ECharts ('dark' theme).
 *
 * ponytail: ECharts (CDN) is the one dep that covers line/bar/heatmap/box/area
 * + dark + tooltips/zoom. Offline-vendored bundle deferred until air-gapped
 * reports are needed.
 */

import { prepareReturns, toDrawdownSeries } from './utils.js';
import { compsum } from './stats.js';

const TD = 252; // trading days/yr
const ROLL = 126; // 6-month rolling window
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- small helpers ----------------------------------------------------------

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// rolling fn over values, value placed at the window's last index
function rolling(values, dates, win, fn) {
  const x = [];
  const y = [];
  for (let i = win - 1; i < values.length; i++) {
    x.push(iso(dates[i]));
    y.push(fn(values.slice(i - win + 1, i + 1)));
  }
  return { x, y };
}

// compound-group returns by a date-derived key; returns ordered [{key, value}]
function groupCompound(values, dates, keyFn) {
  const map = new Map();
  for (let i = 0; i < values.length; i++) {
    const k = keyFn(new Date(dates[i]));
    map.set(k, (map.get(k) == null ? 1 : map.get(k)) * (1 + values[i]));
  }
  return [...map.entries()].map(([key, prod]) => ({ key, value: (prod - 1) * 100 }));
}

const boxStats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return [
    quantile(s, 0) * 100,
    quantile(s, 0.25) * 100,
    quantile(s, 0.5) * 100,
    quantile(s, 0.75) * 100,
    quantile(s, 1) * 100,
  ];
};

// ---- main builder -----------------------------------------------------------

/**
 * Build all tearsheet chart data as JSON-serializable object.
 * @param {{values:number[], index:Date[]}} returns
 * @param {{values:number[], index:Date[]}|null} benchmark
 * @param {string} benchmarkTitle
 */
export function buildChartData(returns, benchmark = null, benchmarkTitle = 'Benchmark') {
  const vals = prepareReturns(returns.values ?? returns, 0, false);
  const dates = (returns.index ?? vals.map((_, i) => new Date(2000, 0, i + 1))).slice(0, vals.length);
  const x = dates.map(iso);

  const bVals = benchmark ? prepareReturns(benchmark.values ?? benchmark, 0, false) : null;

  // cumulative (compounded) %
  const cum = compsum(vals).map((v) => v * 100);
  const cumWealth = cum.map((v) => v / 100 + 1); // for log axis (always >0)

  // drawdown series %
  const dd = toDrawdownSeries(vals).map((v) => v * 100);

  // drawdown periods (sorted worst-first) → [startISO, endISO, depth%]
  // send up to 30; client picks how many to shade (default 5)
  const periods = worstDrawdownPeriods(vals, dates, 30);

  // monthly compound % grouped by year/month → heatmap matrix
  const monthly = groupCompound(vals, dates, (d) => `${d.getFullYear()}-${d.getMonth()}`);
  const years = [...new Set(monthly.map((m) => m.key.split('-')[0]))].sort();
  const heat = monthly.map((m) => {
    const [yr, mo] = m.key.split('-').map(Number);
    return [Number(mo), years.indexOf(String(yr)), Math.round(m.value * 100) / 100];
  });

  // EOY (yearly compound) %
  const yearly = groupCompound(vals, dates, (d) => String(d.getFullYear()));

  // rolling stats (6-mo)
  const rVol = rolling(vals, dates, ROLL, (w) => std(w) * Math.sqrt(TD) * 100);
  const rSharpe = rolling(vals, dates, ROLL, (w) => {
    const sd = std(w);
    return sd === 0 ? 0 : (mean(w) / sd) * Math.sqrt(TD);
  });
  const rSortino = rolling(vals, dates, ROLL, (w) => {
    const dn = Math.sqrt(mean(w.filter((r) => r < 0).map((r) => r * r)));
    return dn === 0 ? 0 : (mean(w) / dn) * Math.sqrt(TD);
  });

  // monthly distribution histogram (monthly % values)
  const monthlyVals = monthly.map((m) => m.value);
  const hist = histogram(monthlyVals, 22);
  hist.mean = mean(monthlyVals); // for the average vertical line
  hist.meanLabel = hist.x.reduce(
    (best, lbl) => (Math.abs(Number(lbl) - hist.mean) < Math.abs(Number(best) - hist.mean) ? lbl : best),
    hist.x[0]
  );

  // return quantiles (boxplots) per timeframe
  const weekKey = (d) => `${d.getFullYear()}-W${Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 6048e5)}`;
  const qtrKey = (d) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3)}`;
  const quantiles = {
    categories: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'],
    boxes: [
      boxStats(vals),
      boxStats(groupCompound(vals, dates, weekKey).map((g) => g.value / 100)),
      boxStats(monthlyVals.map((v) => v / 100)),
      boxStats(groupCompound(vals, dates, qtrKey).map((g) => g.value / 100)),
      boxStats(yearly.map((g) => g.value / 100)),
    ],
  };

  const data = {
    title: '',
    cumulative: {
      x,
      series: [{ name: 'Strategy', y: cum }],
      wealth: cumWealth,
    },
    daily: { x, y: vals.map((v) => v * 100) },
    eoy: {
      x: yearly.map((g) => g.key),
      y: yearly.map((g) => g.value),
      avg: mean(yearly.map((g) => g.value)),
    },
    monthlyDist: hist,
    rollingVol: rVol,
    rollingSharpe: rSharpe,
    rollingSortino: rSortino,
    ddPeriods: { x, y: cum, periods },
    underwater: { x, y: dd },
    heatmap: { months: MONTHS, years, data: heat },
    quantiles,
  };

  // benchmark overlay + rolling beta
  if (bVals) {
    const n = Math.min(vals.length, bVals.length);
    data.cumulative.series.push({
      name: benchmarkTitle,
      y: compsum(bVals.slice(0, n)).map((v) => v * 100),
    });
    data.rollingBeta = rollingBeta(vals.slice(0, n), bVals.slice(0, n), dates, ROLL);
  }

  return data;
}

function worstDrawdownPeriods(vals, dates, topN) {
  const dd = toDrawdownSeries(vals);
  const segs = [];
  let start = -1;
  for (let i = 0; i < dd.length; i++) {
    if (dd[i] < 0 && start < 0) start = i;
    else if (dd[i] >= 0 && start >= 0) {
      segs.push(seg(dd, start, i - 1));
      start = -1;
    }
  }
  if (start >= 0) segs.push(seg(dd, start, dd.length - 1));
  return segs
    .sort((a, b) => a.depth - b.depth)
    .slice(0, topN)
    .map((s) => [iso(dates[s.s]), iso(dates[s.e]), Math.round(s.depth * 1e4) / 100]);

  function seg(arr, s, e) {
    return { s, e, depth: Math.min(...arr.slice(s, e + 1)) };
  }
}

function rollingBeta(r, b, dates, win) {
  const x = [];
  const y = [];
  for (let i = win - 1; i < r.length; i++) {
    const rw = r.slice(i - win + 1, i + 1);
    const bw = b.slice(i - win + 1, i + 1);
    const rm = mean(rw);
    const bm = mean(bw);
    let cov = 0;
    let varB = 0;
    for (let j = 0; j < rw.length; j++) {
      cov += (rw[j] - rm) * (bw[j] - bm);
      varB += (bw[j] - bm) ** 2;
    }
    x.push(iso(dates[i]));
    y.push(varB === 0 ? 0 : cov / varB);
  }
  return { x, y };
}

function histogram(values, bins) {
  if (!values.length) return { x: [], y: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(Math.floor((v - min) / w), bins - 1)]++;
  const x = counts.map((_, i) => (min + (i + 0.5) * w).toFixed(1));
  return { x, y: counts };
}

// ---- dark CSS ---------------------------------------------------------------

export const DARK_CSS = `
:root{
  --bg:#0e1117; --panel:#161b22; --panel2:#1c2230; --border:#2a2e37;
  --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --pos:#3fb950; --neg:#f85149;
}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.container{max-width:1200px;margin:0 auto}
.header{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:24px}
.header h1{font-size:24px;font-weight:600;margin:0}
.header h1 dt{display:inline;margin-left:10px;font-size:14px;color:var(--muted);font-weight:400}
.header h4{margin:6px 0 0;font-size:12px;color:var(--muted);font-weight:400}
.content{display:grid;grid-template-columns:3fr 2fr;gap:28px}
.header a{color:var(--accent);text-decoration:none}
.chart{height:340px}
.chart.tall{height:380px}

/* draggable / collapsible panels (shared persistent layout) */
.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;
  margin-bottom:20px;overflow:hidden}
.panel.dragging{opacity:.4}
.panel-head{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--panel2);
  border-bottom:1px solid var(--border);font-size:11px;font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--muted);user-select:none}
.panel-head .drag{cursor:grab;color:var(--muted);font-size:13px}
.panel-head .ptitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.panel-head .collapse{background:none;border:0;color:var(--muted);cursor:pointer;font-size:13px;
  padding:0 4px;transition:transform .15s}
.panel.collapsed .panel-head .collapse{transform:rotate(-90deg)}
.panel.collapsed .panel-body{display:none}
.panel-body{padding:8px}
/* strip inner card chrome now that .panel is the card */
.panel-body .hero{border:0;background:transparent;margin:0;padding:8px}
.panel-body .table-wrapper{border:0;margin:0}
.panel-body details{margin-bottom:14px}
.panel-body details:last-of-type{margin-bottom:0}
#right h3{font-size:13px;font-weight:700;margin:0 0 10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.metric-main{text-align:center;margin-bottom:18px}
.metric-main h1{font-size:48px;margin:0;font-weight:700}
.metric-main .t{font-size:13px;color:var(--muted)}
.metric-sub-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px 18px;margin-bottom:24px}
.metric-sub{text-align:center}.metric-sub h2{font-size:24px;margin:0;font-weight:600}
.metric-sub .t{font-size:11px;color:var(--muted)}
.table-wrapper{overflow-x:auto;margin-bottom:24px;border:1px solid var(--border);border-radius:8px}
table{width:100%;border-collapse:collapse;background:var(--panel)}
th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px}
td:first-child,th:first-child{text-align:left}
thead th{background:var(--panel2);font-weight:600;text-transform:uppercase;font-size:11px;color:var(--muted)}
tr:hover td{background:var(--panel2)}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.dd-row{cursor:crosshair}
.disclaimer{margin-top:24px;padding:12px;background:var(--panel);border:1px solid var(--border);
  border-radius:8px;text-align:center;font-size:11px;color:var(--muted)}
@media(max-width:900px){.content{grid-template-columns:1fr}}

/* hero stat block (task 5) */
.hero{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:24px}
.hero .metric-main h1{font-size:52px;line-height:1.05}
.hero .metric-sub-grid{margin-bottom:0;margin-top:18px;grid-template-columns:repeat(3,1fr)}
.hero .metric-sub h2{font-size:20px}

/* collapsible metric sections (task 6) */
details{margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--panel)}
details>summary{cursor:pointer;list-style:none;padding:10px 14px;background:var(--panel2);
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text);user-select:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:'\\25B8';display:inline-block;margin-right:8px;color:var(--muted);transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
details .table-wrapper{margin:0;border:0;border-radius:0}
details table{background:transparent}

/* metric tooltip (task 7) */
.info{color:var(--muted);cursor:help;font-size:11px;position:relative}
.info:hover::after{content:attr(title);position:absolute;left:50%;bottom:140%;transform:translateX(-50%);
  width:220px;background:#1c2230;color:var(--text);border:1px solid var(--border);border-radius:6px;
  padding:8px 10px;font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;line-height:1.4;
  white-space:normal;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,.4);text-align:left}

/* worst-drawdown count selector (task 10) */
.dd-ctl{font-size:12px;color:var(--muted);margin:4px 0 6px}
.dd-ctl select{background:var(--panel2);color:var(--text);border:1px solid var(--border);
  border-radius:5px;padding:3px 6px;margin:0 4px;font-size:12px}
`;

// ---- client runtime (runs in browser) --------------------------------------

export const CLIENT_RUNTIME = `
(function(){
  var QS = window.__QS_DATA__;

  // ---- persistent panel layout (drag-reorder + collapse) -------------------
  // Layout is shared across every tearsheet via one localStorage key, so the
  // arrangement carries over when you open a different symphony's tearsheet.
  // Runs before charts mount so echarts inits against the final DOM order.
  window.__qsCharts = window.__qsCharts || [];
  (function initLayout(){
    var KEY='qs_tearsheet_layout_v1', COLS=['left','right'];
    function read(){try{return JSON.parse(localStorage.getItem(KEY))||{}}catch(e){return{}}}
    function write(s){try{localStorage.setItem(KEY,JSON.stringify(s))}catch(e){}}
    var state=read(); state.order=state.order||{}; state.collapsed=state.collapsed||{};

    // Apply saved order/collapse, merging in any panels not yet in saved state
    // (e.g. the benchmark-only rollingBeta panel) so layouts survive changes.
    COLS.forEach(function(col){
      var cont=document.getElementById(col); if(!cont)return;
      var panels={};
      [].slice.call(cont.querySelectorAll('.panel')).forEach(function(p){panels[p.dataset.panelId]=p});
      var ordered=(state.order[col]||[]).filter(function(id){return panels[id]});
      Object.keys(panels).forEach(function(id){if(ordered.indexOf(id)<0)ordered.push(id)});
      ordered.forEach(function(id){
        cont.appendChild(panels[id]);
        if(state.collapsed[id])panels[id].classList.add('collapsed');
      });
    });

    function persistOrder(){
      COLS.forEach(function(col){
        var cont=document.getElementById(col); if(!cont)return;
        state.order[col]=[].slice.call(cont.querySelectorAll('.panel'))
          .map(function(p){return p.dataset.panelId});
      });
      write(state);
    }
    function resizeAll(){(window.__qsCharts||[]).forEach(function(c){try{c&&c.resize()}catch(e){}})}
    window.__qsResizeAll=resizeAll;

    // collapse / expand
    document.addEventListener('click',function(e){
      var btn=e.target.closest&&e.target.closest('.collapse'); if(!btn)return;
      var p=btn.closest('.panel'); if(!p)return;
      p.classList.toggle('collapsed');
      state.collapsed[p.dataset.panelId]=p.classList.contains('collapsed');
      write(state);
      if(!p.classList.contains('collapsed'))setTimeout(resizeAll,0);
    });

    // drag handle: only the head starts a drag (so chart canvases stay usable)
    document.addEventListener('mousedown',function(e){
      var p=e.target.closest&&e.target.closest('.panel'); if(!p)return;
      var onHead=e.target.closest('.panel-head'), onBtn=e.target.closest('.collapse');
      p.draggable=!!onHead&&!onBtn;
    });

    var dragEl=null,dragCol=null;
    document.addEventListener('dragstart',function(e){
      var p=e.target.closest&&e.target.closest('.panel'); if(!p||!p.draggable)return;
      dragEl=p; dragCol=p.closest('#left,#right'); p.classList.add('dragging');
      if(e.dataTransfer)e.dataTransfer.effectAllowed='move';
    });
    document.addEventListener('dragend',function(){
      if(dragEl){dragEl.classList.remove('dragging'); dragEl.draggable=false;}
      if(dragCol)persistOrder();
      dragEl=null; dragCol=null;
    });
    document.addEventListener('dragover',function(e){
      if(!dragEl)return;
      var cont=e.target.closest&&e.target.closest('#left,#right');
      if(!cont||cont!==dragCol)return;   // reorder within the same column only
      e.preventDefault();
      var after=getAfter(cont,e.clientY);
      if(after==null)cont.appendChild(dragEl); else cont.insertBefore(dragEl,after);
    });
    function getAfter(cont,y){
      var els=[].slice.call(cont.querySelectorAll('.panel:not(.dragging)'));
      var best=null,bestOff=-Infinity;
      els.forEach(function(el){
        var b=el.getBoundingClientRect(), off=y-b.top-b.height/2;
        if(off<0&&off>bestOff){bestOff=off;best=el}
      });
      return best;
    }

    var rb=document.getElementById('qsResetLayout');
    if(rb)rb.addEventListener('click',function(e){
      e.preventDefault(); localStorage.removeItem(KEY); location.reload();
    });
  })();

  var AX='#8b949e', GRID='#2a2e37', ACCENT='#58a6ff', BENCH='#d29922', POS='#3fb950', NEG='#f85149';
  var avgLine={silent:true,symbol:'none',lineStyle:{color:NEG,type:'dashed',width:1.5},
    data:[{type:'average',name:'Avg'}],label:{show:true,position:'insideEndTop',color:NEG,
    formatter:function(p){return 'avg '+(p.value!=null?p.value.toFixed(2):'')}}};
  function base(extra){
    return Object.assign({
      backgroundColor:'transparent', textStyle:{color:'#e6edf3'},
      grid:{left:54,right:20,top:42,bottom:50},
      tooltip:{trigger:'axis',backgroundColor:'#1c2230',borderColor:GRID,textStyle:{color:'#e6edf3'}},
      xAxis:{type:'category',axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX},splitLine:{show:false}},
      yAxis:{type:'value',axisLine:{show:false},axisLabel:{color:AX},splitLine:{lineStyle:{color:GRID}}}
    }, extra);
  }
  function title(t){return {text:t,left:'center',textStyle:{color:'#e6edf3',fontSize:14,fontWeight:700}}}
  function mk(id,opt){var el=document.getElementById(id);if(!el||!opt)return null;
    var c=echarts.init(el,'dark');c.setOption(opt);window.__qsCharts.push(c);
    window.addEventListener('resize',function(){c.resize()});return c;}
  // line chart: yAxis scaled to fit data (low=bottom, high=top)
  function tline(d,t,yfmt,markAvg){
    var series=(d.series||[{name:t,y:d.y}]).map(function(s,i){
      var o={name:s.name,type:'line',showSymbol:false,data:s.y,lineStyle:{width:1.5},
        color:i===0?ACCENT:BENCH};
      if(markAvg&&i===0)o.markLine=avgLine;
      return o;
    });
    return base({title:title(t),
      xAxis:{type:'category',data:d.x,axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX}},
      yAxis:{type:'value',scale:true,axisLine:{show:false},
        axisLabel:{color:AX,formatter:yfmt||'{value}'},splitLine:{lineStyle:{color:GRID}}},
      legend:series.length>1?{top:22,textStyle:{color:AX}}:undefined,
      dataZoom:[{type:'inside'},{type:'slider',height:14,bottom:14,borderColor:GRID}],
      series:series});
  }

  mk('chart_cumulative', tline(QS.cumulative,'Cumulative Returns','{value}%'));
  if(QS.cumulative){
    // wealth index (1+return) sits in the 1-10 decade, so a default log axis
    // snaps to decade ticks and the curve looks flat. Pin min/max tight to the
    // data and label ticks as growth %.
    var w=QS.cumulative.wealth, wmin=Math.min.apply(null,w), wmax=Math.max.apply(null,w);
    var lg=tline({x:QS.cumulative.x,y:w},'Cumulative Returns (Log Scaled)');
    lg.yAxis={type:'log',min:wmin*0.98,max:wmax*1.02,axisLine:{show:false},
      axisLabel:{color:AX,formatter:function(v){return Math.round((v-1)*100)+'%'}},
      splitLine:{lineStyle:{color:GRID}}};
    mk('chart_log', lg);
  }

  // EOY bar + red dotted avg line
  mk('chart_eoy', base({title:title('EOY Returns'),
    xAxis:{type:'category',data:QS.eoy.x,axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX}},
    yAxis:{type:'value',axisLabel:{formatter:'{value}%',color:AX},splitLine:{lineStyle:{color:GRID}}},
    series:[{type:'bar',data:QS.eoy.y.map(function(v){return {value:v,itemStyle:{color:v>=0?POS:NEG}}}),
      markLine:{silent:true,symbol:'none',lineStyle:{color:NEG,type:'dashed',width:1.5},
        data:[{yAxis:QS.eoy.avg,name:'Avg'}],
        label:{show:true,position:'insideEndTop',color:NEG,formatter:'avg '+QS.eoy.avg.toFixed(2)+'%'}}}]}));

  // monthly distribution: Occurrences axis, sparse %, red mean line
  var mdInterval=Math.max(0,Math.ceil(QS.monthlyDist.x.length/8)-1);
  mk('chart_monthlyDist', base({title:title('Distribution of Monthly Returns'),
    xAxis:{type:'category',data:QS.monthlyDist.x,name:'Monthly Return %',nameLocation:'middle',nameGap:28,
      nameTextStyle:{color:AX},axisLine:{lineStyle:{color:GRID}},
      axisLabel:{color:AX,interval:mdInterval,formatter:'{value}%'}},
    yAxis:{type:'value',name:'Occurrences',nameTextStyle:{color:AX},axisLabel:{color:AX},splitLine:{lineStyle:{color:GRID}}},
    series:[{type:'bar',data:QS.monthlyDist.y,itemStyle:{color:ACCENT,opacity:.8},
      markLine:{silent:true,symbol:'none',lineStyle:{color:NEG,type:'dashed',width:1.5},
        data:[{xAxis:QS.monthlyDist.meanLabel,name:'Avg'}],
        label:{show:true,color:NEG,formatter:'avg '+QS.monthlyDist.mean.toFixed(2)+'%'}}}]}));

  // daily returns (bars, 0 baseline)
  mk('chart_daily', base({title:title('Daily Returns'),
    xAxis:{type:'category',data:QS.daily.x,axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX}},
    yAxis:{type:'value',axisLabel:{formatter:'{value}%',color:AX},splitLine:{lineStyle:{color:GRID}}},
    dataZoom:[{type:'inside'},{type:'slider',height:14,bottom:14,borderColor:GRID}],
    series:[{type:'bar',data:QS.daily.y.map(function(v){return {value:v,itemStyle:{color:v>=0?POS:NEG}}})}]}));

  // rolling stats + red dotted average line
  mk('chart_rollingVol', tline(QS.rollingVol,'Rolling Volatility (6-Months)','{value}%',true));
  mk('chart_rollingSharpe', tline(QS.rollingSharpe,'Rolling Sharpe (6-Months)',null,true));
  mk('chart_rollingSortino', tline(QS.rollingSortino,'Rolling Sortino (6-Months)',null,true));
  if(QS.rollingBeta) mk('chart_rollingBeta', tline(QS.rollingBeta,'Rolling Beta (6-Months)',null,true));

  // drawdown periods: selector for how many to shade (default 5)
  if(QS.ddPeriods){
    var ddEl=document.getElementById('chart_ddPeriods');
    var ctl=document.createElement('div'); ctl.className='dd-ctl';
    var max=QS.ddPeriods.periods.length;
    var opts=[1,3,5,10,20,max].filter(function(v,i,a){return v<=max&&a.indexOf(v)===i});
    ctl.innerHTML='Show worst <select id="ddN">'+opts.map(function(v){
      return '<option value="'+v+'"'+(v===5?' selected':'')+'>'+(v===max?'All ('+max+')':v)+'</option>';
    }).join('')+'</select> drawdowns';
    ddEl.parentNode.insertBefore(ctl, ddEl);
    var ddChart=echarts.init(ddEl,'dark');window.__qsCharts.push(ddChart);
    function renderDD(n){
      var areas=QS.ddPeriods.periods.slice(0,n).map(function(p){return [{xAxis:p[0]},{xAxis:p[1]}]});
      ddChart.setOption(base({title:title('Worst Drawdown Periods'),
        xAxis:{type:'category',data:QS.ddPeriods.x,axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX}},
        yAxis:{type:'value',scale:true,axisLabel:{formatter:'{value}%',color:AX},splitLine:{lineStyle:{color:GRID}}},
        dataZoom:[{type:'inside'},{type:'slider',height:14,bottom:14,borderColor:GRID}],
        series:[{type:'line',showSymbol:false,data:QS.ddPeriods.y,color:ACCENT,lineStyle:{width:1.5},
          markArea:{itemStyle:{color:'rgba(248,81,73,0.14)'},data:areas}},
          // empty overlay series; its markArea is driven by table-row hover
          {type:'line',data:[],silent:true,
            markArea:{itemStyle:{color:'rgba(88,166,255,0.35)'},data:[]}}]}),true);
    }
    renderDD(5);
    document.getElementById('ddN').addEventListener('change',function(e){renderDD(Number(e.target.value))});
    window.addEventListener('resize',function(){ddChart.resize()});

    // Hovering a row in the "Worst 30 Drawdowns" table shades that exact
    // period (by ISO start/end) on this chart via the overlay series' markArea.
    function setHL(data){ddChart.setOption({series:[{},{markArea:{data:data}}]});}
    document.addEventListener('mouseover',function(e){
      var r=e.target.closest&&e.target.closest('.dd-row'); if(!r||!r.dataset.start)return;
      setHL([[{xAxis:r.dataset.start},{xAxis:r.dataset.end||r.dataset.start}]]);
    });
    document.addEventListener('mouseout',function(e){
      var r=e.target.closest&&e.target.closest('.dd-row'); if(!r)return;
      setHL([]);
    });
  }

  // underwater (filled area) + red dotted average
  mk('chart_underwater', base({title:title('Underwater Plot'),
    xAxis:{type:'category',data:QS.underwater.x,axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX}},
    yAxis:{type:'value',scale:true,axisLabel:{formatter:'{value}%',color:AX},splitLine:{lineStyle:{color:GRID}}},
    dataZoom:[{type:'inside'},{type:'slider',height:14,bottom:14,borderColor:GRID}],
    series:[{type:'line',showSymbol:false,data:QS.underwater.y,color:NEG,lineStyle:{width:1},
      areaStyle:{color:'rgba(248,81,73,0.25)'},markLine:avgLine}]}));

  // monthly heatmap (compact cells)
  mk('chart_heatmap', {backgroundColor:'transparent',title:title('Monthly Returns (%)'),
    textStyle:{color:'#e6edf3'},
    tooltip:{position:'top',backgroundColor:'#1c2230',borderColor:GRID,textStyle:{color:'#e6edf3'},
      formatter:function(p){return QS.heatmap.years[p.value[1]]+' '+QS.heatmap.months[p.value[0]]+': '+p.value[2]+'%'}},
    grid:{left:54,right:16,top:38,bottom:42,height:'auto'},
    xAxis:{type:'category',data:QS.heatmap.months,splitArea:{show:true},axisLabel:{color:AX},axisLine:{lineStyle:{color:GRID}}},
    yAxis:{type:'category',inverse:true,data:QS.heatmap.years,splitArea:{show:true},axisLabel:{color:AX},axisLine:{lineStyle:{color:GRID}}},
    visualMap:{min:-10,max:10,calculable:true,orient:'horizontal',left:'center',bottom:4,itemHeight:80,
      inRange:{color:['#f85149','#161b22','#3fb950']},textStyle:{color:AX}},
    series:[{type:'heatmap',data:QS.heatmap.data,label:{show:true,color:'#e6edf3',fontSize:10,
      formatter:function(p){return p.value[2]}},itemStyle:{borderColor:GRID,borderWidth:1}}]});

  // return quantiles (boxplot)
  mk('chart_quantiles', base({title:title('Return Quantiles'),
    xAxis:{type:'category',data:QS.quantiles.categories,axisLine:{lineStyle:{color:GRID}},axisLabel:{color:AX}},
    yAxis:{type:'value',scale:true,axisLabel:{formatter:'{value}%',color:AX},splitLine:{lineStyle:{color:GRID}}},
    series:[{type:'boxplot',data:QS.quantiles.boxes,itemStyle:{color:'#1c2230',borderColor:ACCENT}}]}));
})();
`;
