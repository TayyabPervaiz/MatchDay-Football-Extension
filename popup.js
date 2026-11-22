/* ═══════════════════════════════════════════
   MatchDay – Popup Logic (FotMob/Flashscore UX)
   ═══════════════════════════════════════════ */

// ── State ───────────────────────────────
let currentTab = 'matches';
let currentDateRange = 'today';
let currentSubFilter = 'all'; // 'all' | 'live' | 'followed'
let selectedLeagues = ['PL', 'CL'];
let followedTeams = [];
let allLeagues = {};
let currentMatches = [];
const teamsCache = new Map(); // In-memory lookup to avoid JSON attribute escaping bugs

// ── DOM Refs ────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const apiKeyOverlay = $('#apiKeyOverlay');
const apiKeyInput = $('#apiKeyInput');
const saveApiKeyBtn = $('#saveApiKey');
const refreshBtn = $('#refreshBtn');
const settingsBtn = $('#settingsBtn');
const dateFilter = $('#dateFilter');
const matchesList = $('#matchesList');
const leaguesGrid = $('#leaguesGrid');
const followedTeamsEl = $('#followedTeams');
const searchResults = $('#searchResults');
const teamSearchInput = $('#teamSearch');
const statusText = $('#statusText');
const lastUpdated = $('#lastUpdated');
const liveBadgeCount = $('#liveBadgeCount');

const CREST_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23555570'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3C/svg%3E";

// ── Error Boundary for Images ───────────
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') {
    e.target.onerror = null;
    e.target.src = CREST_FALLBACK;
  }
}, true);

// ── Delegated Link Opener (chrome.tabs.create) ─
document.addEventListener('click', (e) => {
  const linkBtn = e.target.closest('.open-tab-link');
  if (linkBtn && linkBtn.dataset.url) {
    e.preventDefault();
    e.stopPropagation();
    chrome.tabs.create({ url: linkBtn.dataset.url });
  }
});

// ── Helpers ─────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLocalDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  // ── Left column contextual label ───────────────────────────────────────
  let leftColHtml = '';
  if (dateRange === 'week') {
    const d = new Date(match.utcDate);
    const weekday = d.toLocaleDateString([], { weekday: 'short' }).toUpperCase().slice(0, 3);
    const day = d.getDate();
    leftColHtml = `<span class="card-left-label date-label">${weekday}<br>${day}</span>`;
  } else if (isLive) {
    const elapsed = match.minute != null ? `${match.minute}'` : (status === 'PAUSED' ? 'HT' : 'LIVE');
    leftColHtml = `<span class="card-left-label live-label"><span class="live-dot-sm"></span>${elapsed}</span>`;
  } else if (isFinished) {
    leftColHtml = `<span class="card-left-label ft-label">FT</span>`;
  } else {
    leftColHtml = `<span class="card-left-label time-label">${matchTime}</span>`;
  }

  return `${year}-${month}-${day}`;
}

// ── Init ────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check API key
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    apiKeyOverlay.classList.remove('hidden');
  } else {
    apiKeyOverlay.classList.add('hidden');
  }

  // Load saved state
  const stored = await chrome.storage.local.get(['selectedLeagues', 'followedTeams']);
  selectedLeagues = (stored.selectedLeagues && stored.selectedLeagues.length > 2)
    ? stored.selectedLeagues
    : ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];
  followedTeams = stored.followedTeams || [];

  // If selected leagues were restricted to only 2, expand to top leagues for full coverage
  if (!stored.selectedLeagues || stored.selectedLeagues.length <= 2) {
    chrome.storage.local.set({ selectedLeagues });
  }

  // Populate cache with existing followed teams
  followedTeams.forEach(t => teamsCache.set(t.id, t));

  // Get leagues data
  chrome.runtime.sendMessage({ type: 'GET_LEAGUES' }, (res) => {
    if (res?.success) {
      allLeagues = res.data;
      renderLeagues();
    }
  });

  // Setup event listeners
  setupTabNav();
  setupDateFilter();
  setupSubFilters();
  setupApiKeyForm();
  setupRefresh();
  setupSettings();
  setupTeamSearch();
  updateTabIndicator();

  // Load matches
  loadMatches();
  renderFollowedTeams();

  // Periodic active countdown tick & auto-poll
  setInterval(tickTimersAndLiveScores, 30 * 1000);
}

// ── API Key Form ────────────────────────
function setupApiKeyForm() {
  saveApiKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) return;
    await chrome.storage.local.set({ apiKey: key });
    apiKeyOverlay.classList.add('hidden');
    loadMatches();
  });
}

