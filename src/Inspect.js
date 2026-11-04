const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const AddressPolicy = require("./AddressPolicy.js");
const BrowserUtils = require("./BrowserUtils.js");
const InspectExtract = require("./InspectExtract.js");
const InspectProxy = require("./InspectProxy.js");
const {InspectError} = require("./InspectBrowser.js");
const Utils = require("./Utils.js");

// POST /inspect: screenshot and structured metadata of an arbitrary (hostile) external page. See README.

const MB = 1024 * 1024;
const MAX_CONNECTION_BYTES = 10 * MB;
const MAX_TOTAL_BYTES = 25 * MB;
const MAX_BLOCKED = 50;
const MAX_METADATA_BYTES = 500 * 1000;
// Time reserved after navigation for scroll, screenshot, extraction and files
const POST_NAVIGATION_RESERVE = 8000;
const SCROLL_STEP_WAIT = 200;
const SCROLL_BUDGET = 3000;
const SETTLE_AFTER_SCROLL = 300;
const DEFAULT_ACCEPT_LANGUAGE = "de-DE,de;q=0.9,en;q=0.8";

const FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|json)(\.tmp)?$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toInt = (value, defaultValue, min, max) => {
  const number = typeof value === "string" && value.trim() === "" ? NaN : Number(value);

  if (value === undefined || value === null || !Number.isFinite(number)) {
    return defaultValue;
  }

  return Math.min(Math.max(Math.round(number), min), max);
};

const toBool = (value, defaultValue) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  return !(value === false || value === "false" || value === 0 || value === "0");
};

