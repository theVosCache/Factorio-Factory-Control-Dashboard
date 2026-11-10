# Factory Control Dashboard

Static PWA for the Factory Control companion app. It talks to the companion on your PC over a
WebRTC data channel on the LAN (pair with the QR / 6-digit code). No server, no build step.

Hosted on GitHub Pages: https://thevoscache.github.io/Factorio-Factory-Control-Dashboard/
(`.github/workflows/pages.yml` deploys every push to `main`). Bump `SHELL` in `sw.js` on every deploy.

This repo is a git submodule at `ui/` of the companion app (`gitlab.com/thevoscache-factorio/factory-control-app`),
which also serves it on the LAN and shows it in its desktop window. Edit it there, commit and push here first, then
commit the new `ui` pointer in the app repo.
