/* ═══════════════════════════════════════════
   MatchDay – Settings Page Logic
   Multi-Provider Support: OpenFootAPI & Football-Data.org
   ═══════════════════════════════════════════ */

const providerOpenFoot       = document.getElementById('providerOpenFoot');
const providerFootballData   = document.getElementById('providerFootballData');
const providerOpenFootLabel  = document.getElementById('providerOpenFootLabel');
const providerFootballDataLabel = document.getElementById('providerFootballDataLabel');
const getApiKeyLink          = document.getElementById('getApiKeyLink');

const apiKeyField    = document.getElementById('apiKeyField');
const toggleApiKey   = document.getElementById('toggleApiKey');
const saveApiKeyBtn  = document.getElementById('saveApiKeyBtn');
const testApiKeyBtn  = document.getElementById('testApiKeyBtn');
const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');
const apiKeyStatus   = document.getElementById('apiKeyStatus');

const vipboxBaseField  = document.getElementById('vipboxBaseField');
const hoofootBaseField = document.getElementById('hoofootBaseField');
const saveSourcesBtn   = document.getElementById('saveSourcesBtn');
const resetSourcesBtn  = document.getElementById('resetSourcesBtn');
const sourcesStatus    = document.getElementById('sourcesStatus');

const clearCacheBtn = document.getElementById('clearCacheBtn');
const cacheStatus   = document.getElementById('cacheStatus');

// In-memory keys for instant switching without losing typed text
const keys = {
  openfoot: '',
  football_data: ''
};
let currentProvider = 'openfoot';

const PROVIDER_METAS = {
  openfoot: {
    placeholder: 'Paste your OpenFootAPI key (e.g. of_live_...)...',
    helpText: "Don't have a key? Get a free OpenFootAPI key here →",
    helpUrl: 'https://openfootapi.com'
  },
  football_data: {
    placeholder: 'Paste your Football-Data.org API key...',
    helpText: "Don't have a key? Register for a free Football-Data.org key here →",
    helpUrl: 'https://www.football-data.org/client/register'
  }
};

function updateProviderUI(provider) {
  currentProvider = provider;
  const isOF = provider === 'openfoot';
  if (providerOpenFoot) providerOpenFoot.checked = isOF;
  if (providerFootballData) providerFootballData.checked = !isOF;
  providerOpenFootLabel?.classList.toggle('active', isOF);
  providerFootballDataLabel?.classList.toggle('active', !isOF);

  const meta = PROVIDER_METAS[provider];
  if (meta && apiKeyField) {
    apiKeyField.placeholder = meta.placeholder;
    apiKeyField.value = keys[provider] || '';
  }
  if (meta && getApiKeyLink) {
    getApiKeyLink.textContent = meta.helpText;
    getApiKeyLink.href = meta.helpUrl;
  }
}

// ── Load saved values ────────────────────
chrome.storage.local.get([
  'apiProvider',
  'apiKey',
  'apiKey_openfoot',
  'apiKey_footballdata',
  'vipboxBase',
  'hoofootBase'
], (data) => {
  currentProvider = data.apiProvider || 'openfoot';
  keys.openfoot = data.apiKey_openfoot || (currentProvider === 'openfoot' ? data.apiKey : '') || '';
  keys.football_data = data.apiKey_footballdata || (currentProvider === 'football_data' ? data.apiKey : '') || '';

  updateProviderUI(currentProvider);

  if (vipboxBaseField)  vipboxBaseField.value  = data.vipboxBase  || 'https://vipbox.ga';
  if (hoofootBaseField) hoofootBaseField.value = data.hoofootBase || 'https://hoofoot.net';
});

// ── Switch Provider Listeners ────────────
providerOpenFoot?.addEventListener('change', () => {
  if (providerOpenFoot.checked) {
    keys[currentProvider] = apiKeyField.value.trim();
    updateProviderUI('openfoot');
  }
});
providerFootballData?.addEventListener('change', () => {
  if (providerFootballData.checked) {
    keys[currentProvider] = apiKeyField.value.trim();
    updateProviderUI('football_data');
  }
});

// ── Toggle API key visibility ────────────
toggleApiKey?.addEventListener('click', () => {
  apiKeyField.type = apiKeyField.type === 'password' ? 'text' : 'password';
});