exports.parseParams = (body, globalTimeout) => {
  const params = body || {};
  const {url} = params;

  if (typeof url !== "string" || !url.trim()) {
    throw new InspectError("invalid", "url is required");
  }

  if (url.length > 2048) {
    throw new InspectError("invalid", "url is too long");
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch (e) {
    throw new InspectError("invalid", "url is not an absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InspectError("invalid", "url must be http or https");
  }

  if (parsed.username || parsed.password) {
    throw new InspectError("invalid", "url must not contain credentials");
  }

  const acceptLanguage = typeof params.acceptLanguage === "string" && /^[\w\-,;=. *]{1,200}$/.test(params.acceptLanguage)
    ? params.acceptLanguage
    : DEFAULT_ACCEPT_LANGUAGE;

  return {
    url: url.trim(),
    parsedUrl: parsed,
    width: toInt(params.width, 1440, 320, 3840),
    height: toInt(params.height, 900, 320, 2160),
    fullPage: toBool(params.fullPage, true),
    maxHeight: toInt(params.maxHeight, 4000, 320, 16000),
    quality: toInt(params.quality, 70, 1, 100),
    scroll: toBool(params.scroll, true),
    timeout: toInt(params.timeout, 20000, 1000, Math.max(1000, globalTimeout - POST_NAVIGATION_RESERVE)),
    maxLinks: toInt(params.maxLinks, 200, 0, 1000),
    maxText: toInt(params.maxText, 20000, 0, 200000),
    acceptLanguage
  };
};

const stripHash = (url) => {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (e) {
    return url;
  }
};

const isContextDestroyed = (e) => /Execution context was destroyed|Cannot find context|detached Frame/i.test(e?.message || "");

// Runs an in-page function; retries once if a client side navigation destroyed the context
const evaluateWithRetry = async (page, fn, ...args) => {
  try {
    return await page.evaluate(fn, ...args);
  } catch (e) {
    if (!isContextDestroyed(e)) {
      throw e;
    }
    await sleep(500);
    return page.evaluate(fn, ...args);
  }
};

// Keeps the metadata JSON below ~500 KB by shortening the biggest parts step by step
const capMetadata = (metadata) => {
  const size = () => Buffer.byteLength(JSON.stringify(metadata));
  const steps = [
    () => metadata.text && (metadata.text = metadata.text.slice(0, Math.floor(metadata.text.length / 2))),
    () => metadata.links?.length && (metadata.links = metadata.links.slice(0, Math.floor(metadata.links.length / 2))),
    () => metadata.jsonLd?.length && (metadata.jsonLd = metadata.jsonLd.slice(0, Math.floor(metadata.jsonLd.length / 2))),
    () => metadata.products?.length && (metadata.products = metadata.products.slice(0, Math.floor(metadata.products.length / 2))),
    () => metadata.headings?.length && (metadata.headings = metadata.headings.slice(0, Math.floor(metadata.headings.length / 2)))
  ];

  for (let round = 0; round < 20 && size() > MAX_METADATA_BYTES; round++) {
    steps.find((step) => step());
  }

  return metadata;
};

const inspectPage = async ({browser, context, proxy, checker, params, userAgent, blocked, addBlocked, startedAt}) => {
  const page = await context.newPage();

  // Popups the page opens are closed right away (they would use the same proxy, but nobody needs them)
  context.on("targetcreated", async (target) => {
    if (target.type() === "page") {
      const popup = await target.page().catch(() => null);
      if (popup && popup !== page) {
        popup.close().catch(() => {});
      }
    }
  });

  try {
    const session = await browser.target().createCDPSession();
    await session.send("Browser.setDownloadBehavior", {behavior: "deny", browserContextId: context.id});
    await session.detach().catch(() => {});
  } catch (e) {
    // Headless Chrome has no download directory by default; this only makes the denial explicit
    Utils.log(`Inspect: could not deny downloads explicitly: ${e.message}`);
  }

  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

  if (BrowserUtils.isDebugMode()) {
    page.on("console", (msg) => Utils.log(`[INSPECT PAGE][${msg.type()}] ${msg.text()}`));
  }

  await page.setBypassServiceWorker(true);
  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({"Accept-Language": params.acceptLanguage});
  await page.setViewport({width: params.width, height: params.height, deviceScaleFactor: 1});

  // Why the main document could not be loaded, if we refused it
  let mainFailure = null;
  let lastMainUrl = params.parsedUrl.href;

  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (request.isInterceptResolutionHandled()) {
      return;
    }

    const url = request.url();
    const isMainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    let refusal = null;

    if (isMainNavigation) {
      lastMainUrl = url;
    }

    try {
      if (url.startsWith("data:") || url.startsWith("blob:")) {
        refusal = null;
      } else {
        const parsed = new URL(url);

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          refusal = {reason: "scheme", errorCode: "blockedbyclient"};
        } else if (request.resourceType() === "media") {
          refusal = {reason: "media", errorCode: "blockedbyclient"};
        } else if (proxy.exhausted()) {
          refusal = {reason: "budget", errorCode: "blockedbyclient"};
        } else {
          const result = await checker.check(parsed.hostname, AddressPolicy.urlPort(parsed));
          if (!result.ok) {
            refusal = {
              reason: result.reason,
              errorCode: result.reason === "dns" ? "namenotresolved" : "addressunreachable",
              message: result.message
            };
          }
        }
      }
    } catch (e) {
      refusal = {reason: "invalid url", errorCode: "blockedbyclient"};
    }

    if (!refusal) {
      request.continue().catch(() => {});
      return;
    }

    if (isMainNavigation && !mainFailure) {
      mainFailure = refusal.reason === "dns"
        ? {code: "dns", message: refusal.message}
        : {code: "blocked address", message: refusal.message || `${url} (${refusal.reason})`};
    }

    if (refusal.reason !== "dns") {
      addBlocked(url, refusal.reason);
    }

    request.abort(refusal.errorCode).catch(() => {});
  });

  const failureFor = (url) => {
    try {
      const parsed = new URL(url);
      return proxy.failures.get(AddressPolicy.formatHostPort(parsed.hostname.replace(/^\[|\]$/g, ""), AddressPolicy.urlPort(parsed)));
    } catch (e) {
      return null;
    }
  };

  const navigationError = (e) => {
    if (mainFailure) {
      return new InspectError(mainFailure.code, mainFailure.message);
    }

    const proxyFailure = failureFor(lastMainUrl);
    if (proxyFailure) {
      return new InspectError(proxyFailure.code, proxyFailure.message);
    }

    if (e instanceof puppeteer.TimeoutError) {
      return new InspectError("timeout", `no domcontentloaded after ${params.timeout} ms`);
    }

    const message = e?.message || String(e);
    if (/ERR_NAME_NOT_RESOLVED/.test(message)) {
      return new InspectError("dns", message);
    }

    return new InspectError("connect", message);
  };

  // 1. Navigation: domcontentloaded, then wait for a quiet network (max 2 connections for 500 ms) or the timeout
  const navigationStart = Date.now();
  let response;

  try {
    response = await page.goto(params.parsedUrl.href, {waitUntil: "domcontentloaded", timeout: params.timeout});
  } catch (e) {
    throw navigationError(e);
  }

  // A plain HTTP target the proxy could not reach comes back as the proxy's own 502
  const proxyErrorCode = response?.headers()["x-fury-proxy-error"];
  if (proxyErrorCode) {
    const failure = failureFor(response.url());
    throw new InspectError(failure?.code || proxyErrorCode, failure?.message || response.url());
  }

  const idleTimeout = params.timeout - (Date.now() - navigationStart);
  if (idleTimeout > 0) {
    await page.waitForNetworkIdle({idleTime: 500, concurrency: 2, timeout: idleTimeout}).catch(() => {});
  }

  const navigationMs = Date.now() - navigationStart;

  // A client side redirect to a refused address leaves Chrome's error page
  if (page.url().startsWith("chrome-error:")) {
    throw navigationError(new Error(`navigation to ${lastMainUrl} failed`));
  }

  // 2. Scroll down in viewport steps (lazy images, infinite lists), at most maxHeight px, then back to the top
  if (params.scroll) {
    await evaluateWithRetry(page, async ({maxHeight, stepWait, budget}) => {
      const start = Date.now();
      const step = Math.max(window.innerHeight, 100);
      const pageHeight = () => Math.min(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0), maxHeight);

      for (let y = step; y < pageHeight() && Date.now() - start < budget; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, stepWait));
      }

      window.scrollTo(0, 0);
    }, {maxHeight: params.maxHeight, stepWait: SCROLL_STEP_WAIT, budget: SCROLL_BUDGET}).catch((e) => {
      Utils.log(`Inspect: scrolling failed: ${e.message}`);
    });

    await sleep(SETTLE_AFTER_SCROLL);
  }

  // 3. Screenshot (JPEG), a full-page screenshot is clipped at maxHeight
  let clipHeight = params.height;
  if (params.fullPage) {
    const pageHeight = await evaluateWithRetry(page, () => Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    )).catch(() => params.height);
    clipHeight = Math.min(Math.max(pageHeight, params.height), params.maxHeight);
  }

  const screenshot = Buffer.from(await page.screenshot({
    type: "jpeg",
    quality: params.quality,
    clip: {x: 0, y: 0, width: params.width, height: clipHeight},
    captureBeyondViewport: true
  }));

  // 4. Metadata - an error here must not lose the screenshot
  let extracted = {};
  let extractError = null;

  try {
    extracted = await evaluateWithRetry(page, InspectExtract.extractPageData, {maxLinks: params.maxLinks, maxText: params.maxText});
  } catch (e) {
    extractError = e?.message || String(e);
  }

  const redirectChain = response ? response.request().redirectChain().map((request) => stripHash(request.url())) : [];

  const metadata = {
    requestedUrl: params.url,
    finalUrl: stripHash(page.url()),
    status: response ? response.status() : null,
    redirects: redirectChain.length ? [...redirectChain, stripHash(response.url())] : [],
    title: null,
    lang: null,
    meta: null,
    alternates: [],
    logos: [],
    headings: [],
    links: [],
    text: "",
    products: [],
    jsonLd: [],
    colors: null,
    fonts: null,
    hasLoginForm: false,
    ...extracted,
    blocked,
    timings: {navigationMs, totalMs: Date.now() - startedAt}
  };

  if (extractError) {
    metadata.extractError = extractError;
  }

  return {metadata: capMetadata(metadata), screenshot};
};

