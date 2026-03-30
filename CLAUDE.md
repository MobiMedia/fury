# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Fury is a Node.js HTTP service that wraps Puppeteer (via puppeteer-cluster) to generate screenshots, PDFs, and file exports from URLs. It runs as a Docker container with Chrome installed.

## Commands

```bash
npm install          # Install dependencies
npm start            # Start the server (runs server.js on port 3000)
docker build -t fury .  # Build the Docker image
```

There are no tests, linter, or type checker configured.

## Architecture

The codebase is small — four files:

- **`server.js`** — Express server entry point. Launches a puppeteer-cluster, defines three POST endpoints (`/screenshot`, `/pdf`, `/file`) via a shared `createHandler` factory. Supports JSON and MessagePack responses. Can optionally save output to disk via `FURY_SAVE_DIR`.
- **`src/Browser.js`** — Three export functions (`screenshot`, `pdf`, `file`) that each receive a Puppeteer page and params. `pdf` supports iframe CSS injection and dynamic scale calculation. `file` calls `window.mobi.app.page.blobExport()` on the target page (MobiMedia-specific).
- **`src/BrowserUtils.js`** — Page navigation logic: sets viewport, cookies, `window.FURY_PARAMS`, console forwarding, `renderEventName` wait mechanism, and `.furyError` div detection. Also provides `getPuppeteerParams()` for Chrome launch args.
- **`src/Utils.js`** — Small helpers: default timeout constant, error formatting, unique filename generation, timestamped logging.

## Key Concepts

- **renderEventName**: Pages can signal render-readiness by calling an exposed window function. Fury waits for this callback (or timeout) before capturing.
- **FURY_PARAMS**: All request body params are exposed to the target page as `window.FURY_PARAMS`.
- **furyError**: If the target page contains a `<div class="furyError">` with text, Fury throws that as an error instead of rendering.

## Environment Variables

`DEBUG`, `CONCURRENT_LIMIT`, `TIMEOUT`, `PROTOCOL_TIMEOUT`, `PORT`, `FURY_SAVE_DIR`, `FURY_ADDITIONAL_WAIT_ON_NAVIGATE`, `FURY_IFRAME_EVALUATE_TIMEOUT`, `PUPPETEER_EXECUTABLE_PATH`
