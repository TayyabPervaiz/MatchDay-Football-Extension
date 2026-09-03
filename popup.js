/* ═══════════════════════════════════════════
   MatchDay – Popup Logic
   ═══════════════════════════════════════════ */

// ── State ───────────────────────────────
let currentTab = 'matches';
let currentDateRange = 'today';
let selectedLeagues = ['PL', 'CL'];
let followedTeams = [];
let showOnlyFollowed = false;
let allLeagues = {};

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

const CREST_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23555570'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3C/svg%3E";

// Fallback error handler using capturing phase (complies with MV3 CSP and avoids HTML syntax/attribute breakage)
document.addEventListener('error', (e) => {
    if (e.target && e.target.tagName === 'IMG') {
        e.target.onerror = null;
        e.target.src = CREST_FALLBACK;
    }
}, true);

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
    const stored = await chrome.storage.local.get(['selectedLeagues', 'followedTeams', 'showOnlyFollowed']);
    selectedLeagues = stored.selectedLeagues || ['PL', 'CL'];
    followedTeams = stored.followedTeams || [];
    showOnlyFollowed = stored.showOnlyFollowed || false;

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
    setupApiKeyForm();
    setupRefresh();
    setupSettings();
    setupTeamSearch();
    updateTabIndicator();

    // Load matches
    loadMatches();
    renderFollowedTeams();
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
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });
}

function switchTab(tab) {
    currentTab = tab;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    $(`#${tab}Tab`).classList.add('active');
    updateTabIndicator();

    // Show/hide date filter
    dateFilter.classList.toggle('hidden', tab !== 'matches');

    // Load data for the tab
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
        indicator.style.width = `${btnRect.width - 16}px`;
        indicator.style.left = `${btnRect.left - navRect.left + 8}px`;
    }
}

// ── Date Filter ─────────────────────────
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
    const fmt = (d) => d.toISOString().slice(0, 10);

    switch (currentDateRange) {
        case 'today':
            return { from: fmt(today), to: fmt(today) };
        case 'tomorrow': {
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            return { from: fmt(tomorrow), to: fmt(tomorrow) };
        }
        case 'week': {
            const weekEnd = new Date(today);
            weekEnd.setDate(weekEnd.getDate() + 7);
            return { from: fmt(today), to: fmt(weekEnd) };
        }
        default:
            return { from: fmt(today), to: fmt(today) };
    }
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
            showMatchesError('No response from background. Try refreshing.');
            return;
        }
        if (res.success) {
            let matches = res.data;

            // Filter by followed teams if toggle is on
            if (showOnlyFollowed && followedTeams.length > 0) {
                const followedIds = new Set(followedTeams.map(t => t.id));
                matches = matches.filter(m =>
                    followedIds.has(m.homeTeam?.id) || followedIds.has(m.awayTeam?.id)
                );
            }

            renderMatches(matches);
            setStatus(`${matches.length} match${matches.length !== 1 ? 'es' : ''} found`);
            setLastUpdated();
        } else {
            if (res.error === 'NO_API_KEY') {
                apiKeyOverlay.classList.remove('hidden');
            } else if (res.error === 'INVALID_API_KEY') {
                showMatchesError('Invalid API key. Please update in Settings.');
            } else if (res.error === 'RATE_LIMIT') {
                showMatchesError('API rate limit reached. Please wait a moment.');
            } else {
                showMatchesError(res.error || 'Failed to load matches.');
            }
        }
    });
}