/**
 * @param manager - InspectBrowser.create() result
 * @param body - request body
 * @param {object} options
 * @param {AbortSignal} options.signal - aborted when the client went away
 * @param {object} options.allowPrivate - AddressPolicy.parseAllowPrivate() result
 * @returns {Promise<{metadata: object, screenshot: Buffer}>}
 */
exports.run = async (manager, body, {signal, allowPrivate}) => {
  const startedAt = Date.now();
  const deadline = startedAt + manager.timeout;
  const params = exports.parseParams(body, manager.timeout);
  const checker = AddressPolicy.createChecker(allowPrivate);

  // The start URL is checked before a slot is taken: a refused address never costs a browser context
  const startCheck = await checker.check(params.parsedUrl.hostname, AddressPolicy.urlPort(params.parsedUrl));
  if (!startCheck.ok) {
    throw new InspectError(startCheck.reason === "dns" ? "dns" : "blocked address", `${startCheck.message} (${startCheck.reason})`);
  }

  const release = await manager.acquire(deadline, signal);
  let context;
  let proxy;
  let timer;

  const blocked = [];
  const addBlocked = (target, reason) => {
    const entry = `${String(target).slice(0, 200)} (${reason})`;
    if (blocked.length < MAX_BLOCKED && !blocked.includes(entry)) {
      blocked.push(entry);
    }
  };

  try {
    const browser = await manager.launch();

    proxy = await InspectProxy.start({
      checker,
      maxConnectionBytes: MAX_CONNECTION_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      onBlocked: addBlocked
    });

    context = await browser.createBrowserContext({
      proxyServer: `http://127.0.0.1:${proxy.port}`,
      proxyBypassList: ["<-loopback>"]
    });

    const job = inspectPage({
      browser, context, proxy, checker, params, blocked, addBlocked, startedAt,
      userAgent: manager.getUserAgent()
    });
    // The job keeps running for a moment after a timeout until the context is closed; its error is irrelevant then
    job.catch(() => {});

    const hardDeadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new InspectError("timeout", `inspect took longer than ${manager.timeout} ms`)), Math.max(deadline - Date.now(), 0));
    });

    return await Promise.race([job, hardDeadline]);
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    release();
  }
};

