/* ═══════════════════════════════════════════
   MatchDay – Settings Page Logic
   ═══════════════════════════════════════════ */

const apiKeyField = document.getElementById('apiKeyField');
const toggleApiKey = document.getElementById('toggleApiKey');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const testApiKeyBtn = document.getElementById('testApiKeyBtn');
const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');
const apiKeyStatus = document.getElementById('apiKeyStatus');

const clearCacheBtn = document.getElementById('clearCacheBtn');
const cacheStatus = document.getElementById('cacheStatus');

// ── Load saved API key ──────────────────
chrome.storage.local.get('apiKey', ({ apiKey }) => {
  if (apiKey) apiKeyField.value = apiKey;
});

// ── Toggle API key visibility ───────────
toggleApiKey.addEventListener('click', () => {
  apiKeyField.type = apiKeyField.type === 'password' ? 'text' : 'password';
});

// ── Save API key ────────────────────────
saveApiKeyBtn.addEventListener('click', async () => {
  const key = apiKeyField.value.trim();
  if (!key) {
    showStatus(apiKeyStatus, 'Please enter a key first', true);
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  showStatus(apiKeyStatus, '✓ API key saved!');
});

// ── Test API key connection ─────────────
testApiKeyBtn.addEventListener('click', () => {
  const key = apiKeyField.value.trim();
  if (!key) {
    showStatus(apiKeyStatus, 'Please enter a key to test', true);
    return;
  }

  showStatus(apiKeyStatus, 'Testing connection...');
  chrome.runtime.sendMessage({ type: 'TEST_API_KEY', apiKey: key }, (res) => {
    if (res?.success) {
      showStatus(apiKeyStatus, '✓ Connection successful!');
    } else {
      showStatus(apiKeyStatus, `❌ Connection failed (${res?.status || 'Error'})`, true);
    }
  });
});

// ── Clear API key ───────────────────────
clearApiKeyBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  apiKeyField.value = '';
  showStatus(apiKeyStatus, '✓ API key removed');
});

// ── Clear Cache ─────────────────────────
clearCacheBtn.addEventListener('click', async () => {
  const storage = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(storage).filter(k =>
    k.startsWith('matches_') || k.startsWith('teams_') || k === 'vipbox_schedule'
  );
  await chrome.storage.local.remove(cacheKeys);
  showStatus(cacheStatus, `✓ Cleared ${cacheKeys.length} cached items`);
});

// ── Status helper ───────────────────────
function showStatus(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 3500);
}
