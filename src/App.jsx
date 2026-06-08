import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════════════════════ */
const SHEET_BASE =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vR4HZmD32YImGG6adm8j1u11J63HRx0TibrAMZcRNFwZ_tvYHVfAqIcBp69MGu6pw/pub";

// Each tab maps to a gid (sheet index in the workbook).
// The first sheet (gid=0) may be a "Config" or "Ventes" sheet.
// Adjust gid values if your workbook has a different order.
const TAB_GIDS = { ventes: 0, pub: 1, reseaux: 2, emails: 3, lancements: 4 };

const TABS = [
  { id: "ventes",     label: "Ventes",     icon: "💰" },
  { id: "pub",        label: "Pub",        icon: "📣" },
  { id: "reseaux",    label: "Réseaux",    icon: "📱" },
  { id: "emails",     label: "Emails",     icon: "📧" },
  { id: "lancements", label: "Lancements", icon: "🚀" },
  { id: "ia",         label: "IA",         icon: "🤖" },
];

// Default KPI definitions per tab (used as fallback labels + ordering)
const KPI_META = {
  ventes: [
    { key: "ca",        label: "Chiffre d'affaires", icon: "💶", unit: "€" },
    { key: "commandes", label: "Commandes",           icon: "🛒", unit: ""  },
    { key: "panier",    label: "Panier moyen",        icon: "🧺", unit: "€" },
    { key: "clients",   label: "Nouveaux clients",    icon: "👤", unit: ""  },
    { key: "conv",      label: "Taux conversion",     icon: "🎯", unit: "%" },
    { key: "remb",      label: "Remboursements",      icon: "↩️", unit: "€" },
  ],
  pub: [
    { key: "depenses",    label: "Dépenses pub",  icon: "💸", unit: "€" },
    { key: "impressions", label: "Impressions",   icon: "👁️", unit: ""  },
    { key: "clics",       label: "Clics",         icon: "🖱️", unit: ""  },
    { key: "ctr",         label: "CTR",           icon: "📊", unit: "%" },
    { key: "cpc",         label: "CPC",           icon: "💰", unit: "€" },
    { key: "roas",        label: "ROAS",          icon: "📈", unit: "x" },
  ],
  reseaux: [
    { key: "abonnes",    label: "Abonnés",        icon: "👥", unit: ""  },
    { key: "reach",      label: "Reach",          icon: "📡", unit: ""  },
    { key: "engagement", label: "Engagement",     icon: "❤️", unit: "%" },
    { key: "posts",      label: "Posts publiés",  icon: "📝", unit: ""  },
    { key: "partages",   label: "Partages",       icon: "🔄", unit: ""  },
    { key: "saves",      label: "Sauvegardes",    icon: "🔖", unit: ""  },
  ],
  emails: [
    { key: "liste",      label: "Taille liste",   icon: "📋", unit: ""  },
    { key: "envoyes",    label: "Envoyés",        icon: "📤", unit: ""  },
    { key: "ouverture",  label: "Taux ouverture", icon: "📭", unit: "%" },
    { key: "clic",       label: "Taux de clic",   icon: "🖱️", unit: "%" },
    { key: "desabo",     label: "Désabonnements", icon: "🚫", unit: ""  },
    { key: "revenus",    label: "Revenus email",  icon: "💶", unit: "€" },
  ],
  lancements: [
    { key: "inscrits",  label: "Inscrits",         icon: "✍️", unit: ""  },
    { key: "presents",  label: "Présents live",    icon: "🎙️", unit: ""  },
    { key: "taux_p",    label: "Taux présence",    icon: "📊", unit: "%" },
    { key: "ventes_l",  label: "Ventes",           icon: "💰", unit: ""  },
    { key: "ca_l",      label: "CA généré",        icon: "💶", unit: "€" },
    { key: "conv_l",    label: "Taux conversion",  icon: "🎯", unit: "%" },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════════
   CSV PARSER
═══════════════════════════════════════════════════════════════════════════ */
function parseCSV(text) {
  const lines = [];
  let cur = "", inQ = false;
  const chars = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let row = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '"') {
      if (inQ && chars[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === "," && !inQ) {
      row.push(cur.trim()); cur = "";
    } else if (c === "\n" && !inQ) {
      row.push(cur.trim()); cur = "";
      if (row.some(Boolean)) lines.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  if (cur || row.length) { row.push(cur.trim()); if (row.some(Boolean)) lines.push(row); }
  return lines;
}

/*
  Expected sheet structure (one sheet per tab):
  ─────────────────────────────────────────────────────
  Row 1 (header): KPI | Valeur | Tendance (%) | [Valeur_Prev | Tendance_Prev] | [chart data...]
  Row 2+: one KPI per row

  OR flat structure (all tabs in one sheet, gid=0):
  Onglet | KPI | Valeur | Tendance | Periode

  We auto-detect which format is used.
*/
function sheetRowsToKpis(rows, meta) {
  if (!rows || rows.length < 2) return null;

  const header = rows[0].map(h => h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

  // Detect column indices
  const iKpi   = header.findIndex(h => h.includes("kpi") || h.includes("indicateur") || h.includes("metrique") || h.includes("nom"));
  const iVal   = header.findIndex(h => h.includes("valeur") && !h.includes("prev"));
  const iTrend = header.findIndex(h => h.includes("tendance") || h.includes("trend") || h.includes("evol") || h.includes("%"));
  const iChart = header.findIndex(h => h.includes("graph") || h.includes("chart") || h.includes("serie") || h.includes("historique"));

  // Build chart data from header columns if multi-period columns exist
  // e.g. columns: KPI | Val | Tend | Jan | Fev | Mar | ...
  const chartCols = [];
  header.forEach((h, i) => {
    if (i > Math.max(iKpi, iVal, iTrend) && i !== iChart) chartCols.push({ label: rows[0][i], idx: i });
  });

  const kpis = {};
  const chartSeries = {};

  rows.slice(1).forEach((row, ri) => {
    const kpiLabel = iKpi >= 0 ? row[iKpi] : (meta[ri] ? meta[ri].label : `KPI ${ri + 1}`);
    if (!kpiLabel) return;
    const normalKey = kpiLabel.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Find matching meta key
    let metaItem = meta.find(m =>
      normalKey.includes(m.label.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(" ")[0]) ||
      normalKey.includes(m.key)
    ) || meta[ri];

    const key = metaItem ? metaItem.key : `kpi_${ri}`;
    const value = iVal >= 0 ? row[iVal] : (row[1] || "–");
    const trend = iTrend >= 0 ? parseFloat((row[iTrend] || "0").replace(",", ".").replace("%", "")) : 0;

    kpis[key] = {
      label: kpiLabel,
      value: value || "–",
      trend: isNaN(trend) ? 0 : trend,
    };

    // Collect chart series
    chartCols.forEach(col => {
      if (!chartSeries[col.label]) chartSeries[col.label] = {};
      chartSeries[col.label][key] = parseFloat((row[col.idx] || "0").replace(",", ".").replace(/[^0-9.-]/g, "")) || 0;
    });
  });

  // Build chart data array
  let chartData = [];
  if (Object.keys(chartSeries).length >= 2) {
    chartData = Object.entries(chartSeries).map(([name, vals]) => ({ name, ...vals }));
  }

  return { kpis, chartData };
}

/* ═══════════════════════════════════════════════════════════════════════════
   DATA FETCHING
═══════════════════════════════════════════════════════════════════════════ */
async function fetchTabCSV(gid) {
  const url = `${SHEET_BASE}?gid=${gid}&single=true&output=csv&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// Fallback demo data
function demoData() {
  const mk = (vals, trends) => (k, i) => ({ label: KPI_META[k][i].label, value: String(vals[i]), trend: trends[i] });
  const build = (tab, vals, trends) =>
    Object.fromEntries(KPI_META[tab].map((m, i) => [m.key, { label: m.label, value: String(vals[i]), trend: trends[i] }]));

  return {
    isDemo: true,
    clientName: "Démo Client",
    healthScore: 74,
    ventes: { kpis: build("ventes", ["12 450 €","87","143 €","34","3,2 %","320 €"], [12,-3,8,21,-1,-15]), chartData: [] },
    pub:    { kpis: build("pub",    ["2 100 €","145 000","3 200","2,2 %","0,65 €","5,9x"], [-5,18,10,-2,-8,14]), chartData: [] },
    reseaux:{ kpis: build("reseaux",["4 820","22 400","4,7 %","18","340","890"],            [6,24,3,0,12,20]),   chartData: [] },
    emails: { kpis: build("emails", ["3 200","4 800","38 %","6,2 %","12","1 840 €"],        [4,0,5,-1,-3,22]),   chartData: [] },
    lancements:{ kpis: build("lancements",["520","310","59,6 %","42","8 400 €","13,5 %"],   [30,15,-2,25,28,-1]),chartData: [] },
  };
}

function generateChartData(tabId, period) {
  const labels = period === "semaine"
    ? ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"]
    : ["S1","S2","S3","S4","S5","S6","S7","S8","S9","S10","S11","S12"];
  return labels.map((name, i) => ({
    name,
    valeur:   Math.round(800 + Math.sin(i * 0.9) * 320 + Math.random() * 150),
    objectif: Math.round(850 + i * 18),
  }));
}

function calcHealthScore(allTabData) {
  let total = 0, count = 0;
  Object.values(allTabData).forEach(tab => {
    if (!tab?.kpis) return;
    Object.values(tab.kpis).forEach(kpi => {
      total += kpi.trend || 0;
      count++;
    });
  });
  if (!count) return 70;
  const avg = total / count;
  return Math.min(100, Math.max(0, Math.round(50 + avg * 1.5)));
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERIOD HELPERS
═══════════════════════════════════════════════════════════════════════════ */
function periodLabel(period, offset) {
  const now = new Date();
  if (period === "semaine") {
    const d = new Date(now);
    d.setDate(d.getDate() + offset * 7);
    const dow = d.getDay() || 7;
    const mon = new Date(d); mon.setDate(d.getDate() - dow + 1);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const fmt = x => x.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    return `${fmt(mon)} – ${fmt(sun)}`;
  }
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STYLES (injected as <style>)
═══════════════════════════════════════════════════════════════════════════ */
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Syne:wght@400;500;600;700;800&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{background:#07090F;color:#E8EAF0;font-family:'Syne',sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}
:root{
  --bg:#07090F; --s1:#0D1120; --s2:#111827; --s3:#1a2035;
  --border:rgba(200,244,100,.08); --border2:rgba(200,244,100,.18);
  --acc:#C8F464; --acc-dim:rgba(200,244,100,.12); --acc-glow:rgba(200,244,100,.3);
  --txt:#E8EAF0; --muted:#6B7280; --muted2:#9CA3AF;
  --red:#FF6B6B; --red-dim:rgba(255,107,107,.14);
  --amber:#FFB347; --amber-dim:rgba(255,179,71,.14);
  --r:14px; --maxw:1200px;
  --font:'Syne',sans-serif; --mono:'DM Mono',monospace;
}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(200,244,100,.2);border-radius:99px}

/* ── HEADER ── */
.hdr{
  position:fixed;top:0;left:0;right:0;z-index:200;
  height:60px;
  background:rgba(7,9,15,.94);
  backdrop-filter:blur(24px);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;padding:0 16px;
}
.hdr-inner{
  width:100%;max-width:var(--maxw);margin:0 auto;
  display:flex;align-items:center;gap:12px;
}
.logo{font-size:17px;font-weight:800;letter-spacing:-.5px;white-space:nowrap;flex-shrink:0}
.logo em{color:var(--acc);font-style:normal}
.logo span{color:var(--txt)}

.hdr-mid{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
.client-nm{
  font-size:11px;font-weight:700;color:var(--muted);
  letter-spacing:.08em;text-transform:uppercase;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;
}
.health-row{display:flex;align-items:center;gap:7px}
.health-lbl{font-size:10px;color:var(--muted);font-family:var(--mono)}
.health-track{width:70px;height:5px;background:var(--s3);border-radius:99px;overflow:hidden}
.health-fill{height:100%;border-radius:99px;transition:width 1.2s cubic-bezier(.4,0,.2,1)}
.health-num{font-size:12px;font-weight:700;font-family:var(--mono)}

.nav-group{display:flex;align-items:center;gap:4px;flex-shrink:0}
.prd-btn{
  background:var(--s2);border:1px solid var(--border);
  color:var(--muted);border-radius:8px;padding:5px 9px;
  font-size:11px;font-family:var(--font);font-weight:700;
  cursor:pointer;transition:all .18s;white-space:nowrap;
}
.prd-btn.on{background:var(--acc-dim);border-color:var(--acc);color:var(--acc)}
.prd-btn:hover:not(.on){border-color:var(--border2);color:var(--txt)}
.arr{
  background:none;border:1px solid var(--border);color:var(--muted);
  border-radius:7px;width:28px;height:28px;font-size:13px;
  cursor:pointer;transition:all .18s;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;
}
.arr:hover:not(:disabled){border-color:var(--acc);color:var(--acc)}
.arr:disabled{opacity:.25;cursor:not-allowed}

/* ── LAYOUT ── */
.main{padding-top:60px;min-height:100vh}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 14px 120px}

/* ── TABS BAR ── */
.tabs-bar{
  display:flex;gap:3px;padding:10px 0 0;
  overflow-x:auto;scrollbar-width:none;
  position:sticky;top:60px;z-index:100;
  background:var(--bg);
  border-bottom:1px solid var(--border);
  padding-bottom:8px;
}
.tabs-bar::-webkit-scrollbar{display:none}
.tab-btn{
  flex-shrink:0;display:flex;align-items:center;gap:5px;
  padding:7px 13px;border-radius:9px;border:1px solid transparent;
  background:none;color:var(--muted);
  font-family:var(--font);font-size:12px;font-weight:700;
  cursor:pointer;transition:all .18s;white-space:nowrap;
}
.tab-btn.on{background:var(--acc-dim);border-color:var(--acc);color:var(--acc)}
.tab-btn:hover:not(.on){background:var(--s2);color:var(--txt)}

/* ── BANNERS ── */
.banner{
  margin-top:12px;padding:9px 13px;border-radius:10px;
  font-size:11px;font-family:var(--mono);line-height:1.6;
  display:flex;align-items:flex-start;gap:8px;
}
.banner.info{background:var(--acc-dim);border:1px solid rgba(200,244,100,.22);color:var(--acc)}
.banner.err{background:var(--red-dim);border:1px solid rgba(255,107,107,.25);color:var(--red)}
.banner button{background:none;border:none;color:inherit;cursor:pointer;text-decoration:underline;font:inherit;padding:0;flex-shrink:0}

/* ── PERIOD LABEL ── */
.period-lbl{
  font-family:var(--mono);font-size:11px;color:var(--muted);
  margin:18px 0 11px;letter-spacing:.08em;
  display:flex;align-items:center;gap:6px;
}
.period-lbl::before{content:'';display:block;width:3px;height:3px;border-radius:50%;background:var(--acc)}

/* ── KPI GRID ── */
.kpi-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;margin-bottom:20px;
}
@media(min-width:640px){.kpi-grid{grid-template-columns:repeat(3,1fr);gap:14px}}

.kcard{
  background:var(--s1);
  border:1px solid var(--border);
  border-radius:var(--r);
  padding:15px 15px 13px;
  position:relative;overflow:hidden;
  transition:border-color .2s,transform .15s,box-shadow .2s;
}
.kcard::after{
  content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse at 0 0,rgba(200,244,100,.05) 0%,transparent 65%);
  pointer-events:none;
}
.kcard:hover{border-color:rgba(200,244,100,.22);transform:translateY(-2px);box-shadow:0 8px 32px rgba(0,0,0,.35)}
.kcard-icon{font-size:17px;margin-bottom:7px;line-height:1}
.kcard-lbl{font-size:10px;color:var(--muted);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:5px;line-height:1.3}
.kcard-val{font-size:20px;font-weight:800;font-family:var(--mono);letter-spacing:-.5px;line-height:1;word-break:break-all}
@media(min-width:640px){.kcard-val{font-size:22px}}
.kcard-unit{font-size:12px;font-weight:500;color:var(--muted);margin-left:2px}
.kcard-trend{
  display:inline-flex;align-items:center;gap:3px;
  font-size:10px;font-weight:700;font-family:var(--mono);
  padding:3px 7px;border-radius:99px;margin-top:8px;letter-spacing:.02em;
}
.kcard-trend.up{background:var(--acc-dim);color:var(--acc)}
.kcard-trend.dn{background:var(--red-dim);color:var(--red)}
.kcard-trend.nt{background:rgba(107,114,128,.15);color:var(--muted)}

/* ── CHART ── */
.chart-box{
  background:var(--s1);border:1px solid var(--border);
  border-radius:var(--r);padding:18px 6px 10px;margin-bottom:20px;
}
.chart-hd{
  display:flex;align-items:center;justify-content:space-between;
  padding:0 14px 14px;
}
.chart-title{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.chart-legend{display:flex;gap:12px}
.chart-legend-item{display:flex;align-items:center;gap:5px;font-size:10px;font-family:var(--mono);color:var(--muted)}
.chart-legend-dot{width:8px;height:2px;border-radius:1px}
@media(min-width:640px){.chart-box{padding:20px 12px 12px}}

/* ── IA PANEL ── */
.ia-wrap{padding:24px 0}
.ia-head{font-size:21px;font-weight:800;margin-bottom:6px;letter-spacing:-.3px}
.ia-sub{font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:24px;max-width:460px}
.ia-actions{display:flex;gap:10px;flex-wrap:wrap}
.ia-btn{
  display:inline-flex;align-items:center;gap:8px;
  background:var(--acc);color:#07090F;
  font-family:var(--font);font-size:13px;font-weight:800;
  border:none;border-radius:11px;padding:13px 24px;
  cursor:pointer;transition:all .2s;letter-spacing:.02em;
}
.ia-btn:hover{background:#d8ff70;transform:translateY(-1px);box-shadow:0 8px 28px var(--acc-glow)}
.ia-btn:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
.ia-btn.outline{background:none;border:1px solid var(--border2);color:var(--acc)}
.ia-btn.outline:hover{background:var(--acc-dim)}
.ia-loading{display:flex;align-items:center;gap:8px;margin-top:22px;color:var(--muted);font-size:12px;font-family:var(--mono)}
.dots{display:flex;gap:4px}
.dot{width:5px;height:5px;border-radius:50%;background:var(--acc);animation:bop 1.1s infinite}
.dot:nth-child(2){animation-delay:.18s}
.dot:nth-child(3){animation-delay:.36s}
.ia-out{
  margin-top:22px;background:var(--s1);border:1px solid var(--border);
  border-radius:var(--r);padding:20px;
  font-size:13px;line-height:1.85;white-space:pre-wrap;color:var(--txt);
  animation:fadeUp .4s ease;
}
.ia-out strong{color:var(--acc)}

/* ── LOADING / ERROR SCREENS ── */
.loading-scr,.error-scr{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:55vh;gap:14px;text-align:center;padding:24px;
}
.spinner{
  width:38px;height:38px;border:2px solid var(--s3);
  border-top-color:var(--acc);border-radius:50%;
  animation:spin .7s linear infinite;
}
.load-txt{color:var(--muted);font-size:12px;font-family:var(--mono);letter-spacing:.06em}
.err-ico{font-size:36px;margin-bottom:4px}
.err-title{font-size:16px;font-weight:700}
.err-body{color:var(--muted);font-size:12px;line-height:1.8;max-width:360px}
.err-body code{font-family:var(--mono);background:var(--s2);padding:1px 5px;border-radius:4px;color:var(--acc);font-size:11px}
.retry-btn{
  margin-top:4px;background:var(--acc);color:#07090F;
  font-family:var(--font);font-weight:800;font-size:12px;
  border:none;border-radius:9px;padding:9px 18px;cursor:pointer;transition:.18s;
}
.retry-btn:hover{background:#d8ff70}

/* ── TOOLTIP ── */
.ctip{
  background:var(--s2);border:1px solid var(--border2);
  border-radius:10px;padding:9px 13px;
  font-family:var(--mono);font-size:11px;
  box-shadow:0 8px 24px rgba(0,0,0,.5);
}
.ctip-lbl{color:var(--muted);margin-bottom:5px;font-size:10px;letter-spacing:.06em}
.ctip-row{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.ctip-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.ctip-val{color:var(--txt)}

/* ── ANIMATIONS ── */
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bop{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.fade{animation:fadeUp .3s ease forwards}

/* ── TOOLTIP RECHARTS OVERRIDE ── */
.recharts-tooltip-wrapper{outline:none}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   SUB-COMPONENTS
═══════════════════════════════════════════════════════════════════════════ */
function healthColor(n) {
  if (n >= 70) return "#C8F464";
  if (n >= 40) return "#FFB347";
  return "#FF6B6B";
}

const CTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="ctip">
      <div className="ctip-lbl">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="ctip-row">
          <div className="ctip-dot" style={{ background: p.color }} />
          <span className="ctip-val">{p.name}: <strong>{p.value?.toLocaleString("fr-FR")}</strong></span>
        </div>
      ))}
    </div>
  );
};

function KCard({ meta, kpi }) {
  const val = kpi?.value ?? "–";
  const trend = kpi?.trend ?? 0;
  const trendClass = trend > 0 ? "up" : trend < 0 ? "dn" : "nt";
  const trendIcon  = trend > 0 ? "▲" : trend < 0 ? "▼" : "●";
  return (
    <div className="kcard">
      <div className="kcard-icon">{meta.icon}</div>
      <div className="kcard-lbl">{kpi?.label || meta.label}</div>
      <div className="kcard-val">
        {val}<span className="kcard-unit">{meta.unit}</span>
      </div>
      <div className={`kcard-trend ${trendClass}`}>
        {trendIcon} {Math.abs(trend)}%
      </div>
    </div>
  );
}

function ChartSection({ tabId, period, customData }) {
  const data = customData?.length >= 2
    ? customData.slice(-12).map(d => ({ name: d.name, valeur: d.valeur, objectif: d.objectif }))
    : generateChartData(tabId, period);

  // Determine which keys to chart
  const keys = Object.keys(data[0] || {}).filter(k => k !== "name");
  const colors = ["#C8F464", "#6B7280"];

  return (
    <div className="chart-box">
      <div className="chart-hd">
        <div className="chart-title">Évolution</div>
        <div className="chart-legend">
          {keys.map((k, i) => (
            <div key={k} className="chart-legend-item">
              <div className="chart-legend-dot" style={{ background: colors[i] || "#6B7280" }} />
              {k}
            </div>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 0, right: 8, left: -26, bottom: 0 }}>
          <defs>
            {keys.map((k, i) => (
              <linearGradient key={k} id={`g_${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={colors[i] || "#6B7280"} stopOpacity={0.22} />
                <stop offset="95%" stopColor={colors[i] || "#6B7280"} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: "#6B7280", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "#6B7280", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} />
          <Tooltip content={<CTooltip />} />
          {keys.map((k, i) => (
            <Area
              key={k}
              type="monotone"
              dataKey={k}
              stroke={colors[i] || "#6B7280"}
              strokeWidth={i === 0 ? 2.5 : 1.5}
              strokeDasharray={i === 0 ? undefined : "5 4"}
              fill={`url(#g_${k})`}
              dot={false}
              activeDot={{ r: 4, fill: colors[i] || "#6B7280" }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [tab, setTab]         = useState("ventes");
  const [period, setPeriod]   = useState("semaine");
  const [offset, setOffset]   = useState(0);
  const [state, setState]     = useState({ status: "loading", data: null, error: null });
  const [iaState, setIaState] = useState({ loading: false, result: "" });

  /* ── FETCH ── */
  const fetchAll = useCallback(async () => {
    setState({ status: "loading", data: null, error: null });
    try {
      const tabIds = Object.keys(TAB_GIDS);
      const results = await Promise.allSettled(
        tabIds.map(id => fetchTabCSV(TAB_GIDS[id]))
      );

      const parsed = {};
      let anyOk = false;
      results.forEach((r, i) => {
        const id = tabIds[i];
        if (r.status === "fulfilled" && r.value && !r.value.includes("not allowed")) {
          const rows = parseCSV(r.value);
          const res  = sheetRowsToKpis(rows, KPI_META[id] || []);
          if (res) { parsed[id] = res; anyOk = true; }
        }
      });

      if (!anyOk) {
        // All fetches failed or blocked
        setState({ status: "demo", data: demoData(), error: "network" });
        return;
      }

      // Fill missing tabs with empty
      tabIds.forEach(id => { if (!parsed[id]) parsed[id] = { kpis: {}, chartData: [] }; });

      // Try to get clientName from first sheet first row first cell
      let clientName = "Mon Client";
      const firstRows = results[0].status === "fulfilled"
        ? parseCSV(results[0].value) : [];
      if (firstRows[0]?.[0] && firstRows[0][0].length < 40 && !firstRows[0][0].toLowerCase().includes("kpi")) {
        clientName = firstRows[0][0];
      }

      const healthScore = calcHealthScore(parsed);
      setState({ status: "ok", data: { clientName, healthScore, ...parsed }, error: null });
    } catch (err) {
      setState({ status: "demo", data: demoData(), error: err.message });
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /* ── IA ANALYZE ── */
  const handleAnalyze = async () => {
    const d = state.data;
    if (!d) return;
    setIaState({ loading: true, result: "" });
    try {
      const sections = Object.entries(KPI_META).map(([tabId, metas]) => {
        const tabD = d[tabId]?.kpis || {};
        const lines = metas.map(m => {
          const k = tabD[m.key] || {};
          return `  ${m.label}: ${k.value ?? "–"} (${(k.trend ?? 0) > 0 ? "+" : ""}${k.trend ?? 0}%)`;
        });
        return `${tabId.toUpperCase()}:\n${lines.join("\n")}`;
      }).join("\n\n");

      const prompt = `Tu es un analyste marketing senior spécialisé dans la performance digitale des entrepreneurs en ligne.

Voici les KPIs de "${d.clientName}" (score de santé global : ${d.healthScore}/100) :

${sections}

Analyse ces données de façon structurée en 5 sections :

**1. 🎯 Performance globale**
Synthèse en 2-3 phrases du niveau de performance général.

**2. ✅ Points forts à capitaliser**
Les 2-3 indicateurs les plus positifs, avec pourquoi c'est important.

**3. ⚠️ Alertes & points d'attention**
Les 2-3 indicateurs préoccupants et leur impact potentiel.

**4. 🚀 3 recommandations concrètes**
Actions prioritaires, chiffrées et réalisables dans les 30 prochains jours.

**5. 📈 Projection N+1**
Prévision réaliste pour la prochaine période si les recommandations sont appliquées.

Sois direct, précis et orienté résultats.`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const json = await res.json();
      const text = json?.content?.map(b => b.text || "").join("") || "Erreur de réponse.";
      setIaState({ loading: false, result: text });
    } catch (e) {
      setIaState({ loading: false, result: `❌ Erreur lors de l'analyse : ${e.message}` });
    }
  };

  /* ── DERIVED ── */
  const { status, data, error } = state;
  const isLoading = status === "loading";
  const isDemo    = status === "demo";
  const tabData   = data?.[tab] || { kpis: {}, chartData: [] };
  const meta      = KPI_META[tab] || [];
  const hScore    = data?.healthScore ?? 0;
  const hColor    = healthColor(hScore);

  /* ── RENDER ── */
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      {/* HEADER */}
      <header className="hdr">
        <div className="hdr-inner">
          <div className="logo"><em>Flow</em><span>Board</span></div>

          <div className="hdr-mid">
            <div className="client-nm">{data?.clientName || "—"}</div>
            <div className="health-row">
              <span className="health-lbl">Santé</span>
              <div className="health-track">
                <div className="health-fill" style={{ width: `${hScore}%`, background: hColor }} />
              </div>
              <span className="health-num" style={{ color: hColor }}>{hScore}</span>
            </div>
          </div>

          <div className="nav-group">
            <button className="arr" onClick={() => setOffset(o => o - 1)} title="Période précédente">‹</button>
            <button className={`prd-btn${period === "semaine" ? " on" : ""}`} onClick={() => { setPeriod("semaine"); setOffset(0); }}>Sem.</button>
            <button className={`prd-btn${period === "mois" ? " on" : ""}`}    onClick={() => { setPeriod("mois");    setOffset(0); }}>Mois</button>
            <button className="arr" onClick={() => setOffset(o => Math.min(0, o + 1))} disabled={offset >= 0} title="Période suivante">›</button>
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="main">
        <div className="wrap">

          {/* TABS */}
          <div className="tabs-bar">
            {TABS.map(t => (
              <button key={t.id} className={`tab-btn${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {/* BANNERS */}
          {isDemo && error === "network" && (
            <div className="banner err">
              <span>⚠️</span>
              <span>
                Impossible d'accéder au Google Sheet. Vérifiez qu'il est bien&nbsp;
                <strong>publié sur le Web</strong> (Fichier → Partager → Publier sur le Web → CSV).{" "}
                <button onClick={fetchAll}>Réessayer</button>
              </span>
            </div>
          )}
          {isDemo && !error && (
            <div className="banner info">
              <span>📋</span>
              <span>Mode démo — Données de démonstration affichées. Publiez votre Google Sheet en CSV pour afficher vos vraies données.</span>
            </div>
          )}

          {/* CONTENT */}
          {isLoading ? (
            <div className="loading-scr">
              <div className="spinner" />
              <div className="load-txt">Chargement du Google Sheet…</div>
            </div>
          ) : tab === "ia" ? (
            /* ── IA TAB ── */
            <div className="ia-wrap fade">
              <div className="ia-head">🤖 Analyse IA</div>
              <div className="ia-sub">
                Claude analyse l'ensemble de vos KPIs et génère un rapport personnalisé :
                performance, alertes, recommandations et projection.
              </div>
              <div className="ia-actions">
                <button className="ia-btn" onClick={handleAnalyze} disabled={iaState.loading}>
                  {iaState.loading ? "⏳" : "✨"} Analyser mes KPIs
                </button>
                {iaState.result && (
                  <button className="ia-btn outline" onClick={() => setIaState(s => ({ ...s, result: "" }))}>
                    Effacer
                  </button>
                )}
              </div>
              {iaState.loading && (
                <div className="ia-loading">
                  <div className="dots">
                    <div className="dot" /><div className="dot" /><div className="dot" />
                  </div>
                  Analyse en cours…
                </div>
              )}
              {iaState.result && !iaState.loading && (
                <div className="ia-out" dangerouslySetInnerHTML={{
                  __html: iaState.result
                    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                    .replace(/\n/g, "<br/>")
                }} />
              )}
            </div>
          ) : (
            /* ── KPI TABS ── */
            <div className="fade" key={tab + period + offset}>
              <div className="period-lbl">📅 {periodLabel(period, offset)}</div>

              <div className="kpi-grid">
                {meta.map(m => (
                  <KCard key={m.key} meta={m} kpi={tabData.kpis[m.key]} />
                ))}
              </div>

              <ChartSection
                tabId={tab}
                period={period}
                customData={tabData.chartData}
              />
            </div>
          )}
        </div>
      </main>
    </>
  );
}
