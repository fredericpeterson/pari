// Récupère les scores récents des 5 grands championnats (football-data.org)
// et écrit pari/results.json, lu ensuite par le tracker (même domaine, pas de CORS).
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API = process.env.API_BASE || 'https://api.football-data.org/v4';
const OUT = process.env.OUT || 'results.json';
const PAUSE = Number(process.env.SLEEP_MS ?? 7000); // offre gratuite : 10 requêtes/min
const COMPS = ['FL1', 'PL', 'PD', 'SA', 'BL1'];

if (!TOKEN) { console.error('Secret FOOTBALL_DATA_TOKEN manquant.'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const team = t => ({ id: t.id, name: t.name, shortName: t.shortName, tla: t.tla });

async function api(p) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(API + p, { headers: { 'X-Auth-Token': TOKEN } });
    if (r.status === 429) { console.log('429, pause 30 s'); await sleep(30000); continue; }
    if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${p} -> limite de débit`);
}

let old = { competitions: {} };
try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
const result = { updated: new Date().toISOString(), competitions: { ...(old.competitions || {}) } };

const today = new Date();
// 2 fenêtres de 10 jours (limite de l'API) : de J-19 à aujourd'hui
const windows = [[addDays(today, -19), addDays(today, -10)], [addDays(today, -9), today]];
let okCount = 0;

for (const code of COMPS) {
  try {
    const teams = (await api(`/competitions/${code}/teams`)).teams.map(team);
    await sleep(PAUSE);
    const matches = [];
    for (const [from, to] of windows) {
      const d = await api(`/competitions/${code}/matches?dateFrom=${iso(from)}&dateTo=${iso(to)}`);
      for (const m of d.matches || []) {
        matches.push({
          id: m.id, utcDate: m.utcDate, status: m.status,
          homeTeam: team(m.homeTeam), awayTeam: team(m.awayTeam),
          score: { fullTime: { home: m.score?.fullTime?.home ?? null, away: m.score?.fullTime?.away ?? null } },
        });
      }
      await sleep(PAUSE);
    }
    result.competitions[code] = { teams, matches };
    okCount++;
    console.log(`${code} : ${teams.length} équipes, ${matches.length} matchs`);
  } catch (e) {
    console.error(`${code} : ${e.message} (données précédentes conservées)`);
  }
}

// Mise en forme lisible : une équipe ou un match par ligne, matchs triés par date.
function format(r) {
  const row = o => '      ' + JSON.stringify(o);
  const comps = Object.keys(r.competitions).sort().map(code => {
    const c = r.competitions[code];
    const teams = [...(c.teams || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const matches = [...(c.matches || [])].sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));
    return `    ${JSON.stringify(code)}: {\n      "teams": [\n${teams.map(x => '  ' + row(x)).join(',\n')}\n      ],\n      "matches": [\n${matches.map(x => '  ' + row(x)).join(',\n')}\n      ]\n    }`;
  });
  return `{\n  "updated": ${JSON.stringify(r.updated)},\n  "competitions": {\n${comps.join(',\n')}\n  }\n}\n`;
}

if (!okCount) { console.error('Aucune compétition récupérée.'); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, format(result));
// Version lisible par un humain, à côté de results.json (non utilisée par l'app).
const NAMES = { FL1: 'Ligue 1', PL: 'Premier League', PD: 'La Liga', SA: 'Serie A', BL1: 'Bundesliga' };
const STATUS = { FINISHED: 'terminé', SCHEDULED: 'à venir', TIMED: 'à venir', IN_PLAY: 'en cours', PAUSED: 'mi-temps', POSTPONED: 'reporté', SUSPENDED: 'suspendu', CANCELLED: 'annulé', AWARDED: 'décidé sur tapis vert' };
const nm = t => t.shortName || t.name;
const txt = [`Scores mis à jour le ${result.updated}`, ''];
for (const code of Object.keys(result.competitions).sort()) {
  const ms = [...(result.competitions[code].matches || [])].sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));
  txt.push(`== ${NAMES[code] || code} (${ms.length} matchs) ==`);
  for (const m of ms) {
    const f = m.score.fullTime, s = f.home != null && f.away != null ? `${f.home}-${f.away}` : 'vs';
    txt.push(`${m.utcDate.slice(0, 10)}  ${nm(m.homeTeam)} ${s} ${nm(m.awayTeam)}  (${STATUS[m.status] || m.status})`);
  }
  txt.push('');
}
fs.writeFileSync(path.join(path.dirname(OUT), 'scores.txt'), txt.join('\n'));
console.log('Écrit', OUT);
