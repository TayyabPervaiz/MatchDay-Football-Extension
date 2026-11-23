/* ═══════════════════════════════════════════
   MatchDay – Background Service Worker
   Robust Caching, Rate-Limit Defense & Inferred Match Lifecycle
   ═══════════════════════════════════════════ */

const API_BASE = 'https://api.football-data.org/v4';
const MATCHES_CACHE_TTL = 3 * 60 * 1000;          // 3 minutes fresh cache
const STALE_FALLBACK_TTL = 24 * 60 * 60 * 1000;    // 24 hours stale fallback
const TEAMS_CACHE_TTL = 14 * 24 * 60 * 60 * 1000;  // 14 days
const HOOFOOT_INDEX_TTL = 30 * 60 * 1000;          // 30 minutes

const LEAGUES = {
  CL:  { name: 'Champions League',       country: 'Europe',        emoji: '🏆', priority: 1,  hoofootSlug: 'champions-league' },
  PL:  { name: 'Premier League',         country: 'England',       emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', priority: 2,  hoofootSlug: 'premier-league' },
  PD:  { name: 'La Liga',                country: 'Spain',         emoji: '🇪🇸', priority: 3,  hoofootSlug: 'la-liga' },
  BL1: { name: 'Bundesliga',             country: 'Germany',       emoji: '🇩🇪', priority: 4,  hoofootSlug: 'bundesliga' },
  SA:  { name: 'Serie A',                country: 'Italy',         emoji: '🇮🇹', priority: 5,  hoofootSlug: 'serie-a' },
  FL1: { name: 'Ligue 1',                country: 'France',        emoji: '🇫🇷', priority: 6,  hoofootSlug: 'ligue-1' },
  ELC: { name: 'Championship',           country: 'England',       emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', priority: 7,  hoofootSlug: 'championship' },
  PPL: { name: 'Primeira Liga',          country: 'Portugal',      emoji: '🇵🇹', priority: 8,  hoofootSlug: 'primeira-liga' },
  DED: { name: 'Eredivisie',             country: 'Netherlands',   emoji: '🇳🇱', priority: 9,  hoofootSlug: 'eredivisie' },
  BSA: { name: 'Série A',                country: 'Brazil',        emoji: '🇧🇷', priority: 10, hoofootSlug: 'pro-league' },
  EC:  { name: 'European Championship',  country: 'Europe',        emoji: '🇪🇺', priority: 11, hoofootSlug: 'euro-cup' },
  WC:  { name: 'FIFA World Cup',         country: 'International', emoji: '🌍', priority: 12, hoofootSlug: 'fifa-world-cup-2026' }
};

// ── Local Date Helper ───────────────────
function formatLocalDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ── Sliding UTC Window for Local Timezones ──
function getUtcRangeForLocalDate(dateFrom, dateTo) {
  const dFrom = new Date(dateFrom + 'T00:00:00');
  dFrom.setDate(dFrom.getDate() - 1);
  const dTo = new Date(dateTo + 'T00:00:00');
  dTo.setDate(dTo.getDate() + 1);

  // Football-data API allows maximum 10 days difference
  const diffDays = Math.round((dTo - dFrom) / (1000 * 60 * 60 * 24));
  if (diffDays > 10) {
    dTo.setTime(dFrom.getTime() + 9 * 24 * 60 * 60 * 1000);
  }

  return {
    apiFrom: formatLocalDate(dFrom),
    apiTo: formatLocalDate(dTo)
  };
}

// ── Slugify Helper (VIPBox / General ASCII normalise) ──────────────────────
function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // diacritics -> base char
    .replace(/['’]/g, '')                               // remove apostrophes
    .replace(/\b(fc|cf|sc|afc|bsc|sv|ac|rc|sk|cd|as|ss|vfb|tsv|rcd|ud|sd)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Normalize team name to key tokens for fuzzy HooFoot matching ──────────
function teamTokens(name) {
  if (!name) return [];
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/['’]/g, '')
    .replace(/\b(fc|cf|sc|afc|bsc|sv|ac|rc|sk|cd|rcd|ud|sd|club|de|la|le|les|el|los|las)\b/gi, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

// ── Score how well a HooFoot slug matches a home+away pair ───────────────
function slugMatchScore(slug, homeToks, awayToks) {
  const s = slug.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const homeHits = homeToks.filter(t => s.includes(t)).length;
  const awayHits = awayToks.filter(t => s.includes(t)).length;
  if (!homeToks.length || !awayToks.length) return 0;
  return (homeHits / homeToks.length) + (awayHits / awayToks.length);
}

// ── API Fetch Helper ────────────────────
async function apiFetch(endpoint, params = {}) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('NO_API_KEY');

  const url = new URL(`${API_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, v);
    }
  });

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

// ── Cache Helper with Stale-While-Revalidate ─
async function getCachedWithStale(key, ttl = MATCHES_CACHE_TTL) {
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const { value, timestamp } = data[key];
  const isStale = (Date.now() - timestamp > ttl);
  return { value, isStale, timestamp };
}

async function setCache(key, value) {
  await chrome.storage.local.set({ [key]: { value, timestamp: Date.now() } });
}

// ── Sync Live Schedule from VIPBox ──────
async function getVipboxSchedule() {
  const cacheKey = 'vipbox_schedule';
  const cached = await getCachedWithStale(cacheKey, 10 * 60 * 1000);
  if (cached && !cached.isStale && cached.value) return cached.value;

  try {
    const res = await fetch('https://vipbox.ga/football-schedule', { cache: 'no-store' });
    if (!res.ok) return cached?.value || [];
    const html = await res.text();
    const list = [];
    const regex = /href="(\/onair\/football\/([^"]+))"/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      list.push({
        url: `https://vipbox.ga${m[1]}`,
        slug: m[2]
      });
    }
    if (list.length > 0) {
      await setCache(cacheKey, list);
    }
    return list;
  } catch (e) {
    console.warn('VIPBox live schedule fetch failed:', e.message);
    return cached?.value || [];
  }
}

// ── Fetch & Cache HooFoot League Index (article hrefs) ───────────────────
async function getHoofootLeagueIndex(leagueSlug) {
  const cacheKey = `hoofoot_index_${leagueSlug}`;
  const cached = await getCachedWithStale(cacheKey, HOOFOOT_INDEX_TTL);
  if (cached && !cached.isStale && cached.value) return cached.value;

  try {
    const res = await fetch(`https://hoofoot.net/full-matches/${leagueSlug}/`, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) {
      return cached?.value || [];
    }
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
      articles.push({ url: `https://hoofoot.net${href}`, slug: after });
    }
    const seen = new Set();
    const unique = articles.filter(a => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
    if (unique.length > 0) {
      await setCache(cacheKey, unique);
    }
    return unique;
  } catch (e) {
    console.warn(`HooFoot index fetch error for ${leagueSlug}:`, e.message);
    return cached?.value || [];
  }
}

// ── Find Best HooFoot Highlights URL via Fuzzy Slug Match ────────────────
async function findHoofootUrl(homeTeam, awayTeam, leagueSlug, matchDate) {
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const d = new Date(matchDate);
  const monthName = months[d.getUTCMonth()];
  const dayStr   = String(d.getUTCDate()).padStart(2, '0');
  const yearStr  = d.getUTCFullYear();

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
      if (score > bestScore) {
        bestScore = score;
        best = article;
      }
    }

    if (best && bestScore >= 1.0) {
      return best.url;
    }
  }

  // Fallback slug
  const homeSlug = slugify(homeTeam);
  const awaySlug = slugify(awayTeam);
  return `https://hoofoot.net/full-matches/${leagueSlug}/${homeSlug}-vs-${awaySlug}-highlights-${monthName}-${dayStr}-${yearStr}/`;
}

// ── Enrich Match with Media Links & Inferred Lapsed Status ────────────────
async function enrichMatch(m, vipSchedule = []) {
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
  const nowMs = Date.now();
  const elapsedMs = nowMs - matchTime;
  const elapsedMins = Math.floor(elapsedMs / (60 * 1000));

  let status = m.status;
  let isFinished = (status === 'FINISHED');
  let isLive = (status === 'IN_PLAY' || status === 'PAUSED');

  // Lapsed match inference:
  // If API still says TIMED/SCHEDULED but kickoff was over 115 minutes ago,
  // the match is finished, not starting!
  if (!isFinished && !isLive) {
    if (elapsedMins > 115) {
      status = 'FINISHED';
      isFinished = true;
    } else if (elapsedMins >= 0 && elapsedMins <= 115) {
      status = 'IN_PLAY';
      isLive = true;
    }
  }

  // 1. VIPBox Direct Match Stream URL (fuzzy match from schedule)
  let liveStreamUrl = `https://vipbox.ga/onair/football/${homeSlug}-vs-${awaySlug}`;
  if (vipSchedule && vipSchedule.length > 0) {
    const homeToks = teamTokens(homeName);
    const awayToks = teamTokens(awayName);
    let best = null;
    let bestScore = 0;
    for (const v of vipSchedule) {
      const score = slugMatchScore(v.slug, homeToks, awayToks);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best && bestScore >= 1.0) {
      liveStreamUrl = best.url;
    }
  }

  // 2. HooFoot Full Match Highlights URL
  const leagueSlug = leagueMeta.hoofootSlug || 'premier-league';
  let highlightsUrl = null;

  // Search HooFoot if match is finished OR if it kicked off over 105 mins ago
  if (isFinished || elapsedMins > 105) {
    highlightsUrl = await findHoofootUrl(homeName, awayName, leagueSlug, m.utcDate);
    if (highlightsUrl && !isFinished) {
      status = 'FINISHED';
      isFinished = true;
    }
  }

  return {
    ...m,
    status,
    isFinished,
    isLive,
    elapsedMins: isLive ? Math.min(Math.max(elapsedMins, 1), 90) : null,
    competitionCode: code,
    competitionName: leagueMeta.name || m.competition?.name || 'Unknown League',
    competitionEmoji: leagueMeta.emoji || '⚽',
    liveStreamUrl,
    highlightsUrl,
    homeSlug,
    awaySlug
  };
}

// ── Fetch Matches with Per-Competition Caching & Stale Fallbacks ─────────
async function fetchMatches(dateFrom, dateTo, competitions = []) {
  const comps = (competitions && competitions.length > 0)
    ? competitions
    : ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];

  const { apiFrom, apiTo } = getUtcRangeForLocalDate(dateFrom, dateTo);
  const masterKey = `master_matches_${dateFrom}_${dateTo}`;

  let rawMatches = [];
  let anyRateLimited = false;
  let compsToFetch = [];

  // Step 1: Check per-competition fresh cache
  for (const code of comps) {
    const compCacheKey = `comp_${code}_${apiFrom}_${apiTo}`;
    const cached = await getCachedWithStale(compCacheKey, MATCHES_CACHE_TTL);
    if (cached && !cached.isStale && cached.value && cached.value.length >= 0) {
      // Fresh cache hit!
      rawMatches.push(...cached.value);
    } else {
      compsToFetch.push({
        code,
        compCacheKey,
        staleValue: cached ? cached.value : null
      });
    }
  }

  // Step 2: Fetch only competitions that are stale or missing (staggered by 80ms)
  if (compsToFetch.length > 0) {
    for (let i = 0; i < compsToFetch.length; i++) {
      const { code, compCacheKey, staleValue } = compsToFetch[i];
      if (i > 0) {
        await new Promise(r => setTimeout(r, 80)); // Prevent simultaneous burst triggering 429
      }

      try {
        const res = await apiFetch(`/competitions/${code}/matches`, {
          dateFrom: apiFrom,
          dateTo: apiTo
        });
        if (res && res.matches) {
          rawMatches.push(...res.matches);
          await setCache(compCacheKey, res.matches);
        } else if (staleValue) {
          rawMatches.push(...staleValue);
        }
      } catch (err) {
        console.warn(`Fetch failed for ${code}:`, err.message);
        if (err.message === 'RATE_LIMIT') {
          anyRateLimited = true;
        }
        // Fall back to stale cache if available
        if (staleValue && staleValue.length > 0) {
          rawMatches.push(...staleValue);
        }
      }
    }
  }

  // Step 3: Filter by requested competitions
  let filtered = rawMatches.filter(m => comps.includes(m.competition?.code));

  // Deduplicate matches by ID
  const seenIds = new Set();
  filtered = filtered.filter(m => {
    if (!m.id) return true;
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });

  // Step 4: Local Timezone Date Matching
  const todayStr = formatLocalDate(new Date());
  const includesToday = (dateFrom <= todayStr && todayStr <= dateTo);

  filtered = filtered.filter(m => {
    const localMatchDate = formatLocalDate(new Date(m.utcDate));
    const isWithinLocalRange = (localMatchDate >= dateFrom && localMatchDate <= dateTo);
    const isLiveNow = (m.status === 'IN_PLAY' || m.status === 'PAUSED');
    return isWithinLocalRange || (includesToday && isLiveNow);
  });

  // Step 5: Enrich with VIPBox & HooFoot URLs
  const vipSchedule = await getVipboxSchedule();
  const enriched = await Promise.all(filtered.map(m => enrichMatch(m, vipSchedule)));

  // Step 6: Master Fallback Cache Management
  if (enriched.length > 0) {
    await setCache(masterKey, enriched);
  } else {
    // If rate-limited and enriched is empty, fall back to master cache!
    const masterFallback = await getCachedWithStale(masterKey, STALE_FALLBACK_TTL);
    if (masterFallback && masterFallback.value && masterFallback.value.length > 0) {
      return {
        matches: masterFallback.value,
        isRateLimited: anyRateLimited,
        isStale: true
      };
    }
  }

  // Step 7: Sort by FotMob sequencing
  // 1. Hoist LIVE matches to top
  // 2. Sort by League Priority tier
  // 3. Chronological by kickoff time
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
    isStale: anyRateLimited
  };
}