// ── Save API provider & key ──────────────
saveApiKeyBtn?.addEventListener('click', async () => {
  const key = apiKeyField.value.trim();
  keys[currentProvider] = key;

  const storageUpdate = {
    apiProvider: currentProvider,
    apiKey: key // Sync active key to legacy 'apiKey' for backward compatibility
  };

  if (currentProvider === 'openfoot') {
    storageUpdate.apiKey_openfoot = key;
  } else {
    storageUpdate.apiKey_footballdata = key;
  }

  await chrome.storage.local.set(storageUpdate);

  // Clear match fixtures caches so the newly selected API loads fresh data
  const storage = await chrome.storage.local.get(null);
  const matchKeys = Object.keys(storage).filter(k =>
    k.startsWith('date_') ||
    k.startsWith('comp_') ||
    k.startsWith('master_matches_') ||
    k.startsWith('matches_')
  );
  if (matchKeys.length) await chrome.storage.local.remove(matchKeys);

  showStatus(apiKeyStatus, `✓ Saved & applied ${PROVIDER_METAS[currentProvider]?.helpUrl ? (currentProvider === 'openfoot' ? 'OpenFootAPI' : 'Football-Data.org') : ''}!`);
});

// ── Test API key connection ──────────────
testApiKeyBtn?.addEventListener('click', () => {
  const key = apiKeyField.value.trim();
  if (!key) { showStatus(apiKeyStatus, 'Please enter a key to test', true); return; }

  showStatus(apiKeyStatus, `Testing ${currentProvider === 'openfoot' ? 'OpenFootAPI' : 'Football-Data.org'}...`);
  chrome.runtime.sendMessage({
    type: 'TEST_API_KEY',
    apiKey: key,
    provider: currentProvider
  }, (res) => {
    if (res?.success) {
      showStatus(apiKeyStatus, '✓ Connection successful!');
    } else {
      showStatus(apiKeyStatus, `❌ Connection failed (${res?.status || 'Error'})`, true);
    }
  });
});

// ── Clear API key ─────────────────────────
clearApiKeyBtn?.addEventListener('click', async () => {
  keys[currentProvider] = '';
  apiKeyField.value = '';
  const removeKey = currentProvider === 'openfoot' ? 'apiKey_openfoot' : 'apiKey_footballdata';
  await chrome.storage.local.remove([removeKey, 'apiKey']);
  showStatus(apiKeyStatus, '✓ Key cleared for this provider');
});

// ── Save stream source domains ───────────
if (saveSourcesBtn) {
  saveSourcesBtn.addEventListener('click', async () => {
    const vipbox  = (vipboxBaseField?.value  || '').trim().replace(/\/$/, '') || 'https://vipbox.ga';
    const hoofoot = (hoofootBaseField?.value || '').trim().replace(/\/$/, '') || 'https://hoofoot.net';
    await chrome.storage.local.set({ vipboxBase: vipbox, hoofootBase: hoofoot });
    const storage = await chrome.storage.local.get(null);
    const staleKeys = Object.keys(storage).filter(k => k === 'vipbox_schedule' || k.startsWith('hoofoot_index_'));
    if (staleKeys.length) await chrome.storage.local.remove(staleKeys);
    showStatus(sourcesStatus, '✓ Sources saved!');
  });
}

if (resetSourcesBtn) {
  resetSourcesBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['vipboxBase', 'hoofootBase']);
    if (vipboxBaseField)  vipboxBaseField.value  = 'https://vipbox.ga';
    if (hoofootBaseField) hoofootBaseField.value = 'https://hoofoot.net';
    showStatus(sourcesStatus, '✓ Reset to defaults');
  });
}

// ── Clear Cache ─────────────────────────
clearCacheBtn?.addEventListener('click', async () => {
  const storage = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(storage).filter(k =>
    k.startsWith('date_') ||
    k.startsWith('matches_') ||
    k.startsWith('teams_') ||
    k.startsWith('comp_') ||
    k.startsWith('master_matches_') ||
    k.startsWith('hoofoot_index_') ||
    k === 'vipbox_schedule'
  );
  await chrome.storage.local.remove(cacheKeys);
  showStatus(cacheStatus, `✓ Cleared ${cacheKeys.length} cached items`);
});

// ── Status helper ─────────────────────────
function showStatus(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 3500);
}
