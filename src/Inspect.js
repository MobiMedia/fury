const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const AddressPolicy = require("./AddressPolicy.js");
const BotProtection = require("./BotProtection.js");
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

// <uuid>.json, <uuid>.jpg (screenshot) and <uuid>-image-<n>.<ext> (images of the page)
const FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.(jpg|json)|-image-\d{1,4}\.(png|jpg|gif|webp|avif|svg|ico|bmp))(\.tmp)?$/;

// Captured image responses
const MAX_CAPTURED_IMAGES = 300;
const MAX_IMAGE_BYTES = 10 * MB;
// Images the page did not load itself (declared icons, sharing images, hidden variants) are loaded afterwards
const MAX_PRELOAD = 30;
const PRELOAD_TIMEOUT = 3000;
// The images the structured data declares (source `structured-data`) are loaded on top, with a little more time: they
// are mostly photos, not icons
const MAX_PRELOAD_STRUCTURED = 40;
const PRELOAD_TIMEOUT_STRUCTURED = 5000;
// Image requests do not offer AVIF: callers store the images, and few of them can read it. Servers that negotiate the
// format send WebP or JPEG instead.
const IMAGE_ACCEPT = "image/webp,image/apng,image/svg+xml,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5";
// Time kept free before the hard deadline for writing the result
const DEADLINE_MARGIN = 1500;

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

  const languages = (typeof params.acceptLanguage === "string" ? params.acceptLanguage : DEFAULT_ACCEPT_LANGUAGE)
    .split(",")
    .map((entry) => entry.split(";")[0].trim())
    .filter((entry) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$|^\*$/.test(entry))
    .slice(0, 10);
  const acceptLanguage = languages.length ? languages.join(",") : DEFAULT_ACCEPT_LANGUAGE.split(",").map((entry) => entry.split(";")[0]).join(",");

  return {
    url: url.trim(),
    parsedUrl: parsed,
    width: toInt(params.width, 1440, 320, 3840),
    height: toInt(params.height, 900, 320, 2160),
    fullPage: toBool(params.fullPage, true),
    maxHeight: toInt(params.maxHeight, 10000, 320, 16000),
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

// Runs a self-contained function in an isolated world of the main frame: it sees the page's DOM, but not the page's
// JavaScript, so page scripts cannot tamper with the built-ins the function uses (Array.prototype.map,
// querySelectorAll, ...) and thereby with its result. Plain CDP, as Puppeteer's own isolated realm is internal API.
const evaluateIsolated = async (session, fn, arg) => {
  const run = async () => {
    const {frameTree} = await session.send("Page.getFrameTree");
    const {executionContextId} = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "fury-inspect"
    });
    const {result, exceptionDetails} = await session.send("Runtime.callFunctionOn", {
      functionDeclaration: fn.toString(),
      executionContextId,
      arguments: arg === undefined ? [] : [{value: arg}],
      awaitPromise: true,
      returnByValue: true
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || "evaluation failed");
    }
    return result.value;
  };

  try {
    return await run();
  } catch (e) {
    if (!isContextDestroyed(e)) {
      throw e;
    }
    await sleep(500);
    return run();
  }
};

// Only these keys are taken from the extraction result; everything else of the metadata is set by Fury itself
const EXTRACTED_KEYS = ["title", "lang", "meta", "alternates", "headings", "links", "text", "images", "forms", "structuredData", "colors", "fonts"];
const pickExtracted = (extracted) => Object.fromEntries(EXTRACTED_KEYS
  .filter((key) => extracted && typeof extracted === "object" && Object.prototype.hasOwnProperty.call(extracted, key))
  .map((key) => [key, extracted[key]]));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_DATA_URL_LENGTH = 150000;

// Images: `url` only http(s), `dataUrl` only a real PNG (base64, PNG signature, size limit); entries with neither
// are dropped
const sanitizeImages = (images) => (Array.isArray(images) ? images : [])
  .filter((image) => image && typeof image === "object")
  .map((image) => {
    const url = typeof image.url === "string" && /^https?:\/\//i.test(image.url) ? image.url : null;
    let dataUrl = null;
    const match = typeof image.dataUrl === "string" && image.dataUrl.length <= MAX_DATA_URL_LENGTH ? PNG_DATA_URL.exec(image.dataUrl) : null;
    if (match) {
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        dataUrl = image.dataUrl;
      }
    }
    return {...image, url, dataUrl};
  })
  .filter((image) => image.url || image.dataUrl);

