import React, { useState, useEffect, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  ChevronLeft, ChevronRight, DollarSign, ShoppingCart, ShoppingBag, Target,
  UserPlus, RefreshCw, CreditCard, Eye, MousePointerClick, Coins, TrendingUp,
  TrendingDown, Users, Radio, Heart, Image as ImageIcon, Send, MailOpen,
  UserMinus, Rocket, ClipboardList, Video, Sparkles, Loader2, AlertTriangle,
  Activity, Minus,
} from 'lucide-react';

/* ============================================================
   CONFIGURATION
   ============================================================ */

// Lien du Google Sheet publié au format CSV
// (Fichier > Partager > Publier sur le web > sélectionner la feuille > CSV)
const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRAvsQA7b32O3otkGs_pSKTZuq9DPZlFtHucaMn-yszmWDyAhjA5go-9vOuBtFGAQ/pub?output=csv';

// Modèle Claude utilisé pour l'onglet IA
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const COLORS = {
  bg: '#07090F',
  card: '#0D1120',
  cardBorder: '#1B2235',
  accent: '#C8F464',
  text: '#F5F7FA',
  textMuted: '#7A8499',
  danger: '#FF6B6B',
};

// ============================================================
// FORMAT ATTENDU DU GOOGLE SHEET (export CSV, format "long") :
//
// | Onglet  | Type    | Période | KPI                  | Valeur | Tendance |
// |---------|---------|---------|----------------------|--------|----------|
// | Ventes  | Semaine | S18     | Chiffre d'affaires   | 11200  | 3.4      |
// | Ventes  | Semaine | S18     | Commandes            | 95     | 1.2      |
// | Ventes  | Semaine | S19     | Chiffre d'affaires   | 12000  | 7.1      |
// | ...     |         |         |                      |        |          |
// | Global  | Semaine | S19     | Score santé          | 82     |          |
// | Global  | Semaine | S19     | Client               | Maison Soleil |   |
//
// - "Onglet" : Ventes / Pub / Réseaux / Emails / Lancements (+ "Global"
//   optionnel pour le score de santé et le nom du client)
// - "Type"   : Semaine ou Mois (pour le toggle de période)
// - "Période": identifiant de période (S18, S19, Janvier, ...). L'ordre
//   d'apparition dans le fichier = ordre chronologique (la dernière ligne
//   = période la plus récente).
// - "KPI"    : nom du KPI (jusqu'à 6 KPI distincts par onglet)
// - "Valeur" : valeur numérique du KPI pour cette période
// - "Tendance" (optionnelle) : variation en % ; si absente, elle est
//   calculée automatiquement vs la période précédente.
// ============================================================

const TABS = [
  { id: 'ventes', label: 'Ventes', emoji: '💰', sheetName: 'Ventes' },
  { id: 'pub', label: 'Pub', emoji: '📣', sheetName: 'Pub' },
  { id: 'reseaux', label: 'Réseaux', emoji: '📱', sheetName: 'Réseaux' },
  { id: 'emails', label: 'Emails', emoji: '📧', sheetName: 'Emails' },
  { id: 'lancements', label: 'Lancements', emoji: '🚀', sheetName: 'Lancements' },
];

const MAX_KPIS = 6;

// Mots-clés -> icône, pour associer automatiquement une icône à chaque KPI
// en fonction de son libellé (premier match = utilisé)
const ICON_RULES = [
  [['chiffre', 'revenu', "d'affaires", 'ca '], DollarSign],
  [['commande'], ShoppingCart],
  [['panier'], ShoppingBag],
  [['depense', 'budget', 'cout', 'cpc'], CreditCard],
  [['impression'], Eye],
  [['clic'], MousePointerClick],
  [['roas'], TrendingUp],
  [['ctr', 'conversion', 'taux', 'ouverture', 'presence', 'engagement'], Target],
  [['portee'], Radio],
  [['like', 'coeur', 'favori'], Heart],
  [['publication', 'post'], ImageIcon],
  [['email', 'envoye'], Send],
  [['ouverture mail', 'mail'], MailOpen],
  [['desabonnement'], UserMinus],
  [['nouveau', 'abonne', 'contact', 'inscription'], UserPlus],
  [['retour'], RefreshCw],
  [['webinaire', 'video', 'participant'], Video],
  [['lancement'], Rocket],
  [['client', 'utilisateur', 'abonnes'], Users],
];