// ── Fetch Teams for a Competition (Long-term 14d cache) ─
async function fetchTeams(competitionCode) {
  const cacheKey = `teams_${competitionCode}`;
  const cached = await getCachedWithStale(cacheKey, TEAMS_CACHE_TTL);
  if (cached && !cached.isStale && cached.value) return cached.value;

  try {
    const data = await apiFetch(`/competitions/${competitionCode}/teams`);
    const teams = (data.teams || []).map(t => ({
      id: t.id,
      name: t.name,
      shortName: t.shortName || t.tla || t.name,
      tla: t.tla,
      crest: t.crest,
      competitionCode,
      competitionName: LEAGUES[competitionCode]?.name || competitionCode
    }));
    await setCache(cacheKey, teams);
    return teams;
  } catch (e) {
    console.warn(`Failed to fetch teams for ${competitionCode}:`, e.message);
    return cached?.value || [];
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

// ── Update Toolbar Badge ────────────────
async function updateBadge() {
  try {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    const { selectedLeagues = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'] } = await chrome.storage.local.get('selectedLeagues');
    const today = formatLocalDate(new Date());
    const res = await fetchMatches(today, today, selectedLeagues);
    const matches = res.matches || [];

    const liveMatches = matches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
    if (liveMatches.length > 0) {
      chrome.action.setBadgeText({ text: String(liveMatches.length) });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4444' }); // Red for live
    } else {
      const scheduledCount = matches.filter(m => m.status === 'SCHEDULED' || m.status === 'TIMED').length;
      chrome.action.setBadgeText({ text: scheduledCount > 0 ? String(scheduledCount) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#00e676' }); // Green for upcoming
    }
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
          const res = await fetchMatches(msg.dateFrom, msg.dateTo, msg.competitions);
          sendResponse({
            success: true,
            data: res.matches,
            isRateLimited: res.isRateLimited,
            isStale: res.isStale
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
          const storage = await chrome.storage.local.get(null);
          const matchKeys = Object.keys(storage).filter(k =>
            k.startsWith('comp_') || k.startsWith('master_matches_') || k.startsWith('matches_') || k === 'vipbox_schedule' || k.startsWith('hoofoot_index_')
          );
          await chrome.storage.local.remove(matchKeys);
          await updateBadge();
          sendResponse({ success: true });
          break;
        }
        case 'TEST_API_KEY': {
          const testRes = await fetch(`${API_BASE}/competitions/PL`, {
            headers: { 'X-Auth-Token': msg.apiKey }
          });
          if (testRes.ok) {
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, status: testRes.status });
          }
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

// ── Alarms & Lifecycle ──────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refreshMatches') {
    updateBadge();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // Clear any stale cache on install
  const storage = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(storage).filter(k =>
    k.startsWith('comp_') || k.startsWith('master_matches_') || k.startsWith('matches_') || k.startsWith('hoofoot_index_')
  );
  if (staleKeys.length > 0) {
    await chrome.storage.local.remove(staleKeys);
  }

  const { selectedLeagues } = await chrome.storage.local.get('selectedLeagues');
  if (!selectedLeagues || selectedLeagues.length <= 2) {
    await chrome.storage.local.set({ selectedLeagues: ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'] });
  }

  chrome.alarms.get('refreshMatches', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('refreshMatches', { periodInMinutes: 15 });
    }
  });

  updateBadge();
});