// Writes <id>.jpg and <id>.json (via a temporary name, so a reader never sees a half written file)
exports.writeFiles = async (saveDir, {metadata, screenshot}) => {
  const id = crypto.randomUUID();
  const files = {screenshot: `${id}.jpg`, file: `${id}.json`};

  const write = async (name, data) => {
    const target = path.join(saveDir, name);
    await fs.promises.writeFile(`${target}.tmp`, data);
    await fs.promises.rename(`${target}.tmp`, target);
  };

  await write(files.screenshot, screenshot);
  await write(files.file, JSON.stringify(metadata));

  return files;
};

let cleanupRunning = false;

// Deletes /inspect files (UUID names only) older than maxAgeSeconds, so a crashed caller does not fill the volume
exports.cleanupSaveDir = async (saveDir, maxAgeSeconds) => {
  if (cleanupRunning) {
    return;
  }

  cleanupRunning = true;

  try {
    const threshold = Date.now() - maxAgeSeconds * 1000;
    const names = (await fs.promises.readdir(saveDir)).filter((name) => FILE_PATTERN.test(name));

    for (const name of names) {
      const file = path.join(saveDir, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < threshold) {
          await fs.promises.unlink(file);
        }
      } catch (e) {
        // deleted by the caller in the meantime
      }
    }
  } catch (e) {
    Utils.log(`Inspect: cleanup of ${saveDir} failed: ${e.message}`);
  } finally {
    cleanupRunning = false;
  }
};
