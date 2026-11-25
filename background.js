/* ═══════════════════════════════════════════
   MatchDay – Background Service Worker
   Multi-API Architecture:
     1. OpenFootAPI (openfootapi.com)
     2. Football-Data.org (api.football-data.org)
   Provider-Scoped Caching, Rate-Limit Defense & Confirmed Match Lifecycle
   ═══════════════════════════════════════════ */

try {
  importScripts('storage.js');
  importScripts('crests.js');
} catch (e) {
  console.warn('Failed to load shared settings or bundled crests:', e);
}

const PROVIDERS = {
  openfoot: {
    id: 'openfoot',
    name: 'OpenFootAPI',
    baseUrl: 'https://openfootapi.com/v1'
  },
  football_data: {
    id: 'football_data',
    name: 'Football-Data.org',
    baseUrl: 'https://api.football-data.org/v4'
  }
};

async function getActiveProvider() {
  const { provider, apiKey } = await MatchDayStorage.getSettings();
  return { provider, apiKey };
}

const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/123'; // free tier key
const MATCHES_CACHE_TTL      = 3  * 60 * 1000;           // 3 minutes fresh cache
const STALE_FALLBACK_TTL     = 24 * 60 * 60 * 1000;      // 24 hours stale fallback
const TEAMS_CACHE_TTL        = 14 * 24 * 60 * 60 * 1000; // 14 days
const HOOFOOT_INDEX_TTL      = 30 * 60 * 1000;            // 30 minutes
const CRESTS_CACHE_TTL       = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── League definitions ───────────────────
// Verified real IDs from GET /v1/competitions
const LEAGUES = {
  CL:  { name: 'Champions League',      country: 'Europe',        emoji: '🏆', priority: 1,  apiId: 'comp_uefa_champions_league', hoofootSlug: 'champions-league' },
  PL:  { name: 'Premier League',        country: 'England',       emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', priority: 2,  apiId: 'comp_premier_league_eng',    hoofootSlug: 'premier-league' },
  PD:  { name: 'La Liga',               country: 'Spain',         emoji: '🇪🇸', priority: 3,  apiId: 'comp_laliga_es',             hoofootSlug: 'la-liga' },
  BL1: { name: 'Bundesliga',            country: 'Germany',       emoji: '🇩🇪', priority: 4,  apiId: 'comp_bundesliga_de',         hoofootSlug: 'bundesliga' },
  SA:  { name: 'Serie A',               country: 'Italy',         emoji: '🇮🇹', priority: 5,  apiId: 'comp_serie_a_it',           hoofootSlug: 'serie-a' },
  FL1: { name: 'Ligue 1',               country: 'France',        emoji: '🇫🇷', priority: 6,  apiId: 'comp_ligue_1_fr',           hoofootSlug: 'ligue-1' },
  ELC: { name: 'Championship',          country: 'England',       emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', priority: 7,  apiId: 'comp_championship_eng',      hoofootSlug: 'championship' },
  PPL: { name: 'Primeira Liga',         country: 'Portugal',      emoji: '🇵🇹', priority: 8,  apiId: 'comp_primeira_liga_pt',     hoofootSlug: 'primeira-liga' },
  DED: { name: 'Eredivisie',            country: 'Netherlands',   emoji: '🇳🇱', priority: 9,  apiId: 'comp_eredivisie_nl',        hoofootSlug: 'eredivisie' },
  BSA: { name: 'Série A',               country: 'Brazil',        emoji: '🇧🇷', priority: 10, apiId: 'comp_brasileirao_bra',      hoofootSlug: 'brasileirao' },
  EC:  { name: 'European Championship', country: 'Europe',        emoji: '🇪🇺', priority: 11, apiId: 'comp_uefa_nations_league',  hoofootSlug: 'euro-cup' },
  WC:  { name: 'FIFA World Cup',        country: 'International', emoji: '🌍', priority: 12, apiId: 'comp_fifa_world_cup',       hoofootSlug: 'fifa-world-cup-2026' }
};

// Reverse map: OpenFootAPI comp ID → our internal short code
const API_ID_TO_CODE = Object.fromEntries(
  Object.entries(LEAGUES).map(([code, meta]) => [meta.apiId, code])
);

// ── TheSportsDB league name mapping (for batch crest fetching) ────────────
const TSDB_LEAGUE_NAMES = {
  PL:  'English Premier League',
  PD:  'Spanish La Liga',
  BL1: 'German Bundesliga',
  SA:  'Italian Serie A',
  FL1: 'French Ligue 1',
  ELC: 'English Championship',
  PPL: 'Portuguese Primeira Liga',
  DED: 'Dutch Eredivisie',
  BSA: 'Brazilian Serie A',
};

// ── In-memory crest map: lowercase teamName → logo URL ───────────────────
// Populated lazily; shared across the service worker's lifetime.
const _crestMemCache = new Map();

// Normalise a name to a cache key (strip accents, lowercase, collapse spaces, handle Scandinavian chars)
function normaliseName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[/\\_\-\.]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// Get crest URL from memory, bundled catalog, or storage (0ms, 0 network)
function lookupCrest(teamName) {
  if (!teamName) return '';
  const key = normaliseName(teamName);
  if (_crestMemCache.has(key)) return _crestMemCache.get(key);

  // Check bundled ESPN crest catalog
  if (typeof BUNDLED_CRESTS !== 'undefined' && BUNDLED_CRESTS[key]) {
    const url = BUNDLED_CRESTS[key];
    _crestMemCache.set(key, url);
    return url;
  }
  return '';
}

// Batch-fetch crests for one domestic league from TheSportsDB.
// Returns a map: normalisedName → crestUrl
async function fetchLeagueCrests(competitionCode) {
  const leagueName = TSDB_LEAGUE_NAMES[competitionCode];
  if (!leagueName) return {};

  const cacheKey = `crests_league_${competitionCode}`;
  const cached = await getCachedWithStale(cacheKey, CRESTS_CACHE_TTL);
  if (cached && !cached.isStale && cached.value && Object.keys(cached.value).length > 0) {
    Object.entries(cached.value).forEach(([k, v]) => _crestMemCache.set(k, v));
    return cached.value;
  }

  try {
    const res = await fetch(
      `${TSDB_BASE}/search_all_teams.php?l=${encodeURIComponent(leagueName)}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return cached?.value || {};
    const json = await res.json();
    const teams = json.teams || [];
    const map = {};
    for (const t of teams) {
      const badge = t.strBadge || t.strTeamBadge || '';
      if (!badge) continue;
      const key = normaliseName(t.strTeam || '');
      if (key) { map[key] = badge; _crestMemCache.set(key, badge); }
      if (t.strTeamShort) {
        const k2 = normaliseName(t.strTeamShort);
        if (k2) { map[k2] = badge; _crestMemCache.set(k2, badge); }
      }
      if (t.strTeamAlternate) {
        const k3 = normaliseName(t.strTeamAlternate);
        if (k3) { map[k3] = badge; _crestMemCache.set(k3, badge); }
      }
    }
    if (Object.keys(map).length > 0) await setCache(cacheKey, map);
    return map;
  } catch (e) {
    console.warn(`TSDB league crest fetch failed for ${competitionCode}:`, e.message);
    return cached?.value || {};
  }
}

// Individual team crest lookup by name (fallback if not in bundled catalog)
const _pendingCrestLookups = new Map();
async function fetchTeamCrest(teamName) {
  const key = normaliseName(teamName);
  if (!key) return null;

  // 1. Check local lookup first
  const existing = lookupCrest(teamName);
  if (existing) return existing;

  // 2. Check storage
  const storageKey = `crest_name_${key.replace(/\s/g, '_')}`;
  const cached = await getCachedWithStale(storageKey, CRESTS_CACHE_TTL);
  if (cached && !cached.isStale && cached.value) {
    _crestMemCache.set(key, cached.value);
    return cached.value;
  }

  // Deduplicate concurrent lookups for the same team
  if (_pendingCrestLookups.has(key)) return _pendingCrestLookups.get(key);

  const cleanName = (teamName || '').replace(/[/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const promise = (async () => {
    try {
      const res = await fetch(
        `${TSDB_BASE}/searchteams.php?t=${encodeURIComponent(cleanName)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return null;
      const json = await res.json();
      const badge = json?.teams?.[0]?.strBadge || json?.teams?.[0]?.strTeamBadge || null;
      if (badge) {
        _crestMemCache.set(key, badge);
        await setCache(storageKey, badge);
      }
      return badge;
    } catch (e) {
      return null;
    } finally {
      _pendingCrestLookups.delete(key);
    }
  })();
  _pendingCrestLookups.set(key, promise);
  return promise;
}

// Hydrate crest URLs for a list of matches.
// 1. First check bundled catalog + memory cache (covers all CL & major league clubs instantly).
// 2. For remaining unknown clubs, safely query TSDB sequentially.
async function hydrateCrests(matches) {
  if (!matches || matches.length === 0) return;

  // Step 1: Instant lookup from bundled catalog (covers 99%+ of matches)
  const stillMissing = [];
  for (const m of matches) {
    if (!m.homeTeam.crest) {
      m.homeTeam.crest = lookupCrest(m.homeTeam?.name) || lookupCrest(m.homeTeam?.shortName) || '';
    }
    if (!m.awayTeam.crest) {
      m.awayTeam.crest = lookupCrest(m.awayTeam?.name) || lookupCrest(m.awayTeam?.shortName) || '';
    }
    if (!m.homeTeam.crest && m.homeTeam?.name) stillMissing.push(m.homeTeam);
    if (!m.awayTeam.crest && m.awayTeam?.name) stillMissing.push(m.awayTeam);
  }

  if (stillMissing.length === 0) return;

  // Step 2: For any uncatalogued clubs, fetch one-by-one with 200ms pause to respect rate limits
  for (const team of stillMissing.slice(0, 10)) {
    try {
      const url = await fetchTeamCrest(team.name);
      if (url) team.crest = url;
    } catch (_) { /* ignore */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── Local Date Helper ────────────────────
function formatLocalDate(d) {
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ── Sliding UTC Window for Local Timezones ──
function getUtcRangeForLocalDate(dateFrom, dateTo) {
  const dFrom = new Date(dateFrom + 'T00:00:00');
  dFrom.setDate(dFrom.getDate() - 1);
  const dTo = new Date(dateTo + 'T00:00:00');
  dTo.setDate(dTo.getDate() + 1);

  // OpenFootAPI has no documented hard day cap, but keep ≤10 days to be safe
  const diffDays = Math.round((dTo - dFrom) / (1000 * 60 * 60 * 24));
  let isTruncated = false;
  if (diffDays > 10) {
    dTo.setTime(dFrom.getTime() + 9 * 24 * 60 * 60 * 1000);
    isTruncated = true;
  }

  return {
    apiFrom: formatLocalDate(dFrom),
    apiTo:   formatLocalDate(dTo),
    isTruncated
  };
}

// ── Slugify Helper (VIPBox / General ASCII normalise) ──
function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/\b(fc|cf|sc|afc|bsc|sv|ac|rc|sk|cd|as|ss|vfb|tsv|rcd|ud|sd)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Normalize team name to key tokens for fuzzy matching ──
function teamTokens(name) {
  if (!name) return [];
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/\b(fc|cf|sc|afc|bsc|sv|ac|rc|sk|cd|rcd|ud|sd|club|de|la|le|les|el|los|las)\b/gi, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

// ── Score how well a HooFoot slug matches a home+away pair ──
function slugMatchScore(slug, homeToks, awayToks) {
  const s = slug.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const homeHits = homeToks.filter(t => s.includes(t)).length;
  const awayHits = awayToks.filter(t => s.includes(t)).length;
  if (!homeToks.length || !awayToks.length) return 0;
  if (!homeHits || !awayHits) return 0;
  return (homeHits / homeToks.length) + (awayHits / awayToks.length);
}

// ── Multi-Provider API Fetch Helper ─────────
async function apiFetch(endpoint, params = {}) {
  const { provider, apiKey } = await getActiveProvider();
  if (!apiKey) throw new Error('NO_API_KEY');

  const config = PROVIDERS[provider] || PROVIDERS.openfoot;
  const url = new URL(`${config.baseUrl}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  });

  const headers = (provider === 'football_data')
    ? { 'X-Auth-Token': apiKey }
    : { 'Authorization': `Bearer ${apiKey}` };

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    if (response.status === 429) throw new Error('RATE_LIMIT');
    if (response.status === 401 || response.status === 403) throw new Error('INVALID_API_KEY');
    throw new Error(`API_ERROR_${response.status}`);
  }

  return response.json();
}

// ── Cache Helper with Stale-While-Revalidate ──
async function getCachedWithStale(key, ttl = MATCHES_CACHE_TTL) {
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const { value, timestamp } = data[key];
  const isStale = (Date.now() - timestamp > ttl);
  return { value, isStale, timestamp };
}

async function setCache(key, value) {
  // ── Fix 9: Quota guard — evict oldest entries if approaching 8 MB ──
  try {
    const bytesUsed = await chrome.storage.local.getBytesInUse(null);
    if (bytesUsed > 8 * 1024 * 1024) {
      const all = await chrome.storage.local.get(null);
      const evictable = Object.keys(all)
        .filter(k => k.startsWith('date_') || k.startsWith('comp_') ||
          k.startsWith('matches_') || k.startsWith('master_matches_') ||
          k.startsWith('hoofoot_index_') || k.startsWith('crests_league_'))
        .sort((a, b) => (all[a]?.timestamp || 0) - (all[b]?.timestamp || 0));
      if (evictable.length > 0) {
        await chrome.storage.local.remove(evictable.slice(0, Math.ceil(evictable.length / 2)));
      }
    }
  } catch (_) { /* non-fatal */ }

  await chrome.storage.local.set({ [key]: { value, timestamp: Date.now() } });
}

// ── Sync Live Schedule from VIPBox ───────
async function getVipboxSchedule() {
  const { vipboxBase } = await MatchDayStorage.getSettings();
  const sourceHost = new URL(vipboxBase).host;
  const cacheKey = `vipbox_schedule_${sourceHost}`;
  const cached = await getCachedWithStale(cacheKey, 10 * 60 * 1000);
  if (cached && !cached.isStale && cached.value) return cached.value;

  try {
    const res = await fetch(`${vipboxBase}/football-schedule`, { cache: 'no-store' });
    if (!res.ok) return cached?.value || [];
    const html = await res.text();
    const list = [];

    // Try current and fallback path patterns (Fix B12 resilience)
    const patterns = [
      /href="(\/onair\/football\/([^"]+))"/g,
      /href="(\/football\/([^"]+))"/g
    ];
    for (const regex of patterns) {
      let m;
      while ((m = regex.exec(html)) !== null) {
        const url = new URL(m[1], vipboxBase).href;
        if (MatchDayStorage.isAllowedMatchUrl('vipbox', url, vipboxBase)) {
          list.push({ url, slug: m[2] });
        }
      }
      if (list.length > 0) break;
    }

    if (list.length === 0) {
      await chrome.storage.local.set({ vipboxScrapeFailure: true });
      console.warn('VIPBox: scrape returned 0 results — layout may have changed.');
      return cached?.value || [];
    }

    await chrome.storage.local.set({ vipboxScrapeFailure: false });
    await setCache(cacheKey, list);
    return list;
  } catch (e) {
    console.warn('VIPBox live schedule fetch failed:', e.message);
    return cached?.value || [];
  }
}

// ── Fetch & Cache HooFoot League Index ───
async function getHoofootLeagueIndex(leagueSlug) {
  const { hoofootBase } = await MatchDayStorage.getSettings();
  const sourceHost = new URL(hoofootBase).host;
  const cacheKey = `hoofoot_index_${sourceHost}_${leagueSlug}`;
  const cached = await getCachedWithStale(cacheKey, HOOFOOT_INDEX_TTL);
  if (cached && !cached.isStale && cached.value) return cached.value;

  try {
    const res = await fetch(`${hoofootBase}/full-matches/${leagueSlug}/`, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return cached?.value || [];
    const html = await res.text();
    const articles = [];
    const hrefRegex = /href="(\/full-matches\/[^"]+)"/g;
    let m;
    while ((m = hrefRegex.exec(html)) !== null) {
      const href = m[1];
      const prefix = `/full-matches/${leagueSlug}/`;
      if (!href.startsWith(prefix)) continue;
      const after = href.slice(prefix.length).replace(/\/$/, '');
      if (!after || after.includes('/')) continue;
      const url = new URL(href, hoofootBase).href;
      if (MatchDayStorage.isAllowedMatchUrl('hoofoot', url, hoofootBase)) {
        articles.push({ url, slug: after });
      }
    }
    const seen = new Set();
    const unique = articles.filter(a => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
    if (unique.length > 0) await setCache(cacheKey, unique);
    return unique;
  } catch (e) {
    console.warn(`HooFoot index fetch error for ${leagueSlug}:`, e.message);
    return cached?.value || [];
  }
}

// ── Find Best HooFoot Highlights URL ─────
async function findHoofootUrl(homeTeam, awayTeam, leagueSlug, matchDate) {
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const d = new Date(matchDate);
  const monthName = months[d.getUTCMonth()];
  const dayStr    = String(d.getUTCDate()).padStart(2, '0');
  const yearStr   = d.getUTCFullYear();

  const homeToks = teamTokens(homeTeam);
  const awayToks = teamTokens(awayTeam);

  const index = await getHoofootLeagueIndex(leagueSlug);
  if (index && index.length > 0) {
    const dateHints = [monthName, String(d.getUTCDate()), yearStr.toString()];
    const dated = index.filter(a =>
      dateHints.some(hint => a.slug.includes(hint)) ||
      slugMatchScore(a.slug, homeToks, awayToks) >= 1.5
    );

    const pool = dated.length > 0 ? dated : index;
    let best = null;
    let bestScore = 0;
    for (const article of pool) {
      const score = slugMatchScore(article.slug, homeToks, awayToks);
      if (score > bestScore) { bestScore = score; best = article; }
    }
    if (best && bestScore >= 1.0 &&
        MatchDayStorage.isAllowedMatchUrl('hoofoot', best.url)) return best.url;
  }

  return null;
}

// ── Normalize Match: Football-Data.org format ─────────────────────────
function normalizeFootballDataMatch(raw) {
  const code = raw.competition?.code || '';
  const leagueMeta = LEAGUES[code] || {};
  const status = (raw.status || 'UNKNOWN').toUpperCase();
  const score = raw.score || {};
  const ft = score.fullTime || {};
  const ht = score.halfTime || {};
  const rt = score.regularTime || {};

  return {
    id: raw.id,
    utcDate: raw.utcDate,
    status,
    competition: {
      id: raw.competition?.id || '',
      code,
      name: leagueMeta.name || raw.competition?.name || ''
    },
    homeTeam: {
      id: raw.homeTeam?.id,
      name: raw.homeTeam?.name || '',
      shortName: raw.homeTeam?.shortName || raw.homeTeam?.tla || raw.homeTeam?.name || '',
      tla: raw.homeTeam?.tla || raw.homeTeam?.code || '',
      crest: raw.homeTeam?.crest || raw.homeTeam?.logoUrl || ''
    },
    awayTeam: {
      id: raw.awayTeam?.id,
      name: raw.awayTeam?.name || '',
      shortName: raw.awayTeam?.shortName || raw.awayTeam?.tla || raw.awayTeam?.name || '',
      tla: raw.awayTeam?.tla || raw.awayTeam?.code || '',
      crest: raw.awayTeam?.crest || raw.awayTeam?.logoUrl || ''
    },
    score: {
      fullTime: { home: ft.home ?? null, away: ft.away ?? null },
      regularTime: { home: rt.home ?? ft.home ?? null, away: rt.away ?? ft.away ?? null },
      halfTime: { home: ht.home ?? null, away: ht.away ?? null }
    },
    minute: raw.minute ?? null,
    addedTime: raw.addedTime ?? null,
    period: raw.period || ''
  };
}

// ── Normalize OpenFootAPI match → internal shape ──────────────────────────
// Real schema (verified): root has competitionId (string), kickoffAt, status (lowercase),
// score: { home, away } (flat — no halfTime sub-object), period ("FT"|"1H"|"2H"|"HT"|null),
// homeTeam/awayTeam have logoUrl (not crest), no shortName (use name).
function normalizeMatch(raw) {
  const compApiId = raw.competitionId || raw.competition?.id || '';
  const code = API_ID_TO_CODE[compApiId] || compApiId;
  const leagueMeta = LEAGUES[code] || {};

  // Map only explicit API statuses; kickoff time does not change match state.
  const statusRaw = (raw.status || '').toLowerCase();
  const period = (raw.period || '').toUpperCase();
  let status;
  if (statusRaw === 'finished') status = 'FINISHED';
  else if (statusRaw === 'live' || statusRaw === 'in_play') status = 'IN_PLAY';
  else if (statusRaw === 'paused' || statusRaw === 'halftime') status = 'PAUSED';
  else if (statusRaw === 'postponed') status = 'POSTPONED';
  else if (statusRaw === 'cancelled' || statusRaw === 'canceled') status = 'CANCELLED';
  else if (statusRaw === 'suspended') status = 'SUSPENDED';
  else if (statusRaw === 'timed') status = 'TIMED';
  else if (['scheduled', 'upcoming', 'not_started'].includes(statusRaw)) status = 'SCHEDULED';
  else status = statusRaw ? statusRaw.toUpperCase() : 'UNKNOWN';

  // Real score schema: { home: number|null, away: number|null }  (no halfTime sub-object)
  const score = raw.score || {};

  return {
    id:      raw.id || raw.matchId,
    utcDate: raw.kickoffAt || raw.utcDate,
    status,
    competition: {
      id:   compApiId,
      code,
      name: leagueMeta.name || raw.competition?.name || ''
    },
    homeTeam: {
      id:        raw.homeTeam?.id,
      name:      raw.homeTeam?.name || '',
      shortName: raw.homeTeam?.shortName || raw.homeTeam?.code || raw.homeTeam?.name || '',
      tla:       raw.homeTeam?.code || raw.homeTeam?.tla || '',
      crest:     raw.homeTeam?.logoUrl || raw.homeTeam?.crest || ''
    },
    awayTeam: {
      id:        raw.awayTeam?.id,
      name:      raw.awayTeam?.name || '',
      shortName: raw.awayTeam?.shortName || raw.awayTeam?.code || raw.awayTeam?.name || '',
      tla:       raw.awayTeam?.code || raw.awayTeam?.tla || '',
      crest:     raw.awayTeam?.logoUrl || raw.awayTeam?.crest || ''
    },
    score: {
      // fullTime holds confirmed final or current running score
      fullTime:    { home: score.home ?? null, away: score.away ?? null },
      // regularTime mirrors fullTime (used by popup for live display — Fix B5)
      regularTime: { home: score.home ?? null, away: score.away ?? null },
      halfTime:    { home: null, away: null }
    },
    minute:    raw.minute    ?? null,
    addedTime: raw.addedTime ?? null,
    period
  };
}

// ── Enrich matches without inferring their provider-reported status ──
async function enrichMatch(m, vipSchedule = [], settings) {
  const code = m.competition?.code;
  const leagueMeta = LEAGUES[code] || {};
  const homeTeam = m.homeTeam || {};
  const awayTeam = m.awayTeam || {};

  const homeName = homeTeam.shortName || homeTeam.name || '';
  const awayName = awayTeam.shortName || awayTeam.name || '';
  const homeSlug = slugify(homeName);
  const awaySlug = slugify(awayName);

  // Time calculations
  const matchTime = new Date(m.utcDate).getTime();
  const nowMs     = Date.now();
  const elapsedMs = nowMs - matchTime;
  const elapsedMins = Math.floor(elapsedMs / (60 * 1000));
  const status = m.status;
  const isFinished = status === 'FINISHED';
  const isLive = status === 'IN_PLAY' || status === 'PAUSED';
  const isScheduled = status === 'SCHEDULED' || status === 'TIMED';
  const elapsedSinceKickoffMins = isScheduled && elapsedMins >= 0 ? elapsedMins : null;

  // Only a URL found in the fetched schedule is a valid match-specific link.
  let liveStreamUrl = null;
  if (vipSchedule && vipSchedule.length > 0) {
    const homeToks = teamTokens(homeName);
    const awayToks = teamTokens(awayName);
    let best = null;
    let bestScore = 0;
    for (const v of vipSchedule) {
      const score = slugMatchScore(v.slug, homeToks, awayToks);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (best && bestScore >= 1.0 &&
        MatchDayStorage.isAllowedMatchUrl('vipbox', best.url, settings.vipboxBase)) {
      liveStreamUrl = best.url;
    }
  }

  // 2. HooFoot Full Match Highlights URL
  const leagueSlug = leagueMeta.hoofootSlug || 'premier-league';
  let highlightsUrl = null;

  if (isFinished) {
    highlightsUrl = await findHoofootUrl(homeName, awayName, leagueSlug, m.utcDate);
  }

  return {
    ...m,
    provider: settings.provider,
    homeTeam: { ...homeTeam, provider: settings.provider },
    awayTeam: { ...awayTeam, provider: settings.provider },
    isFinished,
    isLive,
    elapsedMins: elapsedSinceKickoffMins,
    competitionCode:  code,
    competitionName:  leagueMeta.name || m.competition?.name || 'Unknown League',
    competitionEmoji: leagueMeta.emoji || '⚽',
    hoofootSlug:      leagueMeta.hoofootSlug || null,
    liveStreamUrl,
    highlightsUrl,
    homeSlug,
    awaySlug
  };
}

// ── Fetch Matches via Football-Data.org (OG Provider) ──────────────────────
async function fetchMatchesFootballData(dateFrom, dateTo, comps, options = {}) {
  const { apiFrom, apiTo, isTruncated } = getUtcRangeForLocalDate(dateFrom, dateTo);
  const { provider } = await getActiveProvider();
  let rawMatches = [];
  let anyRateLimited = false;
  let anyFetchError = false;

  for (let i = 0; i < comps.length; i++) {
    const code = comps[i];
    const compCacheKey = `matches_${provider}_comp_${code}_${apiFrom}_${apiTo}`;
    const cached = await getCachedWithStale(compCacheKey, MATCHES_CACHE_TTL);

    if (!options.forceRefresh && cached && !cached.isStale && cached.value) {
      rawMatches.push(...cached.value);
      continue;
    }

    if (i > 0) {
      await new Promise(r => setTimeout(r, 80)); // 80ms stagger to prevent 429
    }

    try {
      const res = await apiFetch(`/competitions/${code}/matches`, {
        dateFrom: apiFrom,
        dateTo: apiTo
      });
      const matches = (res?.matches || []).map(normalizeFootballDataMatch);
      await setCache(compCacheKey, matches);
      rawMatches.push(...matches);
    } catch (err) {
      console.warn(`FD fetch failed for ${code}:`, err.message);
      anyFetchError = true;
      if (err.message === 'RATE_LIMIT') anyRateLimited = true;
      if (cached?.value?.length > 0) rawMatches.push(...cached.value);
    }
  }

  return { rawMatches, anyRateLimited, anyFetchError, isTruncated };
}

// ── Fetch Matches via OpenFootAPI (Date-based) ─────────────────────────────
async function fetchMatchesOpenFoot(dateFrom, dateTo, comps, options = {}) {
  const { provider } = await getActiveProvider();
  const datesToFetch = [];
  const start = new Date(dateFrom + 'T00:00:00');
  const end   = new Date(dateTo   + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    datesToFetch.push(formatLocalDate(new Date(d)));
  }
  let isTruncated = false;
  if (datesToFetch.length > 10) {
    datesToFetch.length = 10;
    isTruncated = true;
  }

  let rawMatches = [];
  let anyRateLimited = false;
  let anyFetchError = false;

  for (const dateStr of datesToFetch) {
    const dateCacheKey = `matches_${provider}_date_${dateStr}`;
    const cached = await getCachedWithStale(dateCacheKey, MATCHES_CACHE_TTL);

    if (!options.forceRefresh && cached && !cached.isStale && cached.value) {
      rawMatches.push(...cached.value);
      continue;
    }

    try {
      const res = await apiFetch('/matches', { date: dateStr, limit: 100 });
      const rawList = res?.data || [];
      const normalized = rawList.map(normalizeMatch);
      await setCache(dateCacheKey, normalized);
      rawMatches.push(...normalized);
    } catch (err) {
      console.warn(`OF fetch failed for date ${dateStr}:`, err.message);
      anyFetchError = true;
      if (err.message === 'RATE_LIMIT') anyRateLimited = true;
      if (cached?.value?.length > 0) rawMatches.push(...cached.value);
    }
  }

  return { rawMatches, anyRateLimited, anyFetchError, isTruncated };
}

// ── Main Multi-Provider Match Fetcher ─────────────────────────────────────
async function fetchMatches(dateFrom, dateTo, competitions = [], options = {}) {
  const comps = (competitions && competitions.length > 0)
    ? competitions
    : ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];

  const { provider } = await getActiveProvider();
  const masterKey = `master_matches_${provider}_${dateFrom}_${dateTo}_${[...comps].sort().join(',')}`;

  let rawMatches = [];
  let anyRateLimited = false;
  let anyFetchError = false;
  let isTruncated = false;

  if (provider === 'football_data') {
    const fdRes = await fetchMatchesFootballData(dateFrom, dateTo, comps, options);
    rawMatches = fdRes.rawMatches;
    anyRateLimited = fdRes.anyRateLimited;
    anyFetchError = fdRes.anyFetchError;
    isTruncated = fdRes.isTruncated;
  } else {
    const ofRes = await fetchMatchesOpenFoot(dateFrom, dateTo, comps, options);
    rawMatches = ofRes.rawMatches;
    anyRateLimited = ofRes.anyRateLimited;
    anyFetchError = ofRes.anyFetchError;
    isTruncated = ofRes.isTruncated;
  }

  // Filter to only the requested competitions
  let filtered = rawMatches.filter(m => comps.includes(m.competition?.code));

  // Deduplicate by ID
  const seenIds = new Set();
  filtered = filtered.filter(m => {
    if (!m.id) return true;
    const identity = `${provider}:${m.id}`;
    if (seenIds.has(identity)) return false;
    seenIds.add(identity);
    return true;
  });

  // Step 5: Hydrate crests from bundled catalog and CDN (30 days cache)
  await hydrateCrests(filtered);

  // Step 6: Enrich with VIPBox & HooFoot URLs
  const vipSchedule = await getVipboxSchedule();
  const settings = await MatchDayStorage.getSettings();
  const enriched = await Promise.all(filtered.map(m => enrichMatch(m, vipSchedule, settings)));

  // Master fallback cache
  if (enriched.length > 0 || options.forceRefresh) {
    await setCache(masterKey, enriched);
  } else {
    const masterFallback = await getCachedWithStale(masterKey, STALE_FALLBACK_TTL);
    if (masterFallback?.value?.length > 0) {
      return {
        matches: masterFallback.value,
        isRateLimited: anyRateLimited,
        isStale: true,
        hasFetchError: anyFetchError,
        isTruncated
      };
    }
  }

  // Step 7: Sort — live first, then league priority, then kickoff time
  enriched.sort((a, b) => {
    const aLive = (a.status === 'IN_PLAY' || a.status === 'PAUSED') ? 0 : 1;
    const bLive = (b.status === 'IN_PLAY' || b.status === 'PAUSED') ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;

    const prioA = LEAGUES[a.competitionCode]?.priority || 99;
    const prioB = LEAGUES[b.competitionCode]?.priority || 99;
    if (prioA !== prioB) return prioA - prioB;

    return new Date(a.utcDate) - new Date(b.utcDate);
  });

  return {
    matches: enriched,
    isRateLimited: anyRateLimited,
    isStale: anyRateLimited || anyFetchError,
    hasFetchError: anyFetchError,
    isTruncated
  };
}

// ── Fetch Teams for a Competition ────────
async function fetchTeams(competitionCode) {
  const { provider } = await getActiveProvider();
  const cacheKey = `teams_${provider}_${competitionCode}`;
  const cached = await getCachedWithStale(cacheKey, TEAMS_CACHE_TTL);
  const withProvider = teams => teams.map(team => ({ ...team, provider }));
  if (cached && !cached.isStale && cached.value) return withProvider(cached.value);

  if (provider === 'football_data') {
    try {
      const data = await apiFetch(`/competitions/${competitionCode}/teams`);
      const teams = (data.teams || []).map(t => ({
        id:              t.id,
        provider,
        name:            t.name || '',
        shortName:       t.shortName || t.tla || t.name || '',
        tla:             t.tla || '',
        crest:           lookupCrest(t.name) || lookupCrest(t.shortName) || t.crest || '',
        competitionCode,
        competitionName: LEAGUES[competitionCode]?.name || competitionCode
      }));
      if (teams.length > 0) await setCache(cacheKey, teams);
      return teams;
    } catch (e) {
      console.warn(`Failed to fetch teams for ${competitionCode} via FD:`, e.message);
      return withProvider(cached?.value || []);
    }
  }

  // OpenFootAPI: extract unique teams from recent matches
  const apiId = LEAGUES[competitionCode]?.apiId;
  if (!apiId) return cached?.value || [];

  try {
    const data = await apiFetch('/matches', {
      competition: apiId,
      limit: 60
    });
    const matches = data?.data || [];
    const teamMap = new Map();
    for (const m of matches) {
      for (const side of [m.homeTeam, m.awayTeam]) {
        if (side?.id && !teamMap.has(side.id)) {
          teamMap.set(side.id, {
            id:              side.id,
            provider,
            name:            side.name || '',
            shortName:       side.shortName || side.code || side.name || '',
            tla:             side.code || side.tla || '',
            crest:           lookupCrest(side.name) || lookupCrest(side.shortName) || side.logoUrl || side.crest || '',
            competitionCode,
            competitionName: LEAGUES[competitionCode]?.name || competitionCode
          });
        }
      }
    }
    const teams = Array.from(teamMap.values());
    if (teams.length > 0) await setCache(cacheKey, teams);
    return teams;
  } catch (e) {
    console.warn(`Failed to fetch teams for ${competitionCode}:`, e.message);
    return withProvider(cached?.value || []);
  }
}

// Football-Data.org supports competition team lists; OpenFootAPI has /search.
async function searchTeams(query, selectedLeagues) {
  const { provider } = await getActiveProvider();
  const allTeams = [];
  for (const code of selectedLeagues) {
    try {
      allTeams.push(...await fetchTeams(code));
    } catch (error) {
      console.warn(`Team list failed for ${code}:`, error.message);
    }
  }

  const q = (query || '').trim().toLowerCase();
  const cachedResults = () => q ? allTeams.filter(team =>
    team.name?.toLowerCase().includes(q) ||
    team.shortName?.toLowerCase().includes(q) ||
    team.tla?.toLowerCase().includes(q)
  ) : allTeams;

  if (provider === 'football_data' || !q) return cachedResults();

  try {
    const res = await apiFetch('/search', { q: query });
    const results = (res?.data || [])
      .filter(result => result.type === 'team')
      .map(result => ({
        id: result.id,
        provider,
        name: result.name || '',
        shortName: result.name || '',
        tla: '',
        crest: lookupCrest(result.name) || result.logoUrl || '',
        competitionCode: '',
        competitionName: result.subtitle || ''
      }));
    if (results.length) return [...new Map(
      [...results, ...cachedResults()].map(team => [
        MatchDayStorage.getTeamIdentity(team, provider),
        team
      ])
    ).values()];
  } catch (error) {
    console.warn('Team search failed, falling back to competition cache:', error.message);
  }
  return cachedResults();
}

// ── Update Toolbar Badge ──────────────────
async function updateBadge() {
  try {
    const { apiKey } = await getActiveProvider();
    if (!apiKey) { chrome.action.setBadgeText({ text: '' }); return; }

    const { selectedLeagues = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'] } = await chrome.storage.local.get('selectedLeagues');
    const today = formatLocalDate(new Date());
    const res = await fetchMatches(today, today, selectedLeagues);
    const matches = res.matches || [];

    const liveMatches = matches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
    if (liveMatches.length > 0) {
      chrome.action.setBadgeText({ text: String(liveMatches.length) });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4444' });
    } else {
      const scheduledCount = matches.filter(m => m.status === 'SCHEDULED' || m.status === 'TIMED').length;
      chrome.action.setBadgeText({ text: scheduledCount > 0 ? String(scheduledCount) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#00e676' });
    }

    // ── Kickoff notifications for followed teams (Feature 1) ──
    await checkKickoffNotifications(matches);
  } catch (e) {
    console.warn('Badge update failed:', e.message);
  }
}

// ── Kickoff Notifications ─────────────────
async function checkKickoffNotifications(matches) {
  const { followedTeams = [], notifiedMatches = [] } = await chrome.storage.local.get(['followedTeams', 'notifiedMatches']);
  if (!followedTeams.length) return;

  const now = Date.now();
  const fifteenMins = 15 * 60 * 1000;
  const notifiedSet = new Set(notifiedMatches);
  const newlyNotified = [];

  for (const match of matches) {
    if (!['SCHEDULED', 'TIMED'].includes(match.status)) continue;
    const kickoff = new Date(match.utcDate).getTime();
    const timeUntil = kickoff - now;
    if (timeUntil < 0 || timeUntil > fifteenMins) continue;
    const matchIdentity = `${match.provider || 'openfoot'}:${match.id}`;
    if (notifiedSet.has(matchIdentity)) continue;

    const homeIdentity = MatchDayStorage.getTeamIdentity(match.homeTeam, match.provider || 'openfoot');
    const awayIdentity = MatchDayStorage.getTeamIdentity(match.awayTeam, match.provider || 'openfoot');
    const followedIds = new Set(followedTeams.map(team =>
      MatchDayStorage.getTeamIdentity(team, match.provider || 'openfoot')
    ));
    if (!followedIds.has(homeIdentity) && !followedIds.has(awayIdentity)) continue;

    const homeName = match.homeTeam?.shortName || match.homeTeam?.name || '?';
    const awayName = match.awayTeam?.shortName || match.awayTeam?.name || '?';
    const minsLeft = Math.ceil(timeUntil / 60000);

    chrome.notifications?.create(`kickoff_${matchIdentity}`, {
      type:    'basic',
      iconUrl: 'icons/icon48.png',
      title:   '⚽ Kickoff Soon!',
      message: `${homeName} vs ${awayName} kicks off in ${minsLeft} min`
    });

    newlyNotified.push(matchIdentity);
    notifiedSet.add(matchIdentity);
  }

  if (newlyNotified.length > 0) {
    // Prune old IDs (keep last 50 to avoid unbounded growth)
    const updated = [...notifiedSet].slice(-50);
    await chrome.storage.local.set({ notifiedMatches: updated });
  }
}

// ── Message Handler ───────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_MATCHES': {
          const res = await fetchMatches(msg.dateFrom, msg.dateTo, msg.competitions, {
            forceRefresh: msg.forceRefresh === true
          });
          sendResponse({
            success: true,
            data: res.matches,
            isRateLimited: res.isRateLimited,
            isStale: res.isStale,
            isTruncated: res.isTruncated
          });
          break;
        }
        case 'GET_TEAMS': {
          const teams = await fetchTeams(msg.competition);
          sendResponse({ success: true, data: teams });
          break;
        }
        case 'SEARCH_TEAMS': {
          const results = await searchTeams(msg.query, msg.leagues);
          sendResponse({ success: true, data: results });
          break;
        }
        case 'GET_LEAGUES': {
          sendResponse({ success: true, data: LEAGUES });
          break;
        }
        case 'REFRESH': {
          if (msg.dateFrom && msg.dateTo && Array.isArray(msg.competitions)) {
            const res = await fetchMatches(msg.dateFrom, msg.dateTo, msg.competitions, {
              forceRefresh: true
            });
            sendResponse({
              success: true,
              data: res.matches,
              isRateLimited: res.isRateLimited,
              isStale: res.isStale,
              isTruncated: res.isTruncated
            });
            break;
          }
          const { provider } = await getActiveProvider();
          const storage = await chrome.storage.local.get(null);
          const matchKeys = Object.keys(storage).filter(k =>
            k.startsWith(`master_matches_${provider}_`) ||
            k.startsWith(`matches_${provider}_`) ||
            k.startsWith('vipbox_schedule_') ||
            k.startsWith('hoofoot_index_')
          );
          await chrome.storage.local.remove(matchKeys);
          await updateBadge();
          sendResponse({ success: true });
          break;
        }
        case 'TEST_API_KEY': {
          const provider = msg.provider || 'openfoot';
          let testUrl = `${PROVIDERS.openfoot.baseUrl}/competitions`;
          let testHeaders = { 'Authorization': `Bearer ${msg.apiKey}` };

          if (provider === 'football_data') {
            testUrl = `${PROVIDERS.football_data.baseUrl}/competitions/PL`;
            testHeaders = { 'X-Auth-Token': msg.apiKey };
          }

          const testRes = await fetch(testUrl, { headers: testHeaders });
          sendResponse({ success: testRes.ok, status: testRes.status });
          break;
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});

// ── Alarms & Lifecycle ────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refreshMatches') updateBadge();
});

chrome.runtime.onInstalled.addListener(async () => {
  await MatchDayStorage.getSettings();
  const storage = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(storage).filter(k =>
    k.startsWith('date_') ||
    k.startsWith('comp_') ||
    k.startsWith('master_matches_') ||
    k.startsWith('matches_') ||
    k.startsWith('hoofoot_index_')
  );
  if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys);

  const { selectedLeagues } = await chrome.storage.local.get('selectedLeagues');
  if (!selectedLeagues || selectedLeagues.length <= 2) {
    await chrome.storage.local.set({ selectedLeagues: ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'] });
  }

  chrome.alarms.get('refreshMatches', alarm => {
    if (!alarm) chrome.alarms.create('refreshMatches', { periodInMinutes: 15 });
  });

  updateBadge();
});