// The real type of image bytes, from their content (a server can label anything as image/png). null = not an image
// format Fury stores.
const sniffImage = (buffer) => {
  if (!buffer || buffer.length < 4) {
    return null;
  }
  const ascii = (start, end) => buffer.subarray(start, end).toString("latin1");
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    return "gif";
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "webp";
  }
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) {
    return "avif";
  }
  if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) {
    return "ico";
  }
  if (ascii(0, 2) === "BM") {
    return "bmp";
  }
  // SVG: optional BOM, XML declaration, comments and doctype, then <svg
  const head = buffer.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]/i.test(head)) {
    return "svg";
  }
  return null;
};

const EXTENSIONS = {png: "png", jpeg: "jpg", gif: "gif", webp: "webp", avif: "avif", svg: "svg", ico: "ico", bmp: "bmp"};

// Keeps the bodies of all image responses of the page (also CSS backgrounds/masks and images loaded later), keyed by
// URL (without fragment; also the URLs of a redirect chain)
const captureImages = (page) => {
  const bodies = new Map();
  let count = 0;

  page.on("response", (response) => {
    const request = response.request();
    const url = response.url();
    const contentType = String(response.headers()["content-type"] || "").toLowerCase();
    if (response.status() < 200 || response.status() >= 300 || url.startsWith("data:") || url.startsWith("blob:") ||
      (request.resourceType() !== "image" && !contentType.startsWith("image/")) || count >= MAX_CAPTURED_IMAGES) {
      return;
    }
    count++;
    const body = response.buffer().then((buffer) => (buffer.length <= MAX_IMAGE_BYTES ? buffer : null), () => null);
    for (const key of [url, request.url(), ...request.redirectChain().map((previous) => previous.url())]) {
      const normalized = stripHash(key);
      if (!bodies.has(normalized)) {
        bodies.set(normalized, body);
      }
    }
  });

  return {
    has: (url) => bodies.has(url),
    // The body, or null if not captured or not complete before `until`
    get: async (url, until) => {
      if (!bodies.has(url)) {
        return null;
      }
      return Promise.race([bodies.get(url), sleep(Math.max(until - Date.now(), 0)).then(() => null)]);
    }
  };
};

// Gives every image whose bytes are available a file: the captured response body, or Fury's PNG rendering (dataUrl)
// of an inline image. Returns the images (with file, bytes, rendered, the sniffed format; without dataUrl) and the
// file contents. The same URL gets one file.
const attachImageFiles = async (images, capture, until) => {
  const files = [];
  const fileByUrl = new Map();

  const result = [];
  for (const image of images) {
    const {dataUrl, ...entry} = image;
    let file = null;
    let bytes = null;
    let format = entry.format;
    const rendered = Boolean(dataUrl);

    if (rendered) {
      const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      file = `image-${files.length + 1}.png`;
      files.push({name: file, data});
      bytes = data.length;
      format = "png";
    } else if (entry.url && fileByUrl.has(entry.url)) {
      ({file, bytes, format} = fileByUrl.get(entry.url));
    } else if (entry.url) {
      const data = await capture.get(entry.url, until);
      const sniffed = sniffImage(data);
      if (sniffed) {
        file = `image-${files.length + 1}.${EXTENSIONS[sniffed]}`;
        files.push({name: file, data});
        bytes = data.length;
        format = sniffed;
        fileByUrl.set(entry.url, {file, bytes, format});
      }
    }

    result.push({
      url: entry.url, file, bytes, rendered, source: entry.source, format, alt: entry.alt, width: entry.width,
      height: entry.height, naturalWidth: entry.naturalWidth ?? null, naturalHeight: entry.naturalHeight ?? null,
      x: entry.x ?? null, y: entry.y ?? null, shape: entry.shape, area: entry.area, visible: entry.visible,
      hints: entry.hints, link: entry.link ?? null, color: entry.color, background: entry.background,
      declaredIn: entry.declaredIn ?? null, implicit: entry.implicit === true
    });
  }

  return {images: result, files};
};

exports.pickExtracted = pickExtracted;
exports.sanitizeImages = sanitizeImages;
exports.sniffImage = sniffImage;
exports.attachImageFiles = attachImageFiles;

