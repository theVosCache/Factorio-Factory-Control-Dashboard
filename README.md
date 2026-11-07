# Factory Control Dashboard

Static PWA for the Factory Control companion app. It talks to the companion on your PC over a
WebRTC data channel on the LAN (pair with the QR / 6-digit code). No server, no build step.

Source of truth: `external/factory-control-app/ui/` in the factorio-mods repo. Copy changes over
and bump `SHELL` in `sw.js` on every deploy.
