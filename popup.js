/* ═══════════════════════════════════════════
   MatchDay – Popup Logic (FotMob/Flashscore UX)
   High Density, Accessible, WCAG AA Compliant
   ═══════════════════════════════════════════ */

// ── State ───────────────────────────────
let currentTab = 'matches';
let currentDateRange = 'today';
let currentSubFilter = 'all'; // 'all' | 'live' | 'followed'
let selectedLeagues = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];
let followedTeams = [];
let allLeagues = {};
let currentMatches = [];
let collapsedLeagues = new Set();
let lastFetchTimestamp = null;
let lastLiveRefresh = 0;
const teamsCache = new Map(); // In-memory lookup

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
const filterLiveBtn = $('#filterLive');

const CREST_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%236d738f'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3C/svg%3E";

// ── Error Boundary for Images ───────────
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') {
    e.target.onerror = null;
    e.target.src = CREST_FALLBACK;
  }
}, true);

// ── Delegated Card & Link Opener ─────────
document.addEventListener('click', (e) => {
  // 1. Team star follow button
  const starBtn = e.target.closest('.team-star-btn');
  if (starBtn) {
    e.preventDefault();
    e.stopPropagation();
    const teamId = Number(starBtn.dataset.teamId);
    const teamName = starBtn.dataset.teamName;
    const teamCrest = starBtn.dataset.teamCrest;
    const compName = starBtn.dataset.compName;
    toggleFollowTeamSimple({ id: teamId, name: teamName, crest: teamCrest, competitionName: compName });
    return;
  }

  // 2. Direct media buttons (Watch Live / Full Highlights / Stream)
  const linkBtn = e.target.closest('.open-tab-link');
  if (linkBtn && linkBtn.dataset.url) {
    e.preventDefault();
    e.stopPropagation();
    chrome.tabs.create({ url: linkBtn.dataset.url });
    return;
  }

  // 3. Whole match card click (opens primary source / stream / highlights)
  const matchCard = e.target.closest('.match-card');
  if (matchCard && matchCard.dataset.primaryUrl) {
    e.preventDefault();
    chrome.tabs.create({ url: matchCard.dataset.primaryUrl });
    return;
  }

  // 4. League Header Collapse / Expand
  const compHeader = e.target.closest('.competition-header');
  if (compHeader && compHeader.dataset.compCode) {
    e.preventDefault();
    toggleLeagueCollapse(compHeader.dataset.compCode);
    return;
  }
});

// ── Keyboard Accessibility for Cards ────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    const card = document.activeElement?.closest?.('.match-card');
    if (card && card.dataset.primaryUrl && !e.target.closest('button')) {
      e.preventDefault();
      chrome.tabs.create({ url: card.dataset.primaryUrl });
    }
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
  const stored = await chrome.storage.local.get(['selectedLeagues', 'followedTeams', 'collapsedLeagues']);
  selectedLeagues = (stored.selectedLeagues && stored.selectedLeagues.length > 2)
    ? stored.selectedLeagues
    : ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];
  followedTeams = stored.followedTeams || [];
  collapsedLeagues = new Set(stored.collapsedLeagues || []);

  // Ensure default leagues saved
  if (!stored.selectedLeagues || stored.selectedLeagues.length <= 2) {
    chrome.storage.local.set({ selectedLeagues });
  }

  // Populate cache with existing followed teams
  followedTeams.forEach(t => teamsCache.set(t.id, t));

  // Get leagues data from background
  chrome.runtime.sendMessage({ type: 'GET_LEAGUES' }, (res) => {
    if (res?.success) {
      allLeagues = res.data;
      renderLeagues();
    }
  });

  // Setup UI event listeners
  setupTabNav();
  setupDateFilter();
  setupSubFilters();
  setupApiKeyForm();
  setupRefresh();
  setupSettings();
  setupTeamSearch();
  setupOfflineListeners();
  updateTabIndicator();

  // Load initial matches
  loadMatches();
  renderFollowedTeams();

  // Periodic active countdown tick & auto-poll (30s)
  setInterval(tickTimersAndLiveScores, 30 * 1000);
}

