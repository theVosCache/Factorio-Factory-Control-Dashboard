# Changelog

Factory Control dashboard (PWA). Newest first. Versions are the service worker shell (`SHELL` in `sw.js`):
bump it on every deploy so installed apps pick up the new files. Every push to `main` deploys to GitHub Pages.

## v13 (2026-11-11)
- New **Rocket silos** tab (while Space Exploration and factory-control 0.4.1+ are loaded): one card per silo
  controller on the surface with its status (loading / ready, and what the rocket still needs), sections, capsule,
  fuel and cargo slots, the manifest with what is still to load, the launch rules and whether they are met.
  Buttons: Auto launch on/off, **Launch now** (green for one second, after a confirmation) and ping in the game
  (the controller's icon). Ported from the old dashboard, adapted to 0.4.1 (no "launching" state, no cancel).
- README and CHANGELOG: hosted on GitHub Pages, edited as the `ui/` submodule of the companion app.

## v12 (2026-11-09)
- Signal popup: **Ping in game** button. The remote switches of that signal ping in the game (chat location,
  flying text, sound and a ring), via factory-control 0.3.5's `ping_remotes`.
- Pages workflow no longer cancels a running deployment when a new push arrives.

## v11 (2026-10-31, on GitHub Pages since 2026-11-07)
- First version: the dashboard of the companion app, as an installable PWA.
  - Pairing screen with a QR scanner or 6-digit code; talks to the companion app over a WebRTC data channel
    on the LAN (`transports/rtc.js`), or over IPC inside the app's own window (`transports/ipc.js`).
  - Tabs: Research, Power (plants and groups together), Factoriopedia, and Cybersyn, Shuttle train and Repair
    wards while those mods are loaded.
  - Research tiles: the cost strip fills the whole card, the unit count gets its own line.
