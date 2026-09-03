/* ═══════════════════════════════════════════
   MatchDay – Settings Page Logic
   ═══════════════════════════════════════════ */

const apiKeyField = document.getElementById('apiKeyField');
const toggleApiKey = document.getElementById('toggleApiKey');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
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
saveApiKeyBtn.addEventListener('click', () => {
    const key = apiKeyField.value.trim();
    if (!key) return;
    chrome.storage.local.set({ apiKey: key }, () => {
        showStatus('✓ API key saved!');
    });
});

// ── Clear cache ─────────────────────────
clearCacheBtn.addEventListener('click', async () => {
    const storage = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(storage).filter(k =>
        k.startsWith('matches_') || k.startsWith('teams_')
    );
    await chrome.storage.local.remove(cacheKeys);
    showStatus(`✓ Cleared ${cacheKeys.length} cached items`);
});

// ── Status message helper ───────────────
function showStatus(msg) {
    cacheStatus.textContent = msg;
    cacheStatus.classList.add('visible');
    setTimeout(() => cacheStatus.classList.remove('visible'), 3000);
}
