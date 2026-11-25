# MatchDay — Football Fixtures & Live Tracker ⚽

A lightweight, modern Google Chrome extension (Manifest V3) that lets football fans track upcoming match fixtures, live match days, league schedules worldwide, live streams, and full match highlights straight from their browser toolbar.

---

## ✨ Features

- **Live Fixtures & Real-Time Scores:** Quick-access popup displaying fixtures, API-confirmed live scores (`HT`/`LIVE`), full-time results, and kickoff countdowns. Elapsed kickoff time is only a countdown hint and never promotes a scheduled match to live or finished.
- **FotMob / Flashscore Sequencing:** Matches grouped by competition priority (Champions League, Premier League, La Liga, etc.) with live matches hoisted to the top.
- **Verified Match Links:** Stream and highlight controls appear only when a concrete match-specific link is found on an approved VIPBox or HooFoot host. MatchDay does not generate guessed match URLs or fall back to generic pages.
- **Date Navigation:** Browse fixtures across **Yesterday**, **Today**, **Tomorrow**, and **This Week**.
- **Filter Chips:** Instant filters for **All Matches**, **🔴 Live (with active count badge)**, and **⭐ My Teams**.
- **Favorite Clubs Filtering:** Search, pin, and follow your favorite clubs worldwide so you never miss a kickoff.
- **Quota-Optimized MV3 Service Worker:** Single unified API query engine cutting network consumption by ~90% to avoid free-tier rate limits.
- **Provider-scoped Offline Resilience:** Local browser storage caches provider and competition data separately and can fall back to cached team lists if a provider is unavailable.

---

## 🛠 Tech Stack

- **Platform:** Google Chrome Extension (Manifest V3)
- **Languages:** JavaScript (ES6+), HTML5, CSS3
- **Data Providers:** OpenFootAPI and Football-Data.org REST APIs
- **Live Stream Source:** VIPBox (approved HTTPS hosts: `vipbox.ga`, `vipbox.lc`, `vipbox.be`)
- **Highlights Source:** HooFoot (approved HTTPS host: `hoofoot.net`)
- **Chrome APIs:** `chrome.storage`, `chrome.alarms`, `chrome.action`, `chrome.tabs`

Provider-specific API keys are managed through shared settings storage and remain separate when switching providers. The active provider's key stays synchronized with the legacy `apiKey` setting for compatibility; existing provider-specific legacy key fields are also preserved.

The Settings page accepts only HTTPS base URLs on the source allowlists above. Unsupported hosts, non-HTTPS URLs, credentials, ports, and paths are rejected; changing source domains does not grant new host permissions.

---
##📱Screenshots
<p align="center">
  <img width="30%" src="https://github.com/user-attachments/assets/70f80335-8858-4a20-8b16-e1caf4e95967" />
  <img width="30%" src="https://github.com/user-attachments/assets/6269181a-4c40-4240-94e6-6d5950e512f5" />
  <img width="30%" src="https://github.com/user-attachments/assets/9bc13471-6b53-4314-be76-e023cf1afb60" />
</p>

---
## 🚀 Installation & Loading Locally

1. Clone or download this repository:
   ```bash
   git clone https://github.com/TayyabPervaiz/MatchDay-Football-Extension.git
   ```
2. Open Google Chrome and navigate to:
   ```
   chrome://extensions/
   ```
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this project folder (`FB_Match _Extention`).
5. Click the **MatchDay** icon in your Chrome extensions bar!
6. Enter your free API key from [football-data.org](https://www.football-data.org/client/register) when prompted.