function getKpiIcon(label, index) {
  const n = normalize(label);
  for (const [keywords, Icon] of ICON_RULES) {
    if (keywords.some((k) => n.includes(k))) return Icon;
  }
  const fallback = [DollarSign, TrendingUp, Users, Target, Eye, Heart];
  return fallback[index % fallback.length];
}

/* ============================================================
   HELPERS — parsing du CSV publié
   ============================================================ */

// Retire les accents + met en minuscule, pour comparer des libellés
function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Parser CSV simple, gère les champs entre guillemets (avec virgules / retours
// à la ligne échappés en "")
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // ignoré, géré via \n
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Convertit "1 234,56" / "12,5" / "-5.3%" / "—" -> number | null
// Gère le séparateur de milliers "," (style US, ex: "15,200") et le
// séparateur décimal "," (style FR, ex: "12,5")
function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/[€$%\s\u00A0]/g, '')
    .trim();
  if (s === '' || s === '-' || s === '—' || s === '–') return null;

  if (/^-?\d{1,3}(,\d{3})+$/.test(s)) {
    s = s.replace(/,/g, '');
  } else if (/,\d{1,2}$/.test(s) && !s.includes('.')) {
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }

  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function formatValue(value, unit) {
  if (value === null || value === undefined) return '—';
  const formatted = value.toLocaleString('fr-FR', {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  });
  if (unit === '€') return `${formatted} €`;
  if (unit === '%') return `${formatted} %`;
  return formatted;
}

// Devine une unité d'affichage à partir du libellé du KPI
function guessUnit(label) {
  const n = normalize(label || '');
  if (n.includes('taux') || n.includes('ctr') || n.includes('roas') || n.includes('%')) return '%';
  if (
    n.includes('chiffre') ||
    n.includes('revenu') ||
    n.includes('depense') ||
    n.includes('panier') ||
    n.includes('cpc')
  ) {
    return '€';
  }
  return '';
}

// Parse le CSV "long format" en une liste d'enregistrements
// { onglet, type, periode, kpi, valeur, tendance }
function parseSheetData(csvText) {
  const grid = parseCSV(csvText).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length < 2) {
    throw new Error('Le fichier CSV ne contient pas assez de lignes.');
  }

  const headerRowIndex = grid.findIndex((r) => r.some((c) => normalize(c) === 'onglet'));
  if (headerRowIndex === -1) {
    throw new Error("La colonne 'Onglet' est introuvable dans le Google Sheet.");
  }

  const header = grid[headerRowIndex];
  const idx = {
    onglet: header.findIndex((h) => normalize(h) === 'onglet'),
    type: header.findIndex((h) => normalize(h) === 'type'),
    periode: header.findIndex((h) =>
      ['periode', 'période', 'date', 'semaine', 'mois'].includes(normalize(h))
    ),
    kpi: header.findIndex((h) => ['kpi', 'indicateur', 'metrique', 'métrique'].includes(normalize(h))),
    valeur: header.findIndex((h) => ['valeur', 'value'].includes(normalize(h))),
    tendance: header.findIndex((h) =>
      ['tendance', 'variation', 'evolution', 'évolution'].includes(normalize(h))
    ),
  };

  if ([idx.onglet, idx.kpi, idx.valeur].some((i) => i === -1)) {
    throw new Error(
      "Colonnes attendues introuvables (Onglet, KPI, Valeur). Vérifie la structure du Google Sheet."
    );
  }

  const records = grid
    .slice(headerRowIndex + 1)
    .map((r) => ({
      onglet: (r[idx.onglet] || '').trim(),
      type: idx.type >= 0 ? (r[idx.type] || '').trim() : '',
      periode: idx.periode >= 0 ? (r[idx.periode] || '').trim() : '',
      kpi: (r[idx.kpi] || '').trim(),
      valeur: (r[idx.valeur] || '').trim(),
      tendance: idx.tendance >= 0 ? (r[idx.tendance] || '').trim() : '',
    }))
    .filter((r) => r.onglet && r.kpi);

  if (!records.length) {
    throw new Error('Aucune ligne de données trouvée sous les en-têtes.');
  }

  return records;
}