// ── Render Matches ──────────────────────
function renderMatches(matches) {
    if (!matches || matches.length === 0) {
        matchesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>No Matches Found</h3>
        <p>No matches scheduled for this period.<br>Try selecting more leagues or a different date range.</p>
      </div>`;
        return;
    }

    // Group matches by date
    const grouped = {};
    matches.forEach(match => {
        const date = new Date(match.utcDate).toLocaleDateString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric'
        });
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(match);
    });

    let html = '';

    // Add filter bar if user has followed teams
    if (followedTeams.length > 0) {
        html += `
      <div class="filter-bar">
        <button class="filter-chip ${!showOnlyFollowed ? 'active' : ''}" id="filterAll">All Matches</button>
        <button class="filter-chip ${showOnlyFollowed ? 'active' : ''}" id="filterFollowed">My Teams</button>
      </div>`;
    }

    for (const [date, dateMatches] of Object.entries(grouped)) {
        html += `
      <div class="match-date-group">
        <div class="match-date-label">${date}</div>
        ${dateMatches.map(m => renderMatchCard(m)).join('')}
      </div>`;
    }

    matchesList.innerHTML = html;

    // Bind filter buttons
    const filterAll = $('#filterAll');
    const filterFollowed = $('#filterFollowed');
    if (filterAll) {
        filterAll.addEventListener('click', () => {
            showOnlyFollowed = false;
            chrome.storage.local.set({ showOnlyFollowed: false });
            loadMatches();
        });
    }
    if (filterFollowed) {
        filterFollowed.addEventListener('click', () => {
            showOnlyFollowed = true;
            chrome.storage.local.set({ showOnlyFollowed: true });
            loadMatches();
        });
    }
}

function renderMatchCard(match) {
    const homeTeam = match.homeTeam || {};
    const awayTeam = match.awayTeam || {};
    const status = match.status;
    const score = match.score || {};

    let scoreDisplay = '';
    let statusBadge = '';
    let timeDisplay = '';

    const matchTime = new Date(match.utcDate).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: true
    });

    if (status === 'FINISHED') {
        const ft = score.fullTime || {};
        scoreDisplay = `<span class="score-display">${ft.home ?? '-'} – ${ft.away ?? '-'}</span>`;
        statusBadge = `<span class="match-status finished">FT</span>`;
    } else if (status === 'IN_PLAY' || status === 'PAUSED') {
        const ft = score.fullTime || {};
        scoreDisplay = `<span class="score-display">${ft.home ?? 0} – ${ft.away ?? 0}</span>`;
        statusBadge = `<span class="match-status live"><span class="live-dot"></span>${status === 'PAUSED' ? 'HT' : 'LIVE'}</span>`;
    } else {
        // SCHEDULED / TIMED
        scoreDisplay = `<span class="match-time">${matchTime}</span>`;
        statusBadge = `<span class="match-status scheduled">${getCountdown(match.utcDate)}</span>`;
    }

    return `
    <div class="match-card">
      <div class="league-badge">
        ${match.competitionEmoji || '⚽'} ${match.competitionName || 'Unknown League'}
      </div>
      <div class="match-teams">
        <div class="match-team home">
          <img src="${homeTeam.crest || CREST_FALLBACK}" alt="" />
          <span class="team-name">${homeTeam.shortName || homeTeam.name || 'TBD'}</span>
        </div>
        <div class="match-score">
          ${scoreDisplay}
          ${statusBadge}
        </div>
        <div class="match-team away">
          <span class="team-name">${awayTeam.shortName || awayTeam.name || 'TBD'}</span>
          <img src="${awayTeam.crest || CREST_FALLBACK}" alt="" />
        </div>
      </div>
    </div>`;
}

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

function showMatchesSkeleton() {
    matchesList.innerHTML = `
    <div class="skeleton-group">
      <div class="skeleton skeleton-header"></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
      <div class="skeleton skeleton-header" style="margin-top:16px"></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
    </div>`;
}

function showMatchesError(message) {
    matchesList.innerHTML = `
    <div class="error-state">
      <div class="error-icon">⚠️</div>
      <h3>Something went wrong</h3>
      <p>${message}</p>
      <button class="btn-retry" id="retryBtn">Try Again</button>
    </div>`;
    const retryBtn = $('#retryBtn');
    if (retryBtn) retryBtn.addEventListener('click', loadMatches);
    setStatus('Error loading matches');
}

// ── Render Leagues ──────────────────────
function renderLeagues() {
    const codes = Object.keys(allLeagues);
    leaguesGrid.innerHTML = codes.map(code => {
        const league = allLeagues[code];
        const isSelected = selectedLeagues.includes(code);
        return `
      <div class="league-card ${isSelected ? 'selected' : ''}" data-code="${code}">
        <span class="league-emoji">${league.emoji}</span>
        <div class="league-info">
          <div class="league-name">${league.name}</div>
          <div class="league-country">${league.country}</div>
        </div>
        <div class="league-toggle"></div>
      </div>`;
    }).join('');

    // Bind click events
    $$('.league-card').forEach(card => {
        card.addEventListener('click', () => {
            const code = card.dataset.code;
            toggleLeague(code, card);
        });
    });
}

function toggleLeague(code, card) {
    const idx = selectedLeagues.indexOf(code);
    if (idx > -1) {
        // Don't allow deselecting all
        if (selectedLeagues.length === 1) return;
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
        }, 400);
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
            searchResults.innerHTML = `<div class="empty-state"><p>Failed to search. Try again.</p></div>`;
        }
    });
}

function renderSearchResults(teams) {
    if (!teams || teams.length === 0) {
        searchResults.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>No teams found</h3>
        <p>Try a different search term</p>
      </div>`;
        return;
    }

    const followedIds = new Set(followedTeams.map(t => t.id));

    searchResults.innerHTML = teams.slice(0, 20).map(team => {
        const isFollowing = followedIds.has(team.id);
        return `
      <div class="team-card" data-team-id="${team.id}">
        <img src="${team.crest || CREST_FALLBACK}" alt="" />
        <div class="team-info">
          <div class="team-name">${team.name}</div>
          <div class="team-league">${team.competitionName || ''}</div>
        </div>
        <button class="team-follow-btn ${isFollowing ? 'following' : ''}" 
                data-team='${JSON.stringify(team).replace(/'/g, "\\'")}'>
          ${isFollowing ? '✓ Following' : '+ Follow'}
        </button>
      </div>`;
    }).join('');

    // Bind follow buttons
    searchResults.querySelectorAll('.team-follow-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const team = JSON.parse(btn.dataset.team);
            toggleFollowTeam(team, btn);
        });
    });
}

