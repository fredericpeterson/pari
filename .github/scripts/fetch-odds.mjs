// Récupère les cotes de plusieurs championnats (The Odds API, offre gratuite) et écrit odds.json.
// Lu par le tracker (même domaine, pas de CORS, clé jamais exposée dans le navigateur).
import fs from 'node:fs';

const KEY = process.env.ODDS_API_KEY;
const BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
// Championnats suivis : « clé The Odds API:code football-data.org », séparés par des virgules.
// Pour changer le 2e championnat, modifie ODDS_SPORTS dans odds.yml (ex. soccer_spain_la_liga:PD).
const SPORTS = (process.env.ODDS_SPORTS || 'soccer_france_ligue_one:FL1,soccer_epl:PL')
  .split(',').map(s => s.trim()).filter(Boolean).map(s => { const [sport, comp] = s.split(':'); return { sport, comp }; });
const OUT = process.env.OUT || 'odds.json';
const RESULTS = process.env.RESULTS || 'results.json';
const MIN_CREDITS = Number(process.env.MIN_CREDITS ?? 20);
const BOOKS = ['winamax_fr', 'betclic_fr', 'unibet_fr', 'pmu_fr', 'pinnacle'];
const KEEP_MS = 3 * 864e5;                              // garde les derniers relevés 3 jours (cote de clôture)

if (!KEY) { console.error('Secret ODDS_API_KEY manquant.'); process.exit(1); }

// --- même normalisation de noms que l'app ---
const STOP = new Set(['fc','afc','as','ac','sc','rc','ssc','us','og','ogc','cf','sv','vfb','vfl','fsv','tsg','de','du','la','le','fk','sco']);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).join(' ');
const isTeam = (name, t) => { const n = norm(name); return !!n && [t.name, t.shortName, t.tla].some(x => norm(x) === n); };

const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const results = read(RESULTS);
const prev = read(OUT) || { matches: {} };
const now = Date.now();
const fdOf = comp => results?.competitions?.[comp]?.matches || [];

// Garde-fou de quota : si le dernier relevé du mois courant montrait presque plus de crédits, on s'arrête.
if (prev.remaining != null && prev.updated && prev.updated.slice(0, 7) === new Date().toISOString().slice(0, 7)
    && Number(prev.remaining) < MIN_CREDITS) {
  console.log(`Quota presque épuisé (${prev.remaining} crédits restants) : appel annulé.`); process.exit(0);
}

const updated = new Date().toISOString();
const matches = {};
for (const [id, e] of Object.entries(prev.matches || {})) {          // relevés précédents encore utiles
  if (now - Date.parse(e.commence) < KEEP_MS) matches[id] = e;
}

let remaining = null, matched = 0, calls = 0;
for (const { sport, comp } of SPORTS) {
  const fd = fdOf(comp);
  // Économie de crédits : pas d'appel pour un championnat sans match dans les 48 prochaines heures.
  if (results) {
    const soon = fd.some(m => ['SCHEDULED', 'TIMED'].includes(m.status)
      && Date.parse(m.utcDate) > now && Date.parse(m.utcDate) - now < 48 * 36e5);
    if (!soon) { console.log(`${comp} : aucun match dans les 48 h, cotes non demandées (0 crédit).`); continue; }
  }
  const url = `${BASE}/sports/${sport}/odds/?apiKey=${encodeURIComponent(KEY)}&regions=eu&markets=h2h,totals&oddsFormat=decimal&bookmakers=${BOOKS.join(',')}`;
  const r = await fetch(url);
  calls++;
  if (r.headers.get('x-requests-remaining') != null) remaining = r.headers.get('x-requests-remaining');
  if (r.status === 401 || r.status === 403) { console.error('Clé The Odds API refusée.'); process.exit(1); }
  if (r.status === 429) { console.error('Quota The Odds API atteint ou trop de requêtes.'); process.exit(1); }
  if (!r.ok) { console.error(`${comp} (${sport}) : HTTP ${r.status}, championnat ignoré.`); continue; }
  const events = await r.json();
  console.log(`${comp} : ${events.length} événement(s) reçu(s), crédits restants : ${remaining}`);

  for (const ev of events) {
    const kick = Date.parse(ev.commence_time);
    if (kick <= now) continue;                                        // match commencé : on garde le dernier relevé d'avant-match
    const m = fd.find(x => isTeam(ev.home_team, x.homeTeam) && isTeam(ev.away_team, x.awayTeam)
      && Math.abs(Date.parse(x.utcDate) - kick) < 30 * 36e5);
    if (!m) { console.log(`Non rattaché (${comp}) : ${ev.home_team} - ${ev.away_team}`); continue; }
    const books = {};
    for (const b of ev.bookmakers || []) {
      const e = {};
      const h = (b.markets || []).find(x => x.key === 'h2h');
      if (h) {
        const get = n => h.outcomes.find(o => o.name === n)?.price;
        const home = get(ev.home_team), away = get(ev.away_team), draw = get('Draw');
        if (home && draw && away) e.h2h = [home, draw, away];
      }
      const t = (b.markets || []).find(x => x.key === 'totals');
      if (t) {
        const o = t.outcomes.find(x => x.name === 'Over' && x.point === 2.5);
        const u = t.outcomes.find(x => x.name === 'Under' && x.point === 2.5);
        if (o && u) { e.o25 = o.price; e.u25 = u.price; }
      }
      if (e.h2h || e.o25) books[b.key] = e;
    }
    matches[m.id] = { comp, commence: ev.commence_time, home: ev.home_team, away: ev.away_team, t: updated, books };
    matched++;
  }
}

if (!calls) { console.log('Aucun appel API effectué : odds.json inchangé.'); process.exit(0); }
if (remaining == null) remaining = prev.remaining ?? null;

const lines = Object.keys(matches).sort((a, b) => Date.parse(matches[a].commence) - Date.parse(matches[b].commence))
  .map(id => `    ${JSON.stringify(id)}: ${JSON.stringify(matches[id])}`);
fs.writeFileSync(OUT, `{\n  "updated": ${JSON.stringify(updated)},\n  "remaining": ${remaining == null ? 'null' : Number(remaining)},\n  "matches": {\n${lines.join(',\n')}\n  }\n}\n`);
console.log(`${matched} match(s) rattaché(s), ${calls} appel(s) API -> ${OUT}`);
if (remaining != null && Number(remaining) < MIN_CREDITS) console.log('⚠ Quota presque épuisé.');
