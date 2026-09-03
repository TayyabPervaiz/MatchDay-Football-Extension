/* ═══════════════════════════════════════════
   MatchDay – Background Service Worker
   ═══════════════════════════════════════════ */

const API_BASE = 'https://api.football-data.org/v4';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const LEAGUES = {
  PL:  { name: 'Premier League',    country: 'England',      emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  PD:  { name: 'La Liga',           country: 'Spain',        emoji: '🇪🇸' },
  BL1: { name: 'Bundesliga',        country: 'Germany',      emoji: '🇩🇪' },
  SA:  { name: 'Serie A',           country: 'Italy',        emoji: '🇮🇹' },
  FL1: { name: 'Ligue 1',           country: 'France',       emoji: '🇫🇷' },
  CL:  { name: 'Champions League',  country: 'Europe',       emoji: '🏆' },
  ELC: { name: 'Championship',      country: 'England',      emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  PPL: { name: 'Primeira Liga',     country: 'Portugal',     emoji: '🇵🇹' },
  DED: { name: 'Eredivisie',        country: 'Netherlands',  emoji: '🇳🇱' },
  BSA: { name: 'Série A',           country: 'Brazil',       emoji: '🇧🇷' },
  EC:  { name: 'European Championship', country: 'Europe',   emoji: '🇪🇺' },
  WC:  { name: 'FIFA World Cup',    country: 'International', emoji: '🌍' }
};

// ── API Fetch Helper ────────────────────
async function apiFetch(endpoint, params = {}) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('NO_API_KEY');

  const url = new URL(`${API_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const response = await fetch(url.toString(), {
    headers: { 'X-Auth-Token': apiKey }
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error('RATE_LIMIT');
    if (response.status === 403) throw new Error('INVALID_API_KEY');
    throw new Error(`API_ERROR_${response.status}`);
  }

  return response.json();
}

// ── Cache Helper ────────────────────────
async function getCached(key) {
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const { value, timestamp } = data[key];
  if (Date.now() - timestamp > CACHE_TTL) return null;
  return value;
}

async function setCache(key, value) {
  await chrome.storage.local.set({ [key]: { value, timestamp: Date.now() } });
}

// ── Fetch Matches ───────────────────────
async function fetchMatches(dateFrom, dateTo, competitions) {
  const cacheKey = `matches_${dateFrom}_${dateTo}_${competitions.join(',')}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const allMatches = [];

  // Fetch per competition (free tier doesn't allow multiple competition filter on /matches)
  for (const code of competitions) {
    try {
      const data = await apiFetch(`/competitions/${code}/matches`, {
        dateFrom,
        dateTo,
        status: 'SCHEDULED,TIMED,IN_PLAY,PAUSED,FINISHED'
      });
      if (data.matches) {
        allMatches.push(...data.matches.map(m => ({
          ...m,
          competitionCode: code,
          competitionName: LEAGUES[code]?.name || m.competition?.name,
          competitionEmoji: LEAGUES[code]?.emoji || '⚽'
        })));
      }
    } catch (e) {
      // If rate limited on one, we still get the rest 
      if (e.message === 'RATE_LIMIT') {
        // Wait a bit and skip this competition
        await new Promise(r => setTimeout(r, 6500));
      }
      console.warn(`Failed to fetch ${code}:`, e.message);
    }
  }

  // Sort by date
  allMatches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  await setCache(cacheKey, allMatches);
  return allMatches;
}

// ── Fetch Teams for a Competition ───────
async function fetchTeams(competitionCode) {
  const cacheKey = `teams_${competitionCode}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const data = await apiFetch(`/competitions/${competitionCode}/teams`);
    const teams = (data.teams || []).map(t => ({
      id: t.id,
      name: t.name,
      shortName: t.shortName || t.tla,
      tla: t.tla,
      crest: t.crest,
      competitionCode,
      competitionName: LEAGUES[competitionCode]?.name || competitionCode
    }));
    await setCache(cacheKey, teams);
    return teams;
  } catch (e) {
    console.warn(`Failed to fetch teams for ${competitionCode}:`, e.message);
    return [];
  }
}

// ── Search Teams Across Selected Leagues ─
async function searchTeams(query, selectedLeagues) {
  const allTeams = [];
  for (const code of selectedLeagues) {
    const teams = await fetchTeams(code);
    allTeams.push(...teams);
  }
  if (!query) return allTeams;
  const q = query.toLowerCase();
  return allTeams.filter(t =>
    t.name.toLowerCase().includes(q) ||
    (t.shortName && t.shortName.toLowerCase().includes(q)) ||
    (t.tla && t.tla.toLowerCase().includes(q))
  );
}

// ── Update Badge ────────────────────────
async function updateBadge() {
  try {
    const { selectedLeagues = ['PL', 'CL'] } = await chrome.storage.local.get('selectedLeagues');
    const today = new Date().toISOString().slice(0, 10);
    const matches = await fetchMatches(today, today, selectedLeagues);
    const count = matches.length;
    
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#00e676' });
  } catch (e) {
    console.warn('Badge update failed:', e.message);
  }
}

// ── Message Handler ─────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_MATCHES': {
          const matches = await fetchMatches(msg.dateFrom, msg.dateTo, msg.competitions);
          sendResponse({ success: true, data: matches });
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
          // Clear match caches
          const storage = await chrome.storage.local.get(null);
          const matchKeys = Object.keys(storage).filter(k => k.startsWith('matches_') || k.startsWith('teams_'));
          await chrome.storage.local.remove(matchKeys);
          await updateBadge();
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true; // Keep message channel open for async response
});

// ── Alarms ──────────────────────────────
chrome.alarms.create('refreshMatches', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refreshMatches') {
    updateBadge();
  }
});

// ── On Install ──────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // Set default selected leagues
  chrome.storage.local.get('selectedLeagues', ({ selectedLeagues }) => {
    if (!selectedLeagues) {
      chrome.storage.local.set({ selectedLeagues: ['PL', 'CL'] });
    }
  });
  updateBadge();
});