// Enregistrements d'un onglet, filtrés par granularité (Semaine / Mois)
function getTabRecords(records, tab, period) {
  const all = records.filter((r) => normalize(r.onglet) === normalize(tab.sheetName));
  const wanted = period === 'mois' ? 'mois' : 'semaine';
  const filtered = all.filter((r) => !r.type || normalize(r.type).startsWith(wanted.slice(0, 4)));
  return filtered.length ? filtered : all;
}

// Liste ordonnée des périodes (ordre d'apparition = ordre chronologique)
function getPeriods(records) {
  const periods = [];
  records.forEach((r) => {
    if (r.periode && !periods.includes(r.periode)) periods.push(r.periode);
  });
  return periods;
}

// Liste ordonnée des KPI distincts (max 6)
function getKpiLabels(records) {
  const labels = [];
  records.forEach((r) => {
    if (!labels.includes(r.kpi)) labels.push(r.kpi);
  });
  return labels.slice(0, MAX_KPIS);
}

function findRecord(records, periode, kpi) {
  return records.find((r) => r.periode === periode && r.kpi === kpi) || null;
}

/* ============================================================
   SOUS-COMPOSANTS
   ============================================================ */

function HealthBadge({ score }) {
  const display = score === null ? '—' : Math.round(score);
  let color = COLORS.accent;
  if (score !== null) {
    if (score < 40) color = COLORS.danger;
    else if (score < 70) color = '#FFD166';
  }
  return (
    <div className="health-badge" style={{ borderColor: color }}>
      <span className="health-score" style={{ color }}>
        {display}
      </span>
      <span className="health-label">/ 100</span>
    </div>
  );
}

