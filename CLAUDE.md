# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Fury is a Node.js HTTP service that wraps Puppeteer (via puppeteer-cluster) to generate screenshots, PDFs, and file exports from URLs. It runs as a Docker container with Chrome installed.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start the server (runs server.js on port 3000)
docker build -t fury .  # Build the Docker image
npm test             # node:test suites in test/ (integration tests need puppeteer's Chrome)
```

There is no linter or type checker configured.

## Architecture

- **`server.js`** — Express server entry point. `FURY_ENDPOINTS` selects `render` (default: launches a puppeteer-cluster, three POST endpoints `/screenshot`, `/pdf`, `/file` via a shared `createHandler` factory) and/or `inspect` (`/inspect`). Supports JSON and MessagePack responses. Can optionally save output to disk via `FURY_SAVE_DIR`.
- **`src/Browser.js`** — Three export functions (`screenshot`, `pdf`, `file`) that each receive a Puppeteer page and params. `pdf` supports iframe CSS injection and dynamic scale calculation. `file` calls `window.mobi.app.page.blobExport()` on the target page (MobiMedia-specific).
- **`src/BrowserUtils.js`** — Page navigation logic: sets viewport, cookies, `window.FURY_PARAMS`, console forwarding, `renderEventName` wait mechanism, and `.furyError` div detection. Also provides `getPuppeteerParams()` for Chrome launch args.
- **`src/Utils.js`** — Small helpers: default timeout constant, error formatting, unique filename generation, timestamped logging.

`/inspect` (external, hostile websites; must never affect the render endpoints):

- **`src/Inspect.js`** — The flow: parameter parsing, start URL check, navigation, scroll, screenshot, extraction, result files and their cleanup.
- **`src/InspectBrowser.js`** — The dedicated inspect browser (no puppeteer-cluster), slots with a bounded queue, `InspectError` (`<code>: <message>`).
- **`src/InspectProxy.js`** — Per-request forward proxy on 127.0.0.1; the enforcement point for private addresses (connects to exactly the checked address, closing DNS rebinding) and byte limits.
- **`src/AddressPolicy.js`** — Pure address/port rules plus a per-request DNS cache, shared by the proxy and the request interception.
- **`src/InspectExtract.js`** — The in-page metadata extraction; runs via `page.evaluate`, so it must stay self-contained.

## Key Concepts

- **renderEventName**: Pages can signal render-readiness by calling an exposed window function. Fury waits for this callback (or timeout) before capturing.
- **FURY_PARAMS**: All request body params are exposed to the target page as `window.FURY_PARAMS`.
- **furyError**: If the target page contains a `<div class="furyError">` with text, Fury throws that as an error instead of rendering.

## Environment Variables

`DEBUG`, `CONCURRENT_LIMIT`, `TIMEOUT`, `PROTOCOL_TIMEOUT`, `PORT`, `FURY_SAVE_DIR`, `FURY_ADDITIONAL_WAIT_ON_NAVIGATE`, `FURY_IFRAME_EVALUATE_TIMEOUT`, `PUPPETEER_EXECUTABLE_PATH`, `FURY_ENDPOINTS`, `CONCURRENT_LIMIT_INSPECT`, `FURY_SAVE_DIR_MAX_AGE`, `FURY_INSPECT_ALLOW_PRIVATE` (dev/tests only)
