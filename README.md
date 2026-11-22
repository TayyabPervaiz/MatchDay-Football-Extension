# MatchDay — Football Fixtures & Live Tracker ⚽

A lightweight, modern Google Chrome extension (Manifest V3) that lets football fans track upcoming match fixtures, live match days, league schedules worldwide, live streams, and full match highlights straight from their browser toolbar.

---

## ✨ Features

- **Live Fixtures & Real-Time Scores:** Quick-access popup displaying live matchday fixtures, live scores (`HT`/`LIVE`), full-time results, and kickoff countdowns.
- **FotMob / Flashscore Sequencing:** Matches grouped by competition priority (Champions League, Premier League, La Liga, etc.) with live matches hoisted to the top.
- **Direct Live Match Streams (VIPBox):** 1-click **"▶ Watch Live"** button on each match card linking directly to that specific fixture's stream on [VIPBox](https://vipbox.ga/football-schedule).
- **Direct Full Highlights (HooFoot):** 1-click **"🎬 Full Highlights"** button on completed matches taking you straight to the full video replay on [HooFoot](https://hoofoot.net/).
- **Date Navigation:** Browse fixtures across **Yesterday**, **Today**, **Tomorrow**, and **This Week**.
- **Filter Chips:** Instant filters for **All Matches**, **🔴 Live (with active count badge)**, and **⭐ My Teams**.
- **Favorite Clubs Filtering:** Search, pin, and follow your favorite clubs worldwide so you never miss a kickoff.
- **Quota-Optimized MV3 Service Worker:** Single unified API query engine cutting network consumption by ~90% to avoid free-tier rate limits.
- **Offline Resilience:** Instant load time with local browser storage (`chrome.storage`) caching and native system fonts.

---

## 🛠 Tech Stack

- **Platform:** Google Chrome Extension (Manifest V3)
- **Languages:** JavaScript (ES6+), HTML5, CSS3
- **Data Source:** Football-Data.org REST API
- **Live Stream Source:** VIPBox (`https://vipbox.ga/`)
- **Highlights Source:** HooFoot (`https://hoofoot.net/`)
- **Chrome APIs:** `chrome.storage`, `chrome.alarms`, `chrome.action`, `chrome.tabs`

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