// ── Tab Navigation ──────────────────────
function setupTabNav() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });
}

function switchTab(tab) {
  currentTab = tab;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-content').forEach(c => c.classList.remove('active'));
  $(`#${tab}Tab`).classList.add('active');
  updateTabIndicator();

  // Show/hide date filter bar
  dateFilter.classList.toggle('hidden', tab !== 'matches');

  if (tab === 'matches') loadMatches();
  if (tab === 'following') renderFollowedTeams();
}

function updateTabIndicator() {
  const activeBtn = $('.tab-btn.active');
  const indicator = $('.tab-indicator');
  if (activeBtn && indicator) {
    const nav = $('.tab-nav');
    const navRect = nav.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    indicator.style.width = `${btnRect.width - 12}px`;
    indicator.style.left = `${btnRect.left - navRect.left + 6}px`;
  }
}

// ── Date Filter Bar ─────────────────────
function setupDateFilter() {
  $$('.date-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDateRange = btn.dataset.range;
      $$('.date-btn').forEach(b => b.classList.toggle('active', b === btn));
      loadMatches();
    });
  });
}

function getDateRange() {
  const today = new Date();
  switch (currentDateRange) {
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const str = formatLocalDate(y);
      return { from: str, to: str };
    }
    case 'today': {
      const str = formatLocalDate(today);
      return { from: str, to: str };
    }
    case 'tomorrow': {
      const t = new Date(today);
      t.setDate(t.getDate() + 1);
      const str = formatLocalDate(t);
      return { from: str, to: str };
    }
    case 'week': {
      // Full Gameweek: covers past 3 days (weekend results) + Today + next 4 days (upcoming fixtures)
      const wFrom = new Date(today);
      wFrom.setDate(wFrom.getDate() - 3);
      const wTo = new Date(today);
      wTo.setDate(wTo.getDate() + 4);
      return { from: formatLocalDate(wFrom), to: formatLocalDate(wTo) };
    }
    default: {
      const str = formatLocalDate(today);
      return { from: str, to: str };
    }
  }
}

// ── Sub-Filters (All, Live, My Teams) ───
function setupSubFilters() {
  $$('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentSubFilter = chip.dataset.filter;
      $$('.filter-chip').forEach(c => c.classList.toggle('active', c === chip));
      applyFiltersAndRender();
    });
  });
}

// ── Load Matches ────────────────────────
async function loadMatches() {
  showMatchesSkeleton();
  setStatus('Fetching matches...');

  const { from, to } = getDateRange();

  chrome.runtime.sendMessage({
    type: 'GET_MATCHES',
    dateFrom: from,
    dateTo: to,
    competitions: selectedLeagues
  }, (res) => {
    if (chrome.runtime.lastError) {
      showMatchesError('Connection error. Please try again.');
      return;
    }
    if (!res) {
      showMatchesError('No response from service worker. Try refreshing.');
      return;
    }
    if (res.success) {
      currentMatches = res.data || [];
      updateLiveBadge();
      applyFiltersAndRender();
      setStatus(`${currentMatches.length} match${currentMatches.length !== 1 ? 'es' : ''} loaded`);
      setLastUpdated();
    } else {
      if (res.error === 'NO_API_KEY') {
        apiKeyOverlay.classList.remove('hidden');
      } else if (res.error === 'INVALID_API_KEY') {
        showMatchesError('Invalid API key. Please update in Settings.');
      } else if (res.error === 'RATE_LIMIT') {
        showMatchesError('API rate limit reached (10/min). Please wait a moment.');
      } else {
        showMatchesError(res.error || 'Failed to load matches.');
      }
    }
  });
}

// ── Update Live Badge Count ─────────────
function updateLiveBadge() {
  const liveCount = currentMatches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED').length;
  if (liveBadgeCount) {
    liveBadgeCount.textContent = liveCount;
  }
}

// ── Filter and Render Matches ───────────
function applyFiltersAndRender() {
  let filtered = currentMatches;

  if (currentSubFilter === 'live') {
    filtered = filtered.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
  } else if (currentSubFilter === 'followed') {
    const followedIds = new Set(followedTeams.map(t => t.id));
    filtered = filtered.filter(m =>
      followedIds.has(m.homeTeam?.id) || followedIds.has(m.awayTeam?.id)
    );
  }

  renderMatchesList(filtered);
}