// Keeps the metadata JSON below ~500 KB by shortening the biggest parts step by step
const capMetadata = (metadata) => {
  const size = () => Buffer.byteLength(JSON.stringify(metadata));
  const steps = [
    () => metadata.text && (metadata.text = metadata.text.slice(0, Math.floor(metadata.text.length / 2))),
    () => metadata.links?.length && (metadata.links = metadata.links.slice(0, Math.floor(metadata.links.length / 2))),
    () => metadata.structuredData?.jsonLd?.length && (metadata.structuredData.jsonLd = metadata.structuredData.jsonLd.slice(0, Math.floor(metadata.structuredData.jsonLd.length / 2))),
    () => metadata.structuredData?.microdata?.length && (metadata.structuredData.microdata = metadata.structuredData.microdata.slice(0, Math.floor(metadata.structuredData.microdata.length / 2))),
    () => metadata.images?.length && (metadata.images = metadata.images.slice(0, Math.floor(metadata.images.length / 2))),
    () => metadata.headings?.length && (metadata.headings = metadata.headings.slice(0, Math.floor(metadata.headings.length / 2)))
  ];

  for (let round = 0; round < 20 && size() > MAX_METADATA_BYTES; round++) {
    steps.find((step) => step());
  }

  return metadata;
};

const inspectPage = async ({context, proxy, checker, params, userAgent, userAgentMetadata, platform, blocked, addBlocked, startedAt, deadline}) => {
  const page = await context.newPage();
  const capture = captureImages(page);

  // Popups the page opens are closed right away (they would use the same proxy, but nobody needs them)
  context.on("targetcreated", async (target) => {
    if (target.type() === "page") {
      const popup = await target.page().catch(() => null);
      if (popup && popup !== page) {
        popup.close().catch(() => {});
      }
    }
  });

  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

  if (BrowserUtils.isDebugMode()) {
    page.on("console", (msg) => Utils.log(`[INSPECT PAGE][${msg.type()}] ${msg.text()}`));
  }

  await page.setBypassServiceWorker(true);
  // Identity: User-Agent, client hints, platform and the languages in one native override, so the Accept-Language
  // header (Chrome adds the q-values) and navigator.languages are consistent (the same way Playwright's "locale"
  // works). page.setUserAgent additionally covers cross-origin iframes, which run in their own process.
  await page.setUserAgent(userAgent, userAgentMetadata || undefined);
  const identitySession = await page.createCDPSession();
  await identitySession.send("Network.setUserAgentOverride", {
    userAgent,
    acceptLanguage: params.acceptLanguage,
    platform,
    userAgentMetadata: userAgentMetadata || undefined
  });
  // The override lives as long as the session: it is closed with the context
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
      const overrides = request.resourceType() === "image" ? {headers: {...request.headers(), accept: IMAGE_ACCEPT}} : undefined;
      request.continue(overrides).catch(() => {});
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

  // 2. Full height for pages that scroll inside an element instead of the document
  let scrollContainer = false;
  const expandScrollContainer = async () => {
    if (!params.fullPage) {
      return;
    }
    const expanded = await evaluateIsolated(identitySession, InspectExtract.expandScrollContainer, {viewportHeight: params.height}).catch((e) => {
      Utils.log(`Inspect: expanding the scroll container failed: ${e.message}`);
      return null;
    });
    scrollContainer = scrollContainer || Boolean(expanded?.expanded);
  };
  await expandScrollContainer();

  // Scroll down in viewport steps (lazy images, infinite lists), at most maxHeight px, then back to the top. In the
  // isolated world, so the page cannot stall it by replacing setTimeout or Date.
  if (params.scroll) {
    await evaluateIsolated(identitySession, async ({maxHeight, stepWait, budget}) => {
      const start = Date.now();
      const step = Math.max(window.innerHeight, 100);
      const pageHeight = () => Math.min((document.scrollingElement || document.documentElement).scrollHeight, maxHeight);

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

  // 3. Screenshot (JPEG), a full-page screenshot is clipped at maxHeight. Page scripts may have restored the clipping
  // of their scroll container while scrolling, so it is expanded again.
  await expandScrollContainer();
  const measured = await evaluateIsolated(identitySession, InspectExtract.documentHeight).catch(() => null);
  const pageHeight = Number.isFinite(measured) && measured > 0 ? Math.round(measured) : params.height;
  let clipHeight = params.height;
  if (params.fullPage) {
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
    extracted = pickExtracted(await evaluateIsolated(identitySession, InspectExtract.extractPageData, {maxLinks: params.maxLinks, maxText: params.maxText}));
    if ("images" in extracted) {
      extracted.images = sanitizeImages(extracted.images);
    }
  } catch (e) {
    extractError = e?.message || String(e);
  }

  // 5. Image files: what the page loaded is already captured; images it did not load itself are loaded now (within
  // the time left before the deadline)
  let imageFiles = [];
  if (extracted.images?.length) {
    const until = deadline - DEADLINE_MARGIN;
    const missingOf = (images, max) => [...new Set(images.filter((image) => image.url && !capture.has(image.url)).map((image) => image.url))].slice(0, max);
    const page = missingOf(extracted.images.filter((image) => image.source !== "structured-data"), MAX_PRELOAD);
    const structured = missingOf(extracted.images.filter((image) => image.source === "structured-data"), MAX_PRELOAD_STRUCTURED)
      .filter((url) => !page.includes(url));
    const missing = [...page, ...structured];
    const preloadTimeout = Math.min(structured.length ? PRELOAD_TIMEOUT_STRUCTURED : PRELOAD_TIMEOUT, until - Date.now() - 500);
    if (missing.length && preloadTimeout > 0) {
      await evaluateIsolated(identitySession, InspectExtract.preloadImages, {urls: missing, timeout: preloadTimeout}).catch((e) => {
        Utils.log(`Inspect: loading images failed: ${e.message}`);
      });
    }
    const attached = await attachImageFiles(extracted.images, capture, until);
    extracted.images = attached.images;
    imageFiles = attached.files;
  }

  // Bot protection / CAPTCHA (informational), independent of the extraction
  let botProtection = null;
  try {
    botProtection = BotProtection.detect({
      status: response ? response.status() : null,
      headers: response ? response.headers() : {},
      page: await evaluateIsolated(identitySession, BotProtection.collectPageSignals).catch(() => null)
    });
  } catch (e) {
    Utils.log(`Inspect: bot protection detection failed: ${e.message}`);
  }

  const redirectChain = response ? response.request().redirectChain().map((request) => stripHash(request.url())) : [];

  // `extracted` holds only the EXTRACTED_KEYS, so it cannot overwrite the fields Fury sets itself
  const metadata = {
    requestedUrl: params.url,
    finalUrl: stripHash(page.url()),
    status: response ? response.status() : null,
    redirects: redirectChain.length ? [...redirectChain, stripHash(response.url())] : [],
    title: null,
    lang: null,
    meta: null,
    alternates: [],
    headings: [],
    links: [],
    text: "",
    images: [],
    forms: [],
    structuredData: {jsonLd: [], microdata: [], openGraph: {}, twitter: {}},
    colors: null,
    fonts: null,
    ...extracted,
    botProtection,
    // The page height (CSS px) and whether the screenshot shows all of it
    screenshot: {
      width: params.width,
      height: clipHeight,
      pageHeight: Math.max(pageHeight, params.height),
      truncated: Math.max(pageHeight, params.height) > clipHeight,
      scrollContainer
    },
    blocked,
    timings: {navigationMs, totalMs: Date.now() - startedAt}
  };

  if (extractError) {
    metadata.extractError = extractError;
  }

  const cappedMetadata = capMetadata(metadata);
  // Files of images that capMetadata removed are not returned
  const referenced = new Set((cappedMetadata.images || []).map((image) => image.file).filter(Boolean));
  return {metadata: cappedMetadata, screenshot, images: imageFiles.filter((file) => referenced.has(file.name))};
};

/**
 * @param manager - InspectBrowser.create() result
 * @param body - request body
 * @param {object} options
 * @param {AbortSignal} options.signal - aborted when the client went away
 * @param {object} options.allowPrivate - AddressPolicy.parseAllowPrivate() result
 * @returns {Promise<{metadata: object, screenshot: Buffer, images: Array<{name: string, data: Buffer}>}>}
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
      proxyBypassList: ["<-loopback>"],
      downloadBehavior: {policy: "deny"}
    });

    const job = inspectPage({
      context, proxy, checker, params, blocked, addBlocked, startedAt, deadline,
      userAgent: manager.getUserAgent(),
      userAgentMetadata: manager.getUserAgentMetadata(),
      platform: manager.getPlatform()
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
// <id>.jpg, <id>-image-<n>.<ext> and, last, <id>.json: when the JSON exists, every file it names exists too.
// metadata.images[].file is changed to the file name in the directory.
exports.writeFiles = async (saveDir, {metadata, screenshot, images = []}) => {
  const id = crypto.randomUUID();
  const imageName = (name) => `${id}-${name}`;
  const files = {screenshot: `${id}.jpg`, file: `${id}.json`, images: images.map((image) => imageName(image.name))};

  const write = async (name, data) => {
    const target = path.join(saveDir, name);
    await fs.promises.writeFile(`${target}.tmp`, data);
    await fs.promises.rename(`${target}.tmp`, target);
  };

  await write(files.screenshot, screenshot);
  for (const image of images) {
    await write(imageName(image.name), image.data);
  }

  const saved = Array.isArray(metadata.images)
    ? {...metadata, images: metadata.images.map((image) => (image.file ? {...image, file: imageName(image.file)} : image))}
    : metadata;
  await write(files.file, JSON.stringify(saved));

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
