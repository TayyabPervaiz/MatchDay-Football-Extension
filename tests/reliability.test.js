const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const storageSource = fs.readFileSync(path.join(root, 'storage.js'), 'utf8');
const crestsSource = fs.readFileSync(path.join(root, 'crests.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');

function createStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    local: {
      async get(keys) {
        if (keys === null) return { ...values };
        const requested = typeof keys === 'string' ? [keys] : keys;
        return Object.fromEntries(requested.map(key => [key, values[key]]));
      },
      async set(update) {
        Object.assign(values, update);
      },
      async remove(keys) {
        for (const key of keys) delete values[key];
      },
      async getBytesInUse() {
        return 0;
      }
    }
  };
}

function loadStorageHelper(initial = {}) {
  const storage = createStorage(initial);
  const context = vm.createContext({ chrome: { storage }, URL });
  vm.runInContext(storageSource, context);
  return { helper: context.MatchDayStorage, storage };
}

function loadWorker({
  initialStorage = {},
  fetchResponse = async () => ({ ok: false, status: 503 }),
  withBundledCrests = false
} = {}) {
  const storage = createStorage(initialStorage);
  let messageListener;
  const chrome = {
    storage,
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      onInstalled: { addListener() {} }
    },
    alarms: { onAlarm: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    notifications: { create() {} }
  };
  const context = vm.createContext({
    chrome,
    URL,
    URLSearchParams,
    fetch: async (url, options) => fetchResponse(String(url), options),
    console: { warn() {} },
    setTimeout,
    clearTimeout
  });
  context.importScripts = filename => {
    if (filename === 'storage.js') vm.runInContext(storageSource, context);
    if (filename === 'crests.js') {
      if (withBundledCrests) vm.runInContext(crestsSource, context);
      else context.BUNDLED_CRESTS = {};
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return {
    context,
    storage,
    send(message) {
      return new Promise(resolve => messageListener(message, {}, resolve));
    }
  };
}

test('migrates active legacy key and preserves both provider keys and unrelated keys', async () => {
  const { helper, storage } = loadStorageHelper({
    apiProvider: 'openfoot',
    apiKey: 'legacy-openfoot',
    apiKey_footballdata: 'football-data-key',
    apiKeys: { another_provider: 'keep-me' },
    followedTeams: [{ id: 21, name: 'Legacy favorite' }]
  });

  const settings = await helper.getSettings();
  assert.equal(settings.apiKeys.openfoot, 'legacy-openfoot');
  assert.equal(settings.apiKeys.football_data, 'football-data-key');
  assert.equal(storage.values.followedTeams[0].provider, 'openfoot');
  assert.equal(storage.values.followedTeams[0].id, 21);

  await helper.setProvider('football_data');
  assert.equal(storage.values.apiKey, 'football-data-key');
  assert.equal(storage.values.apiKey_openfoot, 'legacy-openfoot');
  assert.equal(storage.values.apiKey_footballdata, 'football-data-key');
  assert.equal(storage.values.apiKeys.another_provider, 'keep-me');

  await helper.setApiKey('football_data', 'updated-fd-key');
  assert.equal(storage.values.apiKey, 'updated-fd-key');
  assert.equal(storage.values.apiKey_footballdata, 'updated-fd-key');
  assert.equal(storage.values.apiKey_openfoot, 'legacy-openfoot');
});

test('limits configured source bases and match links to HTTPS allowlisted hosts', () => {
  const { helper } = loadStorageHelper();
  assert.equal(helper.normalizeSourceBaseUrl('vipbox', 'https://vipbox.lc'), 'https://vipbox.lc');
  assert.equal(helper.normalizeSourceBaseUrl('vipbox', 'http://vipbox.ga'), null);
  assert.equal(helper.normalizeSourceBaseUrl('vipbox', 'https://evil.example'), null);
  assert.equal(helper.normalizeSourceBaseUrl('hoofoot', 'https://hoofoot.net/path'), null);
  assert.equal(
    helper.isAllowedMatchUrl('vipbox', 'https://vipbox.lc/onair/football/match', 'https://vipbox.lc'),
    true
  );
  assert.equal(helper.isAllowedMatchUrl('vipbox', 'https://vipbox.lc/', 'https://vipbox.lc'), false);
  assert.equal(
    helper.isAllowedMatchUrl('vipbox', 'https://evil.example/match', 'https://vipbox.lc'),
    false
  );
});

test('team identities include provider and preserve source IDs', () => {
  const { helper } = loadStorageHelper();
  const footballDataTeam = { id: 42, provider: 'football_data' };
  const openFootTeam = { id: 42, provider: 'openfoot' };

  assert.equal(helper.getTeamIdentity(footballDataTeam), 'football_data:42');
  assert.notEqual(
    helper.getTeamIdentity(footballDataTeam),
    helper.getTeamIdentity(openFootTeam)
  );
  assert.equal(footballDataTeam.id, 42);
});

test('bundled badges resolve Bodø/Glimt and LASK variants and override unverified API logos', async () => {
  const worker = loadWorker({ withBundledCrests: true });
  const matches = [{
    homeTeam: {
      name: 'FK Bodø/Glimt',
      shortName: 'Bodø/Glimt',
      crest: 'https://wrong.example/bodo.png'
    },
    awayTeam: {
      name: 'LASK Linz',
      shortName: 'LASK',
      crest: 'https://wrong.example/lask.png'
    }
  }];

  await vm.runInContext('hydrateCrests(globalThis.testMatches)', Object.assign(worker.context, {
    testMatches: matches
  }));

  assert.equal(
    matches[0].homeTeam.crest,
    'https://a.espncdn.com/i/teamlogos/soccer/500/8157.png'
  );
  assert.equal(
    matches[0].awayTeam.crest,
    'https://a.espncdn.com/i/teamlogos/soccer/500/4411.png'
  );
  assert.equal(
    vm.runInContext('lookupCrest("LASK")', worker.context),
    'https://a.espncdn.com/i/teamlogos/soccer/500/4411.png'
  );
  assert.equal(vm.runInContext('lookupCrest("GAL")', worker.context), '');
});

test('external crest search rejects ambiguous aliases and selects only an exact identity', async () => {
  const worker = loadWorker({
    initialStorage: {
      crest_name_united: {
        value: 'https://stale-wrong.example/united.png',
        timestamp: Date.now()
      }
    },
    fetchResponse: async url => {
      const query = new URL(url).searchParams.get('t');
      if (query === 'United') {
        return {
          ok: true,
          async json() {
            return { teams: [
              { idTeam: '1', strTeam: 'North United', strTeamShort: 'United', strBadge: 'https://wrong.example/north.png' },
              { idTeam: '2', strTeam: 'South United', strTeamShort: 'United', strBadge: 'https://wrong.example/south.png' }
            ] };
          }
        };
      }
      if (query === 'Harbor FC') {
        return {
          ok: true,
          async json() {
            return { teams: [
              { idTeam: '3', strTeam: 'Harbor United', strTeamShort: 'Harbor', strBadge: 'https://wrong.example/united.png' },
              { idTeam: '4', strTeam: 'Harbor FC', strTeamShort: 'HFC', strBadge: 'https://correct.example/harbor.png' }
            ] };
          }
        };
      }
      return { ok: false, status: 404 };
    }
  });

  const ambiguous = await vm.runInContext('fetchTeamCrest("United")', worker.context);
  const exact = await vm.runInContext('fetchTeamCrest("Harbor FC")', worker.context);

  assert.equal(ambiguous, null);
  assert.equal(exact, 'https://correct.example/harbor.png');
  assert.equal(
    Object.keys(worker.storage.values).some(key => key.startsWith('crest_name_verified_v2_united')),
    false
  );
  assert.equal(
    worker.storage.values.crest_name_verified_v2_harbor_fc.value,
    'https://correct.example/harbor.png'
  );
});

test('GET_LEAGUES attaches validated emblems for every supported competition', async () => {
  const leaguesByCountry = {
    England: ['English Premier League', 'English Championship'],
    Europe: ['UEFA Champions League', 'UEFA Nations League'],
    Spain: ['Spanish La Liga'],
    Germany: ['German Bundesliga'],
    Italy: ['Italian Serie A'],
    France: ['French Ligue 1'],
    Portugal: ['Portuguese Primeira Liga'],
    Netherlands: ['Dutch Eredivisie'],
    Brazil: ['Brazilian Serie A'],
    International: ['FIFA World Cup']
  };
  const worker = loadWorker({
    fetchResponse: async url => {
      const country = new URL(url).searchParams.get('c');
      const countries = (leaguesByCountry[country] || []).map((strLeague, index) => ({
        idLeague: `${country}-${index}`,
        strLeague,
        strSport: 'Soccer',
        strBadge: `https://r2.thesportsdb.com/images/media/league/badge/${country}-${index}.png`
      }));
      return { ok: true, async json() { return { countries }; } };
    }
  });

  const response = await worker.send({ type: 'GET_LEAGUES' });
  const codes = Object.keys(response.data);

  assert.equal(response.success, true);
  assert.equal(codes.length, 12);
  for (const code of codes) {
    assert.match(response.data[code].emblemUrl, /^https:\/\/r2\.thesportsdb\.com\/images\/media\/league\/badge\//, `missing validated emblem for ${code}`);
  }
  assert.equal(vm.runInContext(
    'isAllowedLeagueBadge("https://r2.thesportsdb.com/images/media/league/badge/example.png")',
    worker.context
  ), true);
  assert.equal(vm.runInContext(
    'isAllowedLeagueBadge("https://example.com/images/media/league/badge/example.png")',
    worker.context
  ), false);
  assert.equal(vm.runInContext(
    'isAllowedLeagueBadge("http://r2.thesportsdb.com/images/media/league/badge/example.png")',
    worker.context
  ), false);
});

test('league emblem markup has accessible labels and an accessible failure fallback', () => {
  let errorHandler;
  const document = {
    addEventListener(type, handler) {
      if (type === 'error') errorHandler = handler;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
      };
    }
  };
  const context = vm.createContext({
    chrome: { runtime: { sendMessage() {} } },
    document,
    MatchDayStorage: {
      DEFAULT_PROVIDER: 'openfoot',
      DEFAULT_SOURCES: { vipbox: 'https://vipbox.ga', hoofoot: 'https://hoofoot.net' },
      getTeamIdentity() { return null; },
      isAllowedMatchUrl() { return false; }
    },
    URL,
    console: { warn() {} },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(popupSource, context);

  const image = vm.runInContext(
    'leagueEmblemHtml({ name: "Premier League", emblemUrl: "https://r2.thesportsdb.com/images/media/league/badge/pl.png" }, "PL")',
    context
  );
  const fallback = vm.runInContext('leagueEmblemHtml({ name: "World Cup" }, "WC")', context);
  let replacedWith;
  const failedImage = {
    tagName: 'IMG',
    alt: 'Premier League emblem',
    dataset: { fallback: 'PL' },
    classList: { contains(name) { return name === 'league-emblem'; } },
    replaceWith(element) { replacedWith = element; }
  };
  errorHandler({ target: failedImage });

  assert.match(image, /alt="Premier League emblem"/);
  assert.match(image, /class="league-emblem"/);
  assert.match(fallback, /role="img" aria-label="World Cup emblem unavailable"/);
  assert.equal(replacedWith.className, 'league-emblem-fallback');
  assert.equal(replacedWith.attributes.role, 'img');
  assert.equal(replacedWith.attributes['aria-label'], 'Premier League emblem unavailable');
  assert.equal(replacedWith.textContent, 'PL');
});

test('scheduled matches past kickoff keep their API status and expose elapsed time only', async () => {
  const worker = loadWorker();
  const result = await vm.runInContext(`enrichMatch({
    id: 'old-fixture',
    status: 'SCHEDULED',
    utcDate: '2020-01-01T10:00:00Z',
    competition: { code: 'PL', name: 'Premier League' },
    homeTeam: { id: 1, name: 'Home FC', shortName: 'Home' },
    awayTeam: { id: 2, name: 'Away FC', shortName: 'Away' }
  }, [], {
    provider: 'openfoot',
    vipboxBase: 'https://vipbox.ga',
    hoofootBase: 'https://hoofoot.net'
  })`, worker.context);

  assert.equal(result.status, 'SCHEDULED');
  assert.equal(result.isLive, false);
  assert.equal(result.isFinished, false);
  assert.ok(result.elapsedMins > 0);
  assert.equal(result.liveStreamUrl, null);
  assert.equal(result.highlightsUrl, null);
});

test('unknown or conflicting upstream statuses are not guessed into completed matches', () => {
  const worker = loadWorker();
  const footballDataStatus = vm.runInContext(
    `normalizeFootballDataMatch({ status: null, competition: {}, homeTeam: {}, awayTeam: {} }).status`,
    worker.context
  );
  const openFootStatus = vm.runInContext(
    `normalizeMatch({ status: 'scheduled', period: 'FT', homeTeam: {}, awayTeam: {} }).status`,
    worker.context
  );

  assert.equal(footballDataStatus, 'UNKNOWN');
  assert.equal(openFootStatus, 'SCHEDULED');
});

test('HooFoot search returns no guessed match URL when no article matches', async () => {
  const worker = loadWorker({
    fetchResponse: async () => ({
      ok: true,
      async text() { return '<html><body>No match articles</body></html>'; }
    })
  });
  const url = await vm.runInContext(
    `findHoofootUrl('Arsenal', 'Chelsea', 'premier-league', '2020-01-01T10:00:00Z')`,
    worker.context
  );
  const oneTeamScore = vm.runInContext(
    `slugMatchScore('arsenal-highlights-2020', ['arsenal'], ['chelsea'])`,
    worker.context
  );

  assert.equal(url, null);
  assert.equal(oneTeamScore, 0);
});

test('Football-Data team search uses competition team endpoint and provider-safe IDs', async () => {
  let requestedUrl = '';
  const worker = loadWorker({
    initialStorage: { apiProvider: 'football_data', apiKey: 'fd-key' },
    fetchResponse: async url => {
      requestedUrl = url;
      return {
        ok: true,
        async json() {
          return { teams: [{ id: 7, name: 'Example FC', shortName: 'Example', tla: 'EXM' }] };
        }
      };
    }
  });

  const response = await worker.send({
    type: 'SEARCH_TEAMS',
    query: 'example',
    leagues: ['PL']
  });
  assert.equal(response.success, true);
  assert.match(requestedUrl, /\/competitions\/PL\/teams$/);
  assert.equal(response.data[0].provider, 'football_data');
  assert.equal(response.data[0].id, 7);
  assert.equal(worker.storage.values['teams_football_data_PL'].value[0].provider, 'football_data');
});

test('Football-Data team search falls back to expired cached teams on API failure', async () => {
  const worker = loadWorker({
    initialStorage: {
      apiProvider: 'football_data',
      apiKey: 'fd-key',
      teams_football_data_PL: {
        timestamp: 0,
        value: [{ id: 'team-7', name: 'Cached United' }]
      }
    }
  });
  const response = await worker.send({
    type: 'SEARCH_TEAMS',
    query: 'cached',
    leagues: ['PL']
  });

  assert.equal(response.success, true);
  assert.equal(response.data[0].id, 'team-7');
  assert.equal(response.data[0].provider, 'football_data');
});

test('forced targeted match refresh bypasses provider cache and replaces empty results', async () => {
  let matchList = [{
    id: 8,
    utcDate: '2099-01-01T10:00:00Z',
    status: 'SCHEDULED',
    competition: { id: 1, code: 'PL', name: 'Premier League' },
    homeTeam: { id: 1, name: 'Home FC', shortName: 'Home', crest: 'https://example.test/home.png' },
    awayTeam: { id: 2, name: 'Away FC', shortName: 'Away', crest: 'https://example.test/away.png' },
    score: {}
  }];
  let apiCalls = 0;
  const worker = loadWorker({
    initialStorage: { apiProvider: 'football_data', apiKey: 'fd-key' },
    fetchResponse: async url => {
      if (url.includes('/competitions/PL/matches')) {
        apiCalls++;
        return { ok: true, async json() { return { matches: matchList }; } };
      }
      if (url === 'https://vipbox.ga/football-schedule') {
        return { ok: true, async text() { return '<html></html>'; } };
      }
      return { ok: false, status: 404 };
    }
  });

  const request = {
    type: 'GET_MATCHES',
    dateFrom: '2099-01-01',
    dateTo: '2099-01-01',
    competitions: ['PL'],
    forceRefresh: true
  };
  const first = await worker.send(request);
  assert.equal(first.data.length, 1);
  matchList = [];
  const refreshed = await worker.send(request);

  assert.equal(refreshed.success, true);
  assert.equal(refreshed.data.length, 0);
  assert.equal(apiCalls, 2);
  assert.ok(Object.keys(worker.storage.values).some(key =>
    key.startsWith('master_matches_football_data_')
  ));
});

test('concurrent identical match requests share one provider API call', async () => {
  let apiCalls = 0;
  const worker = loadWorker({
    initialStorage: { apiProvider: 'openfoot', apiKey: 'of-key' },
    fetchResponse: async url => {
      if (url.startsWith('https://openfootapi.com/')) {
        apiCalls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { ok: true, async json() { return { data: [] }; } };
      }
      return { ok: false, status: 503 };
    }
  });
  const request = {
    type: 'GET_MATCHES',
    dateFrom: '2099-01-01',
    dateTo: '2099-01-01',
    competitions: ['PL'],
    forceRefresh: true
  };

  const [first, second] = await Promise.all([
    worker.send(request),
    worker.send(request)
  ]);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.length, 0);
  assert.equal(second.data.length, 0);
  assert.equal(apiCalls, 1);
});

test('match loading fetches its stream schedule while the provider request is in flight', async () => {
  let releaseProviderRequest;
  let providerRequestStarted;
  const providerStarted = new Promise(resolve => { providerRequestStarted = resolve; });
  let streamScheduleRequested = false;
  const worker = loadWorker({
    initialStorage: { apiProvider: 'openfoot', apiKey: 'of-key' },
    fetchResponse: async url => {
      if (url.startsWith('https://openfootapi.com/')) {
        providerRequestStarted();
        await new Promise(resolve => { releaseProviderRequest = resolve; });
        return { ok: true, async json() { return { data: [] }; } };
      }
      if (url === 'https://vipbox.ga/football-schedule') {
        streamScheduleRequested = true;
        return { ok: true, async text() { return '<html></html>'; } };
      }
      return { ok: false, status: 503 };
    }
  });

  const pendingResponse = worker.send({
    type: 'GET_MATCHES',
    dateFrom: '2099-01-01',
    dateTo: '2099-01-01',
    competitions: ['PL']
  });
  await providerStarted;
  await new Promise(resolve => setTimeout(resolve, 10));

  try {
    assert.equal(streamScheduleRequested, true);
  } finally {
    releaseProviderRequest();
  }

  assert.equal((await pendingResponse).success, true);
});

test('malformed provider payloads are reported as fetch errors and are not cached as empty matches', async () => {
  for (const provider of ['openfoot', 'football_data']) {
    const worker = loadWorker({
      initialStorage: { apiProvider: provider, apiKey: 'test-key' },
      fetchResponse: async url => {
        if (url.includes('/matches')) {
          return { ok: true, async json() { return { unexpected: [] }; } };
        }
        return { ok: false, status: 404 };
      }
    });

    const response = await worker.send({
      type: 'GET_MATCHES',
      dateFrom: '2099-01-01',
      dateTo: '2099-01-01',
      competitions: ['PL']
    });

    assert.equal(response.success, true);
    assert.equal(response.hasFetchError, true);
    assert.equal(response.data.length, 0);
    assert.equal(Object.keys(worker.storage.values).some(key =>
      key.startsWith(`matches_${provider}_`)
    ), false);
  }
});

test('popup clears its loading flag after a runtime request failure', async () => {
  const elements = new Map();
  for (const selector of ['#matchesList', '#statusText', '#lastUpdated']) {
    elements.set(selector, {
      innerHTML: '',
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}
    });
  }
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        this.lastError = { message: 'disconnected' };
        callback(undefined);
        this.lastError = null;
      }
    }
  };
  const context = vm.createContext({
    chrome,
    document: {
      addEventListener() {},
      querySelector(selector) { return elements.get(selector) || null; },
      querySelectorAll() { return []; }
    },
    MatchDayStorage: {
      DEFAULT_PROVIDER: 'openfoot',
      DEFAULT_SOURCES: { vipbox: 'https://vipbox.ga', hoofoot: 'https://hoofoot.net' },
      getTeamIdentity() { return null; },
      isAllowedMatchUrl() { return false; }
    },
    URL,
    console: { warn() {} },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), context);

  await vm.runInContext('loadMatches()', context);
  assert.equal(vm.runInContext('isFetching', context), false);
  assert.match(elements.get('#matchesList').innerHTML, /Connection error/);
});