function renderFollowedTeams() {
    if (followedTeams.length === 0) {
        followedTeamsEl.innerHTML = `
      <div class="empty-state" style="padding: 24px">
        <div class="empty-icon">💚</div>
        <h3>No Teams Followed</h3>
        <p>Search and follow your favorite teams<br>to get personalized match updates</p>
      </div>`;
        return;
    }

    followedTeamsEl.innerHTML = `
    <div class="followed-label">Your Teams (${followedTeams.length})</div>
    ${followedTeams.map(team => `
      <div class="team-card" data-team-id="${team.id}">
        <img src="${team.crest || CREST_FALLBACK}" alt="" />
        <div class="team-info">
          <div class="team-name">${team.name}</div>
          <div class="team-league">${team.competitionName || ''}</div>
        </div>
        <button class="team-follow-btn following" 
                data-team='${JSON.stringify(team).replace(/'/g, "\\'")}'>
          ✓ Following
        </button>
      </div>
    `).join('')}`;

    // Bind unfollow buttons
    followedTeamsEl.querySelectorAll('.team-follow-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const team = JSON.parse(btn.dataset.team);
            toggleFollowTeam(team, btn);
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
}

// ── Refresh ─────────────────────────────
function setupRefresh() {
    refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('spinning');
        chrome.runtime.sendMessage({ type: 'REFRESH' }, () => {
            loadMatches();
            setTimeout(() => refreshBtn.classList.remove('spinning'), 800);
        });
    });
}

// ── Settings ────────────────────────────
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
    lastUpdated.textContent = `Updated ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}
