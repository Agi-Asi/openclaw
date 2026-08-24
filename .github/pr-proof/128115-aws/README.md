# PR #128115 exact-head proof

This directory contains visual and runtime evidence for source head
`ff8a668b770d9501b4260f98494849cdfa914ce1`, rebased onto
`1ac7f0161c9d65bfe3dd7d20e50a6284bed8cf45`.

## Direction contract

- Desktop expanded column: collapse icon points left, toward the column edge.
- Desktop collapsed rail: expand icon points right, into the board.
- Mobile expanded column: collapse icon points up.
- Mobile collapsed rail: expand icon points down.

`desktop-directions.png` shows both horizontal directions together using
focus plus hover. `mobile-directions.png` uses a real touch-capable Chromium
context, so the vertical controls are always visible. `direction-metrics.json`
records the visible responsive icon classes and verifies that the hidden-axis
icons are absent.

## Visual proof

- `desktop-interaction.webm` — desktop Show, Hide, Collapse, manual expansion,
  and drag/drop sequence.
- `mobile-interaction.webm` — native 390×844 touch/mobile collapse sequence.
- `show-all.png`, `hide-empty.png`, `collapse-empty.png` — all empty-column
  modes.
- `selector-desktop.png`, `selector-mobile.png` — selector labels at desktop
  and mobile widths.
- `desktop-directions.png`, `mobile-directions.png` — visible direction controls.
- `manual-expand.png`, `drag-drop.png`, `mobile-collapse.png` — manual expansion,
  drag/drop, and compact responsive layout.

The capture used a fresh isolated real OpenClaw Gateway, the bundled Workboard
plugin, SQLite-backed state, and the exact-head production Control UI bundle.
No Gateway or RPC responses were mocked. The only card contains deliberately
redacted demo content.

## Remote verification

### AWS Crabbox

- Provider: `aws`
- Lease: `cbx_21d10369320d`
- Run: [`run_30c413f6ea67`](https://crabbox.openclaw.ai/portal/runs/run_30c413f6ea67)
- Image: `ami-0461d919be7deb53c`
- Instance: `c7a.8xlarge` in `eu-west-1`
- Result: passed, exit 0; lease released

The AWS run built the exact source, started the isolated Gateway, created the
proof card through the real Workboard UI, asserted the direction/mode/geometry
contracts, and produced the media and logs in this directory.

### Blacksmith Testbox

- Provider: `blacksmith-testbox`
- Lease: `tbx_01m0rtpj1199ymp480v2amt42q`
- Run: [GitHub Actions 32684268220](https://github.com/openclaw/openclaw/actions/runs/32684268220)
- Result: 2 files, 6/6 Playwright scenarios passed; exit 0
- Cleanup: one-shot lease stopped after success

The Testbox run synced this exact checkout and ran the focused Workboard page
and dashboard-widget Chromium suites in the prepared clean CI environment.

## Logs

- `aws-run.log` — exact head/base, provider, run, lease, and result.
- `blacksmith-run.log` — focused Testbox command, run, lease, and result.
- `gateway.log` — isolated Gateway/plugin startup and shutdown.
- `capture.log` — machine-readable browser assertions.
- `runtime-build.log`, `ui-build.log` — exact-head build logs.