test('popup refresh forces its selected fixture request and shows provider failures explicitly', async () => {
  const elements = new Map();
  for (const selector of ['#matchesList', '#statusText', '#lastUpdated', '#apiKeyOverlay']) {
    elements.set(selector, {
      innerHTML: '',
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}
    });
  }

  let refreshHandler;
  elements.set('#refreshBtn', {
    classList: { contains() { return false; }, add() {}, remove() {} },
    addEventListener(_type, handler) { refreshHandler = handler; }
  });

  const requests = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        requests.push(message);
        callback({
          success: true,
          data: [],
          hasFetchError: true,
          isRateLimited: true
        });
      }
    }
  };
  const context = vm.createContext({
    chrome,
    document: {
      addEventListener() {},
      querySelector(selector) { return elements.get(selector) || null; },
      querySelectorAll() { return []; }
    },
    MatchDayStorage: {
      DEFAULT_PROVIDER: 'openfoot',
      DEFAULT_SOURCES: { vipbox: 'https://vipbox.ga', hoofoot: 'https://hoofoot.net' },
      getTeamIdentity() { return null; },
      isAllowedMatchUrl() { return false; }
    },
    URL,
    console: { warn() {} },
    setTimeout(callback) { callback(); },
    clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), context);
  vm.runInContext('setupRefresh()', context);
  await refreshHandler();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'GET_MATCHES');
  assert.equal(requests[0].forceRefresh, true);
  assert.deepEqual(Array.from(requests[0].competitions), ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1']);
  assert.equal(typeof requests[0].dateFrom, 'string');
  assert.equal(requests[0].dateFrom, requests[0].dateTo);
  assert.match(elements.get('#matchesList').innerHTML, /rate limit was reached/);
  assert.doesNotMatch(elements.get('#matchesList').innerHTML, /No matches found/);

  vm.runInContext(`
    currentMatches = [{ id: 'previous-match' }];
    applyFiltersAndRender = () => {
      document.querySelector('#matchesList').innerHTML = 'previously loaded match';
    };
  `, context);
  await refreshHandler();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].forceRefresh, true);
  assert.equal(elements.get('#matchesList').innerHTML, 'previously loaded match');
  assert.match(elements.get('#statusText').textContent, /previously loaded matches/);
  assert.equal(vm.runInContext('isFetching', context), false);
});