// ── Offline / Online Listeners ──────────
function setupOfflineListeners() {
  window.addEventListener('online', () => {
    setStatus('Back online');
    if (currentTab === 'matches') loadMatches(true);
  });
  window.addEventListener('offline', () => {
    setStatus('Offline');
  });
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
  $$('.tab-btn').forEach(b => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', String(isActive));
  });
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

// ── Date Segmented Control ──────────────
function setupDateFilter() {
  $$('.date-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDateRange = btn.dataset.range;
      $$('.date-btn').forEach(b => {
        const isCurrent = b === btn;
        b.classList.toggle('active', isCurrent);
        b.setAttribute('aria-pressed', String(isCurrent));
      });
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
      $$('.filter-chip').forEach(c => {
        const isCurrent = c === chip;
        c.classList.toggle('active', isCurrent);
        c.setAttribute('aria-pressed', String(isCurrent));
      });
      applyFiltersAndRender();
    });
  });
}

// ── Load Matches ────────────────────────
async function loadMatches(isSilent = false, specificComps = null) {
  if (!navigator.onLine) {
    showMatchesError('You are offline. Reconnect to load live fixtures.', true);
    return;
  }

  if (!isSilent) {
    showMatchesSkeleton();
    setStatus('Fetching matches...');
  }

  const { from, to } = getDateRange();

  chrome.runtime.sendMessage({
    type: 'GET_MATCHES',
    dateFrom: from,
    dateTo: to,
    competitions: specificComps || selectedLeagues
  }, (res) => {
    if (chrome.runtime.lastError) {
      if (!isSilent) showMatchesError('Connection error. Please try again.');
      return;
    }
    if (!res) {
      if (!isSilent) showMatchesError('No response from service worker. Try refreshing.');
      return;
    }
    if (res.success) {
      if (specificComps && specificComps.length > 0) {
        // Merge updated live matches into existing list
        const updated = res.data || [];
        const updatedMap = new Map(updated.map(m => [m.id, m]));
        currentMatches = currentMatches.map(m => updatedMap.has(m.id) ? updatedMap.get(m.id) : m);
      } else {
        currentMatches = res.data || [];
      }

      lastFetchTimestamp = Date.now();
      updateLiveBadgeAndEmphasis();
      applyFiltersAndRender();

      if (res.isRateLimited) {
        setStatus(`Rate limit reached – showing cached fixtures (${currentMatches.length})`);
      } else if (res.isStale) {
        setStatus(`Showing cached fixtures (${currentMatches.length})`);
      } else {
        setStatus(`${currentMatches.length} match${currentMatches.length !== 1 ? 'es' : ''} loaded`);
      }
      updateRelativeTime();
    } else {
      if (res.error === 'NO_API_KEY') {
        apiKeyOverlay.classList.remove('hidden');
      } else if (res.error === 'INVALID_API_KEY') {
        showMatchesError('Invalid API key. Please update in Settings.');
      } else if (res.error === 'RATE_LIMIT') {
        setStatus('API rate limit reached (10/min) – showing cached matches');
      } else {
        showMatchesError(res.error || 'Failed to load matches.');
      }
    }
  });
}

// ── Update Live Badge Count & Visual Prominence ──
function updateLiveBadgeAndEmphasis() {
  const liveCount = currentMatches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.isLive).length;

  if (liveBadgeCount && filterLiveBtn) {
    if (liveCount > 0) {
      liveBadgeCount.textContent = liveCount;
      liveBadgeCount.classList.remove('hidden');
      filterLiveBtn.classList.add('has-live');
      filterLiveBtn.classList.remove('dim-when-zero');
    } else {
      liveBadgeCount.textContent = '0';
      liveBadgeCount.classList.add('hidden');
      filterLiveBtn.classList.remove('has-live');
      filterLiveBtn.classList.add('dim-when-zero');
    }
  }
}

