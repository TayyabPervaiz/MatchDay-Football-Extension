/* Shared provider, source URL, and team identity settings. */
(() => {
  const DEFAULT_PROVIDER = 'openfoot';
  const PROVIDERS = Object.freeze({
    openfoot: { legacyKey: 'apiKey_openfoot' },
    football_data: { legacyKey: 'apiKey_footballdata' }
  });
  const DEFAULT_SOURCES = Object.freeze({
    vipbox: 'https://vipbox.ga',
    hoofoot: 'https://hoofoot.net'
  });
  const SOURCE_HOSTS = Object.freeze({
    vipbox: ['vipbox.ga', 'vipbox.lc', 'vipbox.be'],
    hoofoot: ['hoofoot.net']
  });

  function isSupportedProvider(provider) {
    return Object.hasOwn(PROVIDERS, provider);
  }

  function normalizeSourceBaseUrl(source, value) {
    if (!SOURCE_HOSTS[source] || typeof value !== 'string') return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' ||
          !SOURCE_HOSTS[source].includes(url.hostname.toLowerCase()) ||
          url.username || url.password || url.port ||
          (url.pathname !== '/' && url.pathname !== '') ||
          url.search || url.hash) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function isAllowedMatchUrl(source, value, sourceBase) {
    const url = normalizeMatchUrl(value);
    const base = normalizeSourceBaseUrl(source, sourceBase || DEFAULT_SOURCES[source]);
    return Boolean(url && base && url.origin === base && url.pathname !== '/');
  }

  function normalizeMatchUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      return url;
    } catch {
      return null;
    }
  }

  function getTeamIdentity(team, fallbackProvider = DEFAULT_PROVIDER) {
    if (team?.id === undefined || team?.id === null || String(team.id) === '') return null;
    return `${team.provider || fallbackProvider}:${String(team.id)}`;
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get([
      'apiKey', 'apiKeys', 'apiProvider', 'apiKey_openfoot',
      'apiKey_footballdata', 'vipboxBase', 'hoofootBase', 'followedTeams'
    ]);
    const provider = isSupportedProvider(stored.apiProvider)
      ? stored.apiProvider
      : DEFAULT_PROVIDER;
    const apiKeys = stored.apiKeys && typeof stored.apiKeys === 'object'
      ? { ...stored.apiKeys }
      : {};

    for (const [id, metadata] of Object.entries(PROVIDERS)) {
      if (!apiKeys[id] && stored[metadata.legacyKey]) apiKeys[id] = stored[metadata.legacyKey];
    }
    if (!apiKeys[provider] && stored.apiKey) apiKeys[provider] = stored.apiKey;

    const settings = {
      provider,
      apiKeys,
      apiKey: apiKeys[provider] || '',
      vipboxBase: normalizeSourceBaseUrl('vipbox', stored.vipboxBase) || DEFAULT_SOURCES.vipbox,
      hoofootBase: normalizeSourceBaseUrl('hoofoot', stored.hoofootBase) || DEFAULT_SOURCES.hoofoot
    };
    const followedTeams = Array.isArray(stored.followedTeams)
      ? stored.followedTeams.map(team => ({
        ...team,
        provider: team.provider || provider
      }))
      : [];
    const valuesToSave = {
      apiProvider: provider,
      apiKeys,
      apiKey: settings.apiKey,
      vipboxBase: settings.vipboxBase,
      hoofootBase: settings.hoofootBase,
      followedTeams
    };
    for (const [id, metadata] of Object.entries(PROVIDERS)) {
      if (apiKeys[id]) valuesToSave[metadata.legacyKey] = apiKeys[id];
    }
    await chrome.storage.local.set(valuesToSave);
    return settings;
  }

  async function setApiKey(provider, value) {
    if (!isSupportedProvider(provider)) throw new Error('UNSUPPORTED_PROVIDER');
    const settings = await getSettings();
    const apiKey = typeof value === 'string' ? value.trim() : '';
    const apiKeys = { ...settings.apiKeys, [provider]: apiKey };
    await chrome.storage.local.set({
      apiKeys,
      apiProvider: provider,
      apiKey,
      [PROVIDERS[provider].legacyKey]: apiKey
    });
  }

  async function setProvider(provider) {
    if (!isSupportedProvider(provider)) throw new Error('UNSUPPORTED_PROVIDER');
    const settings = await getSettings();
    await chrome.storage.local.set({
      apiProvider: provider,
      apiKey: settings.apiKeys[provider] || ''
    });
  }

  async function setSourceBases(vipboxBase, hoofootBase) {
    const vipbox = normalizeSourceBaseUrl('vipbox', vipboxBase);
    const hoofoot = normalizeSourceBaseUrl('hoofoot', hoofootBase);
    if (!vipbox || !hoofoot) throw new Error('INVALID_SOURCE_URL');
    await chrome.storage.local.set({ vipboxBase: vipbox, hoofootBase: hoofoot });
    return { vipboxBase: vipbox, hoofootBase: hoofoot };
  }

  globalThis.MatchDayStorage = Object.freeze({
    DEFAULT_PROVIDER,
    DEFAULT_SOURCES,
    PROVIDERS,
    getSettings,
    getTeamIdentity,
    isAllowedMatchUrl,
    isSupportedProvider,
    normalizeSourceBaseUrl,
    setApiKey,
    setProvider,
    setSourceBases
  });
})();