function PeriodNav({ period, setPeriod, offset, setOffset, periodLabel, canGoNext, canGoPrev }) {
  return (
    <div className="period-row">
      <div className="period-toggle">
        <button
          className={period === 'semaine' ? 'active' : ''}
          onClick={() => {
            setPeriod('semaine');
            setOffset(0);
          }}
        >
          Semaine
        </button>
        <button
          className={period === 'mois' ? 'active' : ''}
          onClick={() => {
            setPeriod('mois');
            setOffset(0);
          }}
        >
          Mois
        </button>
      </div>
      <div className="period-nav">
        <button
          aria-label="Période précédente"
          disabled={!canGoPrev}
          onClick={() => setOffset((o) => o + 1)}
        >
          <ChevronLeft size={18} />
        </button>
        <span className="period-current">{periodLabel || '—'}</span>
        <button
          aria-label="Période suivante"
          disabled={!canGoNext}
          onClick={() => setOffset((o) => Math.max(0, o - 1))}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

function TabBar({ tabs, activeTab, setActiveTab }) {
  return (
    <nav className="tab-bar">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
          onClick={() => setActiveTab(t.id)}
        >
          <span className="tab-emoji">{t.emoji}</span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

function KpiCard({ icon: Icon, label, value, unit, trend, empty }) {
  let TrendIcon = Minus;
  let trendClass = 'neutral';
  if (trend !== null && trend !== undefined) {
    if (trend > 0.05) {
      TrendIcon = TrendingUp;
      trendClass = 'positive';
    } else if (trend < -0.05) {
      TrendIcon = TrendingDown;
      trendClass = 'negative';
    }
  }

  return (
    <div className={`kpi-card ${empty ? 'empty' : ''}`}>
      <div className="kpi-top">
        <span className="kpi-icon">
          <Icon size={18} />
        </span>
        {!empty && (
          <span className={`kpi-trend ${trendClass}`}>
            <TrendIcon size={13} />
            {trend !== null && trend !== undefined
              ? `${trend > 0 ? '+' : ''}${trend.toFixed(1)}%`
              : '—'}
          </span>
        )}
      </div>
      <div className="kpi-value">{empty ? '—' : formatValue(value, unit)}</div>
      <div className="kpi-label">{empty ? 'KPI à ajouter dans le Sheet' : label}</div>
    </div>
  );
}

function TrendChart({ data, accent }) {
  if (!data || !data.length) {
    return <div className="chart-empty">Pas assez de données pour afficher le graphique.</div>;
  }
  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="flowboardGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1B2235" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fill: COLORS.textMuted, fontSize: 11 }}
            axisLine={{ stroke: '#1B2235' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: COLORS.textMuted, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: COLORS.card,
              border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: 8,
              color: COLORS.text,
              fontSize: 12,
            }}
            labelStyle={{ color: COLORS.textMuted }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={accent}
            strokeWidth={2}
            fill="url(#flowboardGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function AIPanel({ summary, clientName, periodLabel }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const analyser = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const prompt = `Tu es un analyste business pour des clients d'assistantes virtuelles.
Voici les KPIs du client "${clientName}" pour la période "${periodLabel}" :

${summary}

Donne une analyse concise et actionnable en français, sous forme de 5 à 7 points :
- tendances marquantes (positives ou négatives)
- alertes éventuelles
- recommandations concrètes pour la semaine/mois à venir
Ton direct, professionnel, sans jargon inutile.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        throw new Error(`Erreur API Claude (${res.status})`);
      }

      const data = await res.json();
      const text = (data.content || [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n');

      setResult(text || "L'analyse n'a renvoyé aucun contenu.");
    } catch (e) {
      setError(e.message || "Erreur lors de l'analyse.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <Sparkles size={20} color={COLORS.accent} />
        <div>
          <h2>Analyse IA</h2>
          <p>Demande à Claude un résumé et des recommandations sur les KPIs actuels.</p>
        </div>
      </div>

      <button className="analyser-btn" onClick={analyser} disabled={loading}>
        {loading ? (
          <>
            <Loader2 size={16} className="spin" />
            Analyse en cours…
          </>
        ) : (
          <>
            <Sparkles size={16} />
            Analyser
          </>
        )}
      </button>

      {error && (
        <div className="ai-error">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {result && <div className="ai-result">{result}</div>}
    </div>
  );
}

/* ============================================================
   COMPOSANT PRINCIPAL
   ============================================================ */

export default function App() {
  const [records, setRecords] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [activeTab, setActiveTab] = useState(TABS[0].id);
  const [period, setPeriod] = useState('semaine');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Récupère le CSV en tentant d'abord un fetch direct, puis (en cas
    // d'échec, typiquement un blocage CORS du côté de Google) via un proxy
    // public qui rajoute les en-têtes CORS manquants.
    async function fetchCSV(url) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (directError) {
        try {
          const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
          const res = await fetch(proxyUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.text();
        } catch (proxyError) {
          throw new Error(
            "Échec du chargement direct et via proxy CORS. Vérifie que le lien est bien publié au format CSV (ouvre-le dans un onglet privé : tu dois voir du texte brut, pas une page de connexion Google)."
          );
        }
      }
    }

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const csvText = await fetchCSV(SHEET_URL);
        const parsed = parseSheetData(csvText);
        if (!cancelled) setRecords(parsed);
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Erreur inconnue lors du chargement.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentTab = TABS.find((t) => t.id === activeTab);

  // Enregistrements de l'onglet actif, filtrés par Semaine / Mois
  const tabRecords = useMemo(() => {
    if (!records) return [];
    return getTabRecords(records, currentTab, period);
  }, [records, currentTab, period]);

  const periods = useMemo(() => getPeriods(tabRecords), [tabRecords]);
  const kpiLabels = useMemo(() => getKpiLabels(tabRecords), [tabRecords]);

  const index = periods.length ? periods.length - 1 - offset : -1;
  const currentPeriode = index >= 0 ? periods[index] : null;
  const prevPeriode = index > 0 ? periods[index - 1] : null;
  const periodLabel = currentPeriode || '—';

  const canGoPrev = periods.length > 0 && index > 0;
  const canGoNext = offset > 0;

  // 6 cartes KPI pour l'onglet actif
  const kpiCards = useMemo(() => {
    return Array.from({ length: MAX_KPIS }).map((_, i) => {
      const label = kpiLabels[i];
      if (!label || !currentPeriode) {
        return { icon: getKpiIcon(label || '', i), label, value: null, unit: '', trend: null, empty: true };
      }
      const current = findRecord(tabRecords, currentPeriode, label);
      const value = current ? parseNumber(current.valeur) : null;

      let trend = current ? parseNumber(current.tendance) : null;
      if (trend === null && prevPeriode) {
        const prev = findRecord(tabRecords, prevPeriode, label);
        const prevValue = prev ? parseNumber(prev.valeur) : null;
        if (prevValue !== null && prevValue !== 0 && value !== null) {
          trend = ((value - prevValue) / Math.abs(prevValue)) * 100;
        }
      }

      return { icon: getKpiIcon(label, i), label, value, unit: guessUnit(label), trend, empty: false };
    });
  }, [kpiLabels, currentPeriode, prevPeriode, tabRecords]);

  // Graphique : évolution du 1er KPI sur les périodes disponibles
  const chartData = useMemo(() => {
    if (!periods.length || index < 0 || !kpiLabels.length) return [];
    const chartKpi = kpiLabels[0];
    const start = Math.max(0, index - 7);
    return periods.slice(start, index + 1).map((p) => {
      const rec = findRecord(tabRecords, p, chartKpi);
      return { name: p, value: rec ? parseNumber(rec.valeur) || 0 : 0 };
    });
  }, [periods, index, kpiLabels, tabRecords]);

  // Score de santé global (depuis l'onglet "Global", sinon heuristique)
  const healthScore = useMemo(() => {
    if (!records) return null;

    const globalRecords = records.filter((r) =>
      ['global', 'score', 'synthese', 'synthèse'].includes(normalize(r.onglet))
    );
    const scoreRec = globalRecords
      .filter((r) => normalize(r.kpi).includes('score'))
      .filter((r) => !r.type || normalize(r.type).startsWith(period.slice(0, 4)))
      .pop();
    if (scoreRec) {
      const v = parseNumber(scoreRec.valeur);
      if (v !== null) return Math.max(0, Math.min(100, v));
    }

    // Heuristique : moyenne des tendances du 1er KPI de chaque onglet
    const trends = TABS.map((t) => {
      const recs = getTabRecords(records, t, period);
      const ps = getPeriods(recs);
      const labels = getKpiLabels(recs);
      if (!ps.length || !labels.length) return null;
      const rec = findRecord(recs, ps[ps.length - 1], labels[0]);
      return rec ? parseNumber(rec.tendance) : null;
    }).filter((v) => v !== null);

    if (!trends.length) return null;
    const avg = trends.reduce((a, b) => a + b, 0) / trends.length;
    return Math.max(0, Math.min(100, Math.round(70 + avg * 2)));
  }, [records, period]);

  // Nom du client (depuis l'onglet "Global")
  const clientName = useMemo(() => {
    if (!records) return 'Client FlowBoard';
    const rec = records.find(
      (r) =>
        ['global', 'score', 'synthese', 'synthèse'].includes(normalize(r.onglet)) &&
        ['client', 'nom', 'nom du client'].includes(normalize(r.kpi))
    );
    return rec && rec.valeur ? rec.valeur : 'Client FlowBoard';
  }, [records]);

  // Résumé textuel pour l'IA (toutes les sections, période courante)
  const aiSummary = useMemo(() => {
    if (!records) return '';
    return TABS.map((tab) => {
      const recs = getTabRecords(records, tab, period);
      const ps = getPeriods(recs);
      const labels = getKpiLabels(recs);
      const i = ps.length ? ps.length - 1 - offset : -1;
      if (i < 0 || !labels.length) return `${tab.emoji} ${tab.label} : données indisponibles`;
      const cur = ps[i];
      const prev = i > 0 ? ps[i - 1] : null;

      const lines = labels
        .map((label) => {
          const rec = findRecord(recs, cur, label);
          const value = rec ? parseNumber(rec.valeur) : null;
          if (value === null) return null;
          let trend = rec ? parseNumber(rec.tendance) : null;
          if (trend === null && prev) {
            const prevRec = findRecord(recs, prev, label);
            const prevValue = prevRec ? parseNumber(prevRec.valeur) : null;
            if (prevValue !== null && prevValue !== 0) {
              trend = ((value - prevValue) / Math.abs(prevValue)) * 100;
            }
          }
          const trendTxt = trend !== null ? ` (${trend > 0 ? '+' : ''}${trend.toFixed(1)}%)` : '';
          return `  - ${label} : ${formatValue(value, guessUnit(label))}${trendTxt}`;
        })
        .filter(Boolean)
        .join('\n');

      return `${tab.emoji} ${tab.label} (${cur}) :\n${lines}`;
    }).join('\n\n');
  }, [records, period, offset]);

  return (
    <div className="app">
      <style>{`
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }

        .app {
          background: ${COLORS.bg};
          color: ${COLORS.text};
          min-height: 100vh;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          padding-bottom: 32px;
        }

        .container {
          max-width: 430px;
          margin: 0 auto;
          padding: 0 16px;
        }

        /* ===== Header ===== */
        .header {
          position: sticky;
          top: 0;
          z-index: 20;
          background: rgba(7, 9, 15, 0.9);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid ${COLORS.cardBorder};
          padding: 14px 0;
        }

        .header-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .header-info {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .header-info h1 {
          font-size: 16px;
          font-weight: 700;
          margin: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .header-sub {
          font-size: 11px;
          color: ${COLORS.textMuted};
          margin: 0;
        }

        .health-badge {
          display: flex;
          align-items: baseline;
          gap: 3px;
          border: 1.5px solid ${COLORS.accent};
          border-radius: 999px;
          padding: 6px 12px;
          flex-shrink: 0;
        }

        .health-score {
          font-size: 18px;
          font-weight: 800;
          line-height: 1;
        }

        .health-label {
          font-size: 11px;
          color: ${COLORS.textMuted};
        }

        .period-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: 12px;
        }

        .period-toggle {
          display: flex;
          background: ${COLORS.card};
          border: 1px solid ${COLORS.cardBorder};
          border-radius: 999px;
          padding: 3px;
        }

        .period-toggle button {
          border: none;
          background: transparent;
          color: ${COLORS.textMuted};
          font-size: 12px;
          font-weight: 600;
          padding: 6px 14px;
          border-radius: 999px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .period-toggle button.active {
          background: ${COLORS.accent};
          color: #07090F;
        }

        .period-nav {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: ${COLORS.textMuted};
        }

        .period-nav button {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          border: 1px solid ${COLORS.cardBorder};
          background: ${COLORS.card};
          color: ${COLORS.text};
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }

        .period-nav button:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }

        .period-current {
          min-width: 76px;
          text-align: center;
          font-weight: 600;
          color: ${COLORS.text};
        }

        /* ===== Tabs ===== */
        .tab-bar {
          display: flex;
          gap: 6px;
          overflow-x: auto;
          padding: 14px 0 4px;
          margin: 0 -16px;
          padding-left: 16px;
          padding-right: 16px;
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        .tab-bar::-webkit-scrollbar { display: none; }

        .tab-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
          background: ${COLORS.card};
          border: 1px solid ${COLORS.cardBorder};
          color: ${COLORS.textMuted};
          font-size: 13px;
          font-weight: 600;
          padding: 9px 14px;
          border-radius: 999px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .tab-btn.active {
          background: ${COLORS.accent};
          color: #07090F;
          border-color: ${COLORS.accent};
        }

        .tab-emoji { font-size: 15px; }

        /* ===== Content ===== */
        .content { padding-top: 16px; }

        .section-title {
          font-size: 13px;
          font-weight: 700;
          color: ${COLORS.textMuted};
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin: 0 0 10px;
        }

        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }

        .kpi-card {
          background: ${COLORS.card};
          border: 1px solid ${COLORS.cardBorder};
          border-radius: 14px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .kpi-card.empty {
          border-style: dashed;
          opacity: 0.55;
        }

        .kpi-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .kpi-icon {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          background: rgba(200, 244, 100, 0.1);
          color: ${COLORS.accent};
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .kpi-card.empty .kpi-icon {
          background: rgba(122, 132, 153, 0.1);
          color: ${COLORS.textMuted};
        }

        .kpi-trend {
          display: flex;
          align-items: center;
          gap: 3px;
          font-size: 12px;
          font-weight: 700;
        }

        .kpi-trend.positive { color: ${COLORS.accent}; }
        .kpi-trend.negative { color: ${COLORS.danger}; }
        .kpi-trend.neutral { color: ${COLORS.textMuted}; }

        .kpi-value {
          font-size: 22px;
          font-weight: 800;
          line-height: 1.1;
        }

        .kpi-label {
          font-size: 12px;
          color: ${COLORS.textMuted};
        }

        /* ===== Chart ===== */
        .chart-section {
          margin-top: 18px;
          background: ${COLORS.card};
          border: 1px solid ${COLORS.cardBorder};
          border-radius: 14px;
          padding: 16px;
        }

        .chart-wrap {
          width: 100%;
          height: 200px;
        }

        .chart-empty {
          height: 120px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: ${COLORS.textMuted};
          font-size: 13px;
          text-align: center;
        }

        /* ===== AI Panel ===== */
        .ai-panel {
          background: ${COLORS.card};
          border: 1px solid ${COLORS.cardBorder};
          border-radius: 14px;
          padding: 18px;
        }

        .ai-header {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          margin-bottom: 16px;
        }

        .ai-header h2 {
          font-size: 15px;
          margin: 0 0 4px;
        }

        .ai-header p {
          font-size: 12px;
          color: ${COLORS.textMuted};
          margin: 0;
          line-height: 1.4;
        }

        .analyser-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 100%;
          background: ${COLORS.accent};
          color: #07090F;
          font-size: 14px;
          font-weight: 700;
          border: none;
          border-radius: 10px;
          padding: 12px 18px;
          cursor: pointer;
          transition: opacity 0.15s ease;
        }

        .analyser-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        .spin {
          animation: flowboard-spin 1s linear infinite;
        }
        @keyframes flowboard-spin {
          to { transform: rotate(360deg); }
        }

        .ai-error {
          margin-top: 14px;
          display: flex;
          gap: 8px;
          align-items: flex-start;
          background: rgba(255, 107, 107, 0.08);
          border: 1px solid rgba(255, 107, 107, 0.3);
          color: ${COLORS.danger};
          font-size: 13px;
          border-radius: 10px;
          padding: 12px;
        }

        .ai-result {
          margin-top: 16px;
          font-size: 13px;
          line-height: 1.6;
          color: ${COLORS.text};
          white-space: pre-wrap;
          border-top: 1px solid ${COLORS.cardBorder};
          padding-top: 14px;
        }

        /* ===== Loading / Error states ===== */
        .state-screen {
          min-height: 60vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 14px;
          padding: 32px 20px;
        }

        .state-screen h2 {
          font-size: 17px;
          margin: 0;
        }

        .state-screen p {
          font-size: 13px;
          color: ${COLORS.textMuted};
          margin: 0;
          max-width: 320px;
          line-height: 1.5;
        }

        .state-icon {
          width: 52px;
          height: 52px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: ${COLORS.card};
          border: 1px solid ${COLORS.cardBorder};
        }

        .error-link {
          margin-top: 4px;
          font-size: 12px;
          font-family: monospace;
          color: ${COLORS.accent};
          background: rgba(200, 244, 100, 0.08);
          border: 1px solid rgba(200, 244, 100, 0.2);
          border-radius: 8px;
          padding: 8px 12px;
          word-break: break-all;
          max-width: 100%;
        }

        /* ===== Desktop layout (≥ 768px) ===== */
        @media (min-width: 768px) {
          .container {
            max-width: 1200px;
            padding: 0 32px;
          }

          .header-info h1 { font-size: 19px; }

          .tab-bar {
            padding-top: 18px;
            justify-content: center;
          }

          .tab-btn {
            font-size: 14px;
            padding: 10px 20px;
          }

          .kpi-grid {
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
          }

          .kpi-card { padding: 18px; }
          .kpi-value { font-size: 26px; }

          .chart-section {
            margin-top: 24px;
            padding: 24px;
          }

          .chart-wrap { height: 320px; }

          .ai-panel { padding: 28px; max-width: 720px; margin: 0 auto; }
        }
      `}</style>

      <div className="container">
        {/* HEADER */}
        <header className="header">
          <div className="header-top">
            <div className="header-info">
              <Activity size={20} color={COLORS.accent} />
              <div>
                <h1>{clientName}</h1>
                <p className="header-sub">FlowBoard — Tableau de bord KPI</p>
              </div>
            </div>
            <HealthBadge score={healthScore} />
          </div>

          {!loading && !error && (
            <PeriodNav
              period={period}
              setPeriod={setPeriod}
              offset={offset}
              setOffset={setOffset}
              periodLabel={periodLabel}
              canGoPrev={canGoPrev}
              canGoNext={canGoNext}
            />
          )}

          {!loading && !error && (
            <TabBar
              tabs={[...TABS, { id: 'ia', label: 'IA', emoji: '🤖' }]}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
            />
          )}
        </header>

        {/* CONTENT */}
        <main className="content">
          {loading && (
            <div className="state-screen">
              <div className="state-icon">
                <Loader2 size={24} className="spin" color={COLORS.accent} />
              </div>
              <h2>Chargement des données…</h2>
              <p>Récupération des KPIs depuis le Google Sheet du client.</p>
            </div>
          )}

          {!loading && error && (
            <div className="state-screen">
              <div className="state-icon">
                <AlertTriangle size={24} color={COLORS.danger} />
              </div>
              <h2>Impossible de charger les données</h2>
              <p>
                Une erreur est survenue lors de la récupération du Google Sheet.
                Vérifie que le lien ci-dessous correspond bien à un document
                publié au format CSV ("Publier sur le web") et que sa structure
                contient les colonnes Onglet / KPI / Valeur.
              </p>
              <div className="error-link">{SHEET_URL}</div>
              <p style={{ marginTop: 4 }}>Détail technique : {error}</p>
            </div>
          )}

          {!loading && !error && activeTab !== 'ia' && (
            <>
              <h2 className="section-title">
                {currentTab.emoji} {currentTab.label} — {periodLabel}
              </h2>
              <div className="kpi-grid">
                {kpiCards.map((c, i) => (
                  <KpiCard
                    key={i}
                    icon={c.icon}
                    label={c.label}
                    value={c.value}
                    unit={c.unit}
                    trend={c.trend}
                    empty={c.empty}
                  />
                ))}
              </div>
              <div className="chart-section">
                <h2 className="section-title">
                  Évolution — {kpiLabels[0] || 'KPI principal'}
                </h2>
                <TrendChart data={chartData} accent={COLORS.accent} />
              </div>
            </>
          )}

          {!loading && !error && activeTab === 'ia' && (
            <AIPanel summary={aiSummary} clientName={clientName} periodLabel={periodLabel} />
          )}
        </main>
      </div>
    </div>
  );
}