// ── Filter and Render Matches ───────────
function applyFiltersAndRender() {
  let filtered = currentMatches;

  if (currentSubFilter === 'live') {
    filtered = filtered.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.isLive);
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
    let emptyTitle = 'No Matches Today';
    let emptyMsg = 'No matches scheduled for today.';
    let actionBtnText = 'View Tomorrow';
    let actionTarget = 'tomorrow';

    if (currentSubFilter === 'live') {
      emptyTitle = 'No Live Matches';
      emptyMsg = 'No matches are currently in play.';
      actionBtnText = 'View All Matches';
      actionTarget = 'all_subfilter';
    } else if (currentSubFilter === 'followed') {
      emptyTitle = 'No Followed Teams Playing';
      emptyMsg = 'None of your followed clubs are playing in this period.';
      actionBtnText = 'Follow More Clubs';
      actionTarget = 'following_tab';
    } else {
      if (currentDateRange === 'yesterday') {
        emptyTitle = 'No Matches Yesterday';
        emptyMsg = 'No fixtures took place yesterday.';
        actionBtnText = 'View Today';
        actionTarget = 'today';
      } else if (currentDateRange === 'tomorrow') {
        emptyTitle = 'No Matches Tomorrow';
        emptyMsg = 'No fixtures scheduled for tomorrow.';
        actionBtnText = 'View This Week';
        actionTarget = 'week';
      } else if (currentDateRange === 'week') {
        emptyTitle = 'No Fixtures This Week';
        emptyMsg = 'No fixtures found in your selected leagues.';
        actionBtnText = 'Manage Leagues';
        actionTarget = 'leagues_tab';
      }
    }

    matchesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">⚽</div>
        <h3>${escapeHtml(emptyTitle)}</h3>
        <p>${escapeHtml(emptyMsg)}</p>
        <div class="empty-actions">
          <button class="date-btn active" id="emptyActionBtn" style="padding: 6px 14px; font-size: 11.5px;">
            ${escapeHtml(actionBtnText)}
          </button>
        </div>
      </div>`;

    const actionBtn = $('#emptyActionBtn');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        if (actionTarget === 'all_subfilter') {
          currentSubFilter = 'all';
          $$('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
          applyFiltersAndRender();
        } else if (actionTarget === 'following_tab') {
          switchTab('following');
        } else if (actionTarget === 'leagues_tab') {
          switchTab('leagues');
        } else {
          currentDateRange = actionTarget;
          $$('.date-btn').forEach(b => b.classList.toggle('active', b.dataset.range === actionTarget));
          loadMatches();
        }
      });
    }
    return;
  }

  // Group by Competition (League)
  const grouped = new Map();
  matches.forEach(m => {
    const compCode = m.competitionCode || m.competition?.code || 'OTHER';
    if (!grouped.has(compCode)) {
      const meta = allLeagues[compCode] || {};
      grouped.set(compCode, {
        code: compCode,
        name: m.competitionName || meta.name || m.competition?.name || 'League',
        emoji: m.competitionEmoji || meta.emoji || '⚽',
        priority: meta.priority || 99,
        hasLive: false,
        matches: []
      });
    }
    const group = grouped.get(compCode);
    group.matches.push(m);
    if (m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.isLive) {
      group.hasLive = true;
    }
  });

  // Sort League Groups:
  // 1. Leagues with active live games first
  // 2. Followed leagues / containing followed clubs
  // 3. Official league priority tier
  const followedIds = new Set(followedTeams.map(t => t.id));
  const sortedGroups = Array.from(grouped.values()).sort((a, b) => {
    if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;

    const aFollowed = a.matches.some(m => followedIds.has(m.homeTeam?.id) || followedIds.has(m.awayTeam?.id));
    const bFollowed = b.matches.some(m => followedIds.has(m.homeTeam?.id) || followedIds.has(m.awayTeam?.id));
    if (aFollowed !== bFollowed) return aFollowed ? -1 : 1;

    return a.priority - b.priority;
  });

  let html = '';
  for (const group of sortedGroups) {
    const isCollapsed = collapsedLeagues.has(group.code);
    const countLabel = `${group.matches.length} ${group.matches.length === 1 ? 'match' : 'matches'}`;

    html += `
      <div class="match-competition-group ${isCollapsed ? 'collapsed' : ''}" data-comp-code="${escapeHtml(group.code)}">
        <div class="competition-header" data-comp-code="${escapeHtml(group.code)}" role="button" aria-expanded="${!isCollapsed}" tabindex="0" title="Click to collapse / expand">
          <div class="competition-title">
            <span class="competition-badge-icon" aria-hidden="true">${escapeHtml(group.emoji)}</span>
            <span>${escapeHtml(group.name)}</span>
          </div>
          <div class="competition-right">
            <span class="competition-count">${countLabel}</span>
            <span class="competition-chevron" aria-hidden="true">▼</span>
          </div>
        </div>
        <div class="matches-in-group">
          ${group.matches.map(m => renderMatchCard(m, currentDateRange)).join('')}
        </div>
      </div>`;
  }

  matchesList.innerHTML = html;
}

// ── Toggle League Collapse State ────────
function toggleLeagueCollapse(compCode) {
  if (collapsedLeagues.has(compCode)) {
    collapsedLeagues.delete(compCode);
  } else {
    collapsedLeagues.add(compCode);
  }
  chrome.storage.local.set({ collapsedLeagues: Array.from(collapsedLeagues) });

  const groupEl = document.querySelector(`.match-competition-group[data-comp-code="${compCode}"]`);
  if (groupEl) {
    const isNowCollapsed = collapsedLeagues.has(compCode);
    groupEl.classList.toggle('collapsed', isNowCollapsed);
    const header = groupEl.querySelector('.competition-header');
    if (header) header.setAttribute('aria-expanded', String(!isNowCollapsed));
  }
}

// ── Render Match Card with Direct Links & Team Star ─
function renderMatchCard(match, dateRange) {
  const homeTeam = match.homeTeam || {};
  const awayTeam = match.awayTeam || {};
  const status = match.status;
  const score = match.score || {};

  const isLive = (status === 'IN_PLAY' || status === 'PAUSED' || match.isLive);
  const isFinished = (status === 'FINISHED' || match.isFinished);

  // Contextual Left Column
  let leftColHtml = '';
  if (dateRange === 'week') {
    const d = new Date(match.utcDate);
    const weekday = d.toLocaleDateString([], { weekday: 'short' }).toUpperCase().slice(0, 3);
    const day = d.getDate();
    leftColHtml = `<span class="card-left-label date-label" aria-label="${weekday} ${day}">${weekday}<br>${day}</span>`;
  } else if (isLive) {
    const elapsed = match.elapsedMins != null ? `${match.elapsedMins}'` : (match.minute != null ? `${match.minute}'` : (status === 'PAUSED' ? 'HT' : 'LIVE'));
    leftColHtml = `<span class="card-left-label live-label" aria-label="Live ${elapsed}"><span class="live-dot-sm" aria-hidden="true"></span>${elapsed}</span>`;
  } else if (isFinished) {
    leftColHtml = `<span class="card-left-label ft-label" aria-label="Full Time">FT</span>`;
  } else {
    const matchTime = new Date(match.utcDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    leftColHtml = `<span class="card-left-label time-label" aria-label="Kickoff time ${matchTime}">${matchTime}</span>`;
  }

  // Winning / Losing team distinction
  let homeWinnerClass = '';
  let awayWinnerClass = '';
  let scoreHtml = '';
  let statusBadgeHtml = '';
  let mediaBtnHtml = '';

  const ft = score.fullTime || {};

  if (isFinished) {
    const homeGoals = (ft.home !== null && ft.home !== undefined) ? ft.home : null;
    const awayGoals = (ft.away !== null && ft.away !== undefined) ? ft.away : null;

    if (homeGoals !== null && awayGoals !== null) {
      if (homeGoals > awayGoals) {
        homeWinnerClass = 'team-winner';
        awayWinnerClass = 'team-loser';
      } else if (awayGoals > homeGoals) {
        homeWinnerClass = 'team-loser';
        awayWinnerClass = 'team-winner';
      }
      scoreHtml = `<span class="match-score">${homeGoals} – ${awayGoals}</span>`;
    } else {
      scoreHtml = `<span class="match-score">FT</span>`;
    }

    if (match.highlightsUrl) {
      mediaBtnHtml = `
        <button class="btn-media highlights open-tab-link" data-url="${escapeHtml(match.highlightsUrl)}" title="Watch full highlights on HooFoot" aria-label="Watch Highlights">
          🎬 Highlights
        </button>`;
    } else {
      mediaBtnHtml = `
        <span class="btn-media highlights disabled" title="Highlights not yet published" aria-label="Highlights Soon">
          ⏳ Soon
        </span>`;
    }
  } else if (isLive) {
    scoreHtml = `<span class="match-score">${ft.home ?? 0} – ${ft.away ?? 0}</span>`;
    mediaBtnHtml = `
      <button class="btn-media live open-tab-link" data-url="${escapeHtml(match.liveStreamUrl)}" title="Watch live match stream on VIPBox" aria-label="Watch Live">
        <span class="live-dot-mini" aria-hidden="true"></span> Live
      </button>`;
  } else {
    // Scheduled / Timed
    scoreHtml = `<span class="match-vs">vs</span>`;
    statusBadgeHtml = `<span class="match-countdown" data-utc="${escapeHtml(match.utcDate)}">${getCountdown(match.utcDate)}</span>`;
    mediaBtnHtml = `
      <button class="btn-media stream open-tab-link" data-url="${escapeHtml(match.liveStreamUrl)}" title="Stream schedule on VIPBox" aria-label="Open Stream">
        📺 Stream
      </button>`;
  }

  // Primary URL for clicking anywhere on the card
  const primaryUrl = isFinished ? (match.highlightsUrl || 'https://hoofoot.net') : (match.liveStreamUrl || 'https://vipbox.ga/football-schedule');

  // Check if teams are followed
  const isHomeFollowed = followedTeams.some(t => t.id === homeTeam.id);
  const isAwayFollowed = followedTeams.some(t => t.id === awayTeam.id);

  const homeFullName = homeTeam.name || homeTeam.shortName || 'TBD';
  const awayFullName = awayTeam.name || awayTeam.shortName || 'TBD';
  const compName = match.competitionName || '';

  return `
    <div class="match-card ${isLive ? 'is-live' : ''}" data-primary-url="${escapeHtml(primaryUrl)}" tabindex="0" role="link" aria-label="${escapeHtml(homeFullName)} versus ${escapeHtml(awayFullName)}">
      <div class="match-main-row">
        ${leftColHtml}
        <div class="match-teams-row">
          <div class="match-team home ${homeWinnerClass}">
            <button class="team-star-btn ${isHomeFollowed ? 'active' : ''}" 
                    data-team-id="${homeTeam.id}" 
                    data-team-name="${escapeHtml(homeFullName)}" 
                    data-team-crest="${escapeHtml(homeTeam.crest || '')}" 
                    data-comp-name="${escapeHtml(compName)}"
                    title="${isHomeFollowed ? 'Unfollow' : 'Follow'} ${escapeHtml(homeFullName)}"
                    aria-label="${isHomeFollowed ? 'Unfollow' : 'Follow'} ${escapeHtml(homeFullName)}">
              ${isHomeFollowed ? '★' : '☆'}
            </button>
            <img src="${escapeHtml(homeTeam.crest || CREST_FALLBACK)}" alt="" class="team-crest" loading="lazy" />
            <span class="team-name" title="${escapeHtml(homeFullName)}">${escapeHtml(homeTeam.shortName || homeTeam.name || 'TBD')}</span>
          </div>

          <div class="match-center">
            ${scoreHtml}
            ${statusBadgeHtml}
          </div>

          <div class="match-team away ${awayWinnerClass}">
            <span class="team-name" title="${escapeHtml(awayFullName)}">${escapeHtml(awayTeam.shortName || awayTeam.name || 'TBD')}</span>
            <img src="${escapeHtml(awayTeam.crest || CREST_FALLBACK)}" alt="" class="team-crest" loading="lazy" />
            <button class="team-star-btn ${isAwayFollowed ? 'active' : ''}" 
                    data-team-id="${awayTeam.id}" 
                    data-team-name="${escapeHtml(awayFullName)}" 
                    data-team-crest="${escapeHtml(awayTeam.crest || '')}" 
                    data-comp-name="${escapeHtml(compName)}"
                    title="${isAwayFollowed ? 'Unfollow' : 'Follow'} ${escapeHtml(awayFullName)}"
                    aria-label="${isAwayFollowed ? 'Unfollow' : 'Follow'} ${escapeHtml(awayFullName)}">
              ${isAwayFollowed ? '★' : '☆'}
            </button>
          </div>
        </div>
        <div class="match-action-row">
          ${mediaBtnHtml}
        </div>
      </div>
    </div>`;
}

// ── Countdown Calculation with Lapsed Match Defense ──
function getCountdown(utcDate) {
  const now = new Date();
  const match = new Date(utcDate);
  const diff = match - now;

  if (diff <= 0) {
    const elapsedMins = Math.floor((now - match) / (60 * 1000));
    if (elapsedMins > 115) return 'FT';
    if (elapsedMins > 90) return 'FT soon';
    if (elapsedMins > 45) return '2nd Half';
    return 'Live';
  }

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
  $$('.match-countdown').forEach(badge => {
    if (badge.dataset.utc) {
      badge.textContent = getCountdown(badge.dataset.utc);
    }
  });

  // 2. Relative time update
  updateRelativeTime();

  // 3. Auto-refresh only when live matches are active (throttled to at most once per 60s)
  const now = Date.now();
  const hasLive = currentMatches.some(m => m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.isLive);
  if (hasLive && currentTab === 'matches' && (now - lastLiveRefresh >= 60 * 1000)) {
    lastLiveRefresh = now;
    // Only refresh the competition(s) with live matches to minimize rate limit quota!
    const liveComps = Array.from(new Set(
      currentMatches.filter(m => m.status === 'IN_PLAY' || m.status === 'PAUSED' || m.isLive)
        .map(m => m.competitionCode)
    ));
    loadMatches(true, liveComps.length > 0 ? liveComps : null);
  }
}

// ── Relative Time Update ────────────────
function updateRelativeTime() {
  if (!lastFetchTimestamp) return;
  const elapsedSecs = Math.floor((Date.now() - lastFetchTimestamp) / 1000);

  if (elapsedSecs < 45) {
    lastUpdated.textContent = 'Updated just now';
  } else if (elapsedSecs < 3600) {
    const mins = Math.floor(elapsedSecs / 60);
    lastUpdated.textContent = `Updated ${mins}m ago`;
  } else {
    const timeStr = new Date(lastFetchTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lastUpdated.textContent = `Updated ${timeStr}`;
  }
}

// ── Skeleton & Error UI ─────────────────
function showMatchesSkeleton() {
  matchesList.innerHTML = `
    <div class="skeleton-group" aria-hidden="true">
      <div class="skeleton skeleton-header"></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton-header" style="margin-top:10px"></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
    </div>`;
}

function showMatchesError(message, isOffline = false) {
  matchesList.innerHTML = `
    <div class="error-state">
      <div class="error-icon" aria-hidden="true">${isOffline ? '📡' : '⚠️'}</div>
      <h3>${isOffline ? 'Offline Mode' : 'Something went wrong'}</h3>
      <p>${escapeHtml(message)}</p>
      <button class="btn-retry" id="retryBtn">Try Again</button>
    </div>`;
  const retryBtn = $('#retryBtn');
  if (retryBtn) retryBtn.addEventListener('click', () => loadMatches());
  setStatus(isOffline ? 'Offline' : 'Error loading matches');
}

// ── Render Leagues Tab ──────────────────
function renderLeagues() {
  const codes = Object.keys(allLeagues);
  leaguesGrid.innerHTML = codes.map(code => {
    const league = allLeagues[code];
    const isSelected = selectedLeagues.includes(code);
    return `
      <div class="league-card ${isSelected ? 'selected' : ''}" data-code="${escapeHtml(code)}" role="checkbox" aria-checked="${isSelected}" tabindex="0">
        <span class="league-emoji" aria-hidden="true">${escapeHtml(league.emoji)}</span>
        <div class="league-info">
          <div class="league-name">${escapeHtml(league.name)}</div>
          <div class="league-country">${escapeHtml(league.country)}</div>
        </div>
        <div class="league-toggle" aria-hidden="true"></div>
      </div>`;
  }).join('');

  $$('.league-card').forEach(card => {
    card.addEventListener('click', () => {
      toggleLeague(card.dataset.code, card);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggleLeague(card.dataset.code, card);
      }
    });
  });
}

function toggleLeague(code, card) {
  const idx = selectedLeagues.indexOf(code);
  if (idx > -1) {
    if (selectedLeagues.length === 1) return; // Keep at least one league
    selectedLeagues.splice(idx, 1);
    card.classList.remove('selected');
    card.setAttribute('aria-checked', 'false');
  } else {
    selectedLeagues.push(code);
    card.classList.add('selected');
    card.setAttribute('aria-checked', 'true');
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
    }, 320);
  });
}

function searchTeams(query) {
  searchResults.innerHTML = `
    <div class="skeleton-group" aria-hidden="true">
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
        <div class="empty-icon" aria-hidden="true">🔍</div>
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
        <img src="${escapeHtml(team.crest || CREST_FALLBACK)}" alt="" loading="lazy" />
        <div class="team-info">
          <div class="team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</div>
          <div class="team-league">${escapeHtml(team.competitionName || '')}</div>
        </div>
        <button class="team-follow-btn ${isFollowing ? 'following' : ''}" data-team-id="${team.id}" aria-label="${isFollowing ? 'Unfollow' : 'Follow'} ${escapeHtml(team.name)}">
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
      <div class="empty-state" style="padding: 24px 16px">
        <div class="empty-icon" aria-hidden="true">⭐</div>
        <h3>No Teams Followed</h3>
        <p>Search and follow your favorite clubs<br>to quickly filter their fixtures.</p>
      </div>`;
    return;
  }

  followedTeams.forEach(t => teamsCache.set(t.id, t));

  followedTeamsEl.innerHTML = `
    <div class="followed-label">Your Teams (${followedTeams.length})</div>
    ${followedTeams.map(team => `
      <div class="team-card" data-team-id="${team.id}">
        <img src="${escapeHtml(team.crest || CREST_FALLBACK)}" alt="" loading="lazy" />
        <div class="team-info">
          <div class="team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</div>
          <div class="team-league">${escapeHtml(team.competitionName || '')}</div>
        </div>
        <button class="team-follow-btn following" data-team-id="${team.id}" aria-label="Unfollow ${escapeHtml(team.name)}">
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

// ── Instant Team Follow / Unfollow (from card star or search) ─
function toggleFollowTeamSimple(team) {
  if (!team || !team.id) return;
  toggleFollowTeam(team);
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
    teamsCache.set(team.id, team);
    if (btnEl) {
      btnEl.classList.add('following');
      btnEl.textContent = '✓ Following';
    }
  }
  chrome.storage.local.set({ followedTeams });

  // Update star buttons on visible match cards immediately
  const isNowFollowed = followedTeams.some(t => t.id === team.id);
  $$(`.team-star-btn[data-team-id="${team.id}"]`).forEach(star => {
    star.classList.toggle('active', isNowFollowed);
    star.textContent = isNowFollowed ? '★' : '☆';
    star.title = `${isNowFollowed ? 'Unfollow' : 'Follow'} ${team.name || ''}`;
  });

  renderFollowedTeams();

  // If in 'followed' subfilter, re-filter view
  if (currentSubFilter === 'followed') {
    applyFiltersAndRender();
  }
}

// ── Refresh & Settings ──────────────────
function setupRefresh() {
  refreshBtn.addEventListener('click', () => {
    if (refreshBtn.classList.contains('spinning')) return;
    refreshBtn.classList.add('spinning');
    chrome.runtime.sendMessage({ type: 'REFRESH' }, () => {
      loadMatches();
      setTimeout(() => refreshBtn.classList.remove('spinning'), 750);
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
