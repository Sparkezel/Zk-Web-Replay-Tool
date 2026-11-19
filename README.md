# Zk-Web-Replay-Tool
A project meant to embed zk game replays into the battle result screen with goal of easier replay access and showing cool info

## Mockup

Static mockup of the battle-result screen with an animated battle replay section.
After merging, it will be served at https://sparkezel.github.io/Zk-Web-Replay-Tool/

- Source: [`mockup/index.html`](mockup/index.html)
- The replay stage currently renders synthetic seeded data; the target is a
  pre-simulated artifact (unit snapshots + death/kill events) generated
  server-side from Zero-K `.sdfz` demo files.

## Logging spec

`.zkr` v1 artifact contract (what the headless resim records and the viewer
consumes): [`docs/REPLAY_LOGGING_SPEC.md`](docs/REPLAY_LOGGING_SPEC.md)

## Live demo

After enabling GitHub Pages (Settings → Pages → Deploy from branch `gh-pages`):
https://sparkezel.github.io/Zk-Web-Replay-Tool/
