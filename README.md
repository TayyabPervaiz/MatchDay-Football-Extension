# MatchDay — Football Fixtures & Live Tracker ⚽

A lightweight, modern Google Chrome extension (Manifest V3) that lets football fans track upcoming match fixtures, live match days, and league schedules worldwide from their browser toolbar.

---

## ✨ Features

- **Live Fixtures & Schedules:** Quick-access popup displaying upcoming matches, kickoff countdowns, and club badges.
- **Top Worldwide Leagues:** Follow Premier League, La Liga, Serie A, Bundesliga, Champions League, and more.
- **Favorite Clubs Filtering:** Pin and filter by your favorite clubs so you never miss a kickoff.
- **Manifest V3 Service Worker:** Event-driven architecture using `chrome.alarms` and background workers with zero persistent RAM consumption.
- **Offline Caching:** Instant load time with local browser storage (`chrome.storage`) caching.

---

## 🛠 Tech Stack

- **Platform:** Google Chrome Extension
- **Specification:** Manifest V3
- **Languages:** JavaScript (ES6+), HTML5, CSS3
- **APIs:** Football-Data.org REST API
- **Chrome APIs:** `chrome.storage`, `chrome.alarms`, `chrome.action`

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
4. Click **Load unpacked** and select this project folder.
5. Click the **MatchDay** icon in your Chrome extensions bar!