// ── Render Matches (FotMob / Flashscore Grouping) ─
function renderMatchesList(matches) {
  if (!matches || matches.length === 0) {
    let emptyMsg = 'No matches scheduled for this specific date.';
    if (currentSubFilter === 'live') emptyMsg = 'No live matches in progress right now.';
    if (currentSubFilter === 'followed') emptyMsg = 'None of your followed clubs are playing in this period.';

    matchesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚽</div>
        <h3>No Matches Found</h3>
        <p>${emptyMsg}</p>
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:center;">
          <button class="date-btn" id="emptyGoYesterday" style="padding:6px 12px;font-size:11px;">📅 View Yesterday</button>
          <button class="date-btn" id="emptyGoWeek" style="padding:6px 12px;font-size:11px;">🗓️ View This Week</button>
        </div>
      </div>`;

    const btnYest = $('#emptyGoYesterday');
    const btnWeek = $('#emptyGoWeek');
    if (btnYest) {
      btnYest.addEventListener('click', () => {
        currentDateRange = 'yesterday';
        $$('.date-btn').forEach(b => b.classList.toggle('active', b.dataset.range === 'yesterday'));
        loadMatches();
      });
    }
    if (btnWeek) {
      btnWeek.addEventListener('click', () => {
        currentDateRange = 'week';
        $$('.date-btn').forEach(b => b.classList.toggle('active', b.dataset.range === 'week'));
        loadMatches();
      });
    }
    return;
  }

  // Group by Competition (League)
  const grouped = new Map();
  matches.forEach(m => {
    const compCode = m.competitionCode || m.competition?.code || 'OTHER';
    if (!grouped.has(compCode)) {
      grouped.set(compCode, {
        code: compCode,
        name: m.competitionName || m.competition?.name || 'League',
        emoji: m.competitionEmoji || '⚽',
        matches: []
      });
    }
    grouped.get(compCode).matches.push(m);
  });

  let html = '';
  for (const group of grouped.values()) {
    html += `
      <div class="match-competition-group">
        <div class="competition-header">
          <div class="competition-title">
            <span class="competition-emoji">${escapeHtml(group.emoji)}</span>
            <span>${escapeHtml(group.name)}</span>
          </div>
          <span class="competition-count">${group.matches.length}</span>
        </div>
        ${group.matches.map(m => renderMatchCard(m, currentDateRange)).join('')}
      </div>`;
  }

  matchesList.innerHTML = html;
}

// ── Render Match Card with Direct Links ─
function renderMatchCard(match, dateRange) {
  const homeTeam = match.homeTeam || {};
  const awayTeam = match.awayTeam || {};
  const status = match.status;
  const score = match.score || {};

  const isLive = status === 'IN_PLAY' || status === 'PAUSED';
  const isFinished = status === 'FINISHED';

  let scoreHtml = '';
  let statusBadgeHtml = '';
  let mediaBtnHtml = '';

  const matchTime = new Date(match.utcDate).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit'
  });

  if (isFinished) {
    const ft = score.fullTime || {};
    const homeGoals = (ft.home !== null && ft.home !== undefined) ? ft.home : '-';
    const awayGoals = (ft.away !== null && ft.away !== undefined) ? ft.away : '-';
    scoreHtml = `<span class="match-score">${homeGoals} – ${awayGoals}</span>`;
    // FT shown in left column — no badge needed
    // Direct link to exact HooFoot highlight video (null if not yet indexed)
    if (match.highlightsUrl) {
      mediaBtnHtml = `
        <button class="btn-media highlights open-tab-link" data-url="${escapeHtml(match.highlightsUrl)}" title="Watch full highlights on HooFoot">
          🎬 Highlights
        </button>`;
    } else {
      mediaBtnHtml = `
        <span class="btn-media highlights disabled" title="Highlights not yet available">
          ⏳ Soon
        </span>`;
    }
  } else if (isLive) {
    const ft = score.fullTime || {};
    scoreHtml = `<span class="match-score">${ft.home ?? 0} – ${ft.away ?? 0}</span>`;
    // LIVE/HT shown in left column — no badge needed
    // Direct link to exact VIPBox live stream
    mediaBtnHtml = `
      <button class="btn-media live open-tab-link" data-url="${escapeHtml(match.liveStreamUrl)}" title="Watch live stream on VIPBox">
        <span class="live-dot-mini"></span> Live
      </button>`;
  } else {
    // Scheduled / Timed — time is in left col, centre shows "vs" + countdown
    scoreHtml = `<span class="match-vs">vs</span>`;
    statusBadgeHtml = `<span class="match-countdown" data-utc="${escapeHtml(match.utcDate)}">${getCountdown(match.utcDate)}</span>`;
    // Direct link to VIPBox stream schedule / room
    mediaBtnHtml = `
      <button class="btn-media stream open-tab-link" data-url="${escapeHtml(match.liveStreamUrl)}" title="Stream schedule on VIPBox">
        📺 Stream
      </button>`;
  }

  return `
    <div class="match-card ${isLive ? 'is-live' : ''}">
      <div class="match-main-row">
        ${leftColHtml}
        <div class="match-teams-row">
          <div class="match-team home">
            <img src="${escapeHtml(homeTeam.crest || CREST_FALLBACK)}" alt="" />
            <span class="team-name">${escapeHtml(homeTeam.shortName || homeTeam.name || 'TBD')}</span>
          </div>
          <div class="match-center">
            ${scoreHtml}
            ${statusBadgeHtml}
          </div>
          <div class="match-team away">
            <span class="team-name">${escapeHtml(awayTeam.shortName || awayTeam.name || 'TBD')}</span>
            <img src="${escapeHtml(awayTeam.crest || CREST_FALLBACK)}" alt="" />
          </div>
        </div>
        <div class="match-action-row">
          ${mediaBtnHtml}
        </div>
      </div>
    </div>`;
}

// ── Match Day Helper ────────────────────
function formatMatchDay(utcDate) {
  const matchDate = new Date(utcDate);
  const todayStr = formatLocalDate(new Date());
  const matchDateStr = formatLocalDate(matchDate);

  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yestStr = formatLocalDate(yest);

  const tom = new Date();
  tom.setDate(tom.getDate() + 1);
  const tomStr = formatLocalDate(tom);

  if (matchDateStr === todayStr) return 'Today';
  if (matchDateStr === yestStr) return 'Yesterday';
  if (matchDateStr === tomStr) return 'Tomorrow';

  return matchDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Countdown Calculation ───────────────
function getCountdown(utcDate) {
  const now = new Date();
  const match = new Date(utcDate);
  const diff = match - now;

  if (diff <= 0) return 'Starting';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ── Dynamic Tick for Countdowns & Scores ─
function tickTimersAndLiveScores() {
  // 1. Update countdown text on visible scheduled badges
  $$('.match-status-badge.scheduled').forEach(badge => {
    if (badge.dataset.utc) {
      badge.textContent = getCountdown(badge.dataset.utc);
    }
  });

  // 2. If live games are active and popup is open, auto-refresh scores
  const hasLive = currentMatches.some(m => m.status === 'IN_PLAY' || m.status === 'PAUSED');
  if (hasLive && currentTab === 'matches') {
    loadMatches();
  }
}

// ── Skeleton & Error UI ─────────────────
function showMatchesSkeleton() {
  matchesList.innerHTML = `
    <div class="skeleton-group">
      <div class="skeleton skeleton-header"></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton skeleton-header" style="margin-top:14px"></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
    </div>`;
}

function showMatchesError(message) {
  matchesList.innerHTML = `
    <div class="error-state">
      <div class="error-icon">⚠️</div>
      <h3>Something went wrong</h3>
      <p>${escapeHtml(message)}</p>
      <button class="btn-retry" id="retryBtn">Try Again</button>
    </div>`;
  const retryBtn = $('#retryBtn');
  if (retryBtn) retryBtn.addEventListener('click', loadMatches);
  setStatus('Error loading matches');
}

// ── Render Leagues Tab ──────────────────
function renderLeagues() {
  const codes = Object.keys(allLeagues);
  leaguesGrid.innerHTML = codes.map(code => {
    const league = allLeagues[code];
    const isSelected = selectedLeagues.includes(code);
    return `
      <div class="league-card ${isSelected ? 'selected' : ''}" data-code="${escapeHtml(code)}">
        <span class="league-emoji">${escapeHtml(league.emoji)}</span>
        <div class="league-info">
          <div class="league-name">${escapeHtml(league.name)}</div>
          <div class="league-country">${escapeHtml(league.country)}</div>
        </div>
        <div class="league-toggle"></div>
      </div>`;
  }).join('');

  $$('.league-card').forEach(card => {
    card.addEventListener('click', () => {
      toggleLeague(card.dataset.code, card);
    });
  });
}

function toggleLeague(code, card) {
  const idx = selectedLeagues.indexOf(code);
  if (idx > -1) {
    if (selectedLeagues.length === 1) return; // Keep at least one league
    selectedLeagues.splice(idx, 1);
    card.classList.remove('selected');
  } else {
    selectedLeagues.push(code);
    card.classList.add('selected');
  }
  chrome.storage.local.set({ selectedLeagues });
}

// ── Following Tab ───────────────────────
function setupTeamSearch() {
  let searchTimer = null;
  teamSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = teamSearchInput.value.trim();
      if (query.length < 2) {
        searchResults.innerHTML = '';
        return;
      }
      searchTeams(query);
    }, 350);
  });
}

function searchTeams(query) {
  searchResults.innerHTML = `
    <div class="skeleton-group">
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div></div>
    </div>`;

  chrome.runtime.sendMessage({
    type: 'SEARCH_TEAMS',
    query,
    leagues: selectedLeagues
  }, (res) => {
    if (res?.success) {
      renderSearchResults(res.data);
    } else {
      searchResults.innerHTML = `<div class="empty-state"><p>Search failed. Try again.</p></div>`;
    }
  });
}

function renderSearchResults(teams) {
  if (!teams || teams.length === 0) {
    searchResults.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>No teams found</h3>
        <p>Try a different search query</p>
      </div>`;
    return;
  }

  const followedIds = new Set(followedTeams.map(t => t.id));

  // Cache teams for lookup
  teams.forEach(t => teamsCache.set(t.id, t));

  searchResults.innerHTML = teams.slice(0, 20).map(team => {
    const isFollowing = followedIds.has(team.id);
    return `
      <div class="team-card" data-team-id="${team.id}">
        <img src="${escapeHtml(team.crest || CREST_FALLBACK)}" alt="" />
        <div class="team-info">
          <div class="team-name">${escapeHtml(team.name)}</div>
          <div class="team-league">${escapeHtml(team.competitionName || '')}</div>
        </div>
        <button class="team-follow-btn ${isFollowing ? 'following' : ''}" data-team-id="${team.id}">
          ${isFollowing ? '✓ Following' : '+ Follow'}
        </button>
      </div>`;
  }).join('');

  searchResults.querySelectorAll('.team-follow-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const teamId = Number(btn.dataset.teamId);
      const team = teamsCache.get(teamId);
      if (team) toggleFollowTeam(team, btn);
    });
  });
}

function renderFollowedTeams() {
  if (followedTeams.length === 0) {
    followedTeamsEl.innerHTML = `
      <div class="empty-state" style="padding: 20px">
        <div class="empty-icon">💚</div>
        <h3>No Teams Followed</h3>
        <p>Search and follow your favorite clubs<br>to quickly filter their fixtures</p>
      </div>`;
    return;
  }

  followedTeams.forEach(t => teamsCache.set(t.id, t));

  followedTeamsEl.innerHTML = `
    <div class="followed-label">Your Teams (${followedTeams.length})</div>
    ${followedTeams.map(team => `
      <div class="team-card" data-team-id="${team.id}">
        <img src="${escapeHtml(team.crest || CREST_FALLBACK)}" alt="" />
        <div class="team-info">
          <div class="team-name">${escapeHtml(team.name)}</div>
          <div class="team-league">${escapeHtml(team.competitionName || '')}</div>
        </div>
        <button class="team-follow-btn following" data-team-id="${team.id}">
          ✓ Following
        </button>
      </div>
    `).join('')}`;

  followedTeamsEl.querySelectorAll('.team-follow-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const teamId = Number(btn.dataset.teamId);
      const team = teamsCache.get(teamId);
      if (team) toggleFollowTeam(team, btn);
    });
  });
}

function toggleFollowTeam(team, btnEl) {
  const idx = followedTeams.findIndex(t => t.id === team.id);
  if (idx > -1) {
    followedTeams.splice(idx, 1);
    if (btnEl) {
      btnEl.classList.remove('following');
      btnEl.textContent = '+ Follow';
    }
  } else {
    followedTeams.push(team);
    if (btnEl) {
      btnEl.classList.add('following');
      btnEl.textContent = '✓ Following';
    }
  }
  chrome.storage.local.set({ followedTeams });
  renderFollowedTeams();
  applyFiltersAndRender();
}

// ── Refresh & Settings ──────────────────
function setupRefresh() {
  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    chrome.runtime.sendMessage({ type: 'REFRESH' }, () => {
      loadMatches();
      setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
    });
  });
}

function setupSettings() {
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

// ── Status Bar ──────────────────────────
function setStatus(text) {
  statusText.textContent = text;
}

function setLastUpdated() {
  const now = new Date();
  lastUpdated.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
