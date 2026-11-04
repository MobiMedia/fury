const puppeteer = require("puppeteer");
const BrowserUtils = require("./BrowserUtils.js");
const Utils = require("./Utils.js");

// The dedicated browser of /inspect (no puppeteer-cluster): one browser, CONCURRENT_LIMIT_INSPECT slots, a bounded
// queue. Each request gets its own incognito context with its own proxy (see Inspect.js).

class InspectError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    // Utils.getError() prefers the stack; these are expected errors, the message is enough
    this.stack = this.message;
  }
}

exports.InspectError = InspectError;

exports.getLaunchOptions = () => {
  const base = BrowserUtils.getPuppeteerParams();

  return {
    ...base,
    // Invalid certificates are accepted like for the other endpoints
    acceptInsecureCerts: true,
    // Puppeteer adds --enable-automation by default, which marks the browser as automated (navigator.webdriver, ...)
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      ...base.args,
      // Behave like a regular Chrome: no "controlled by automation" signals, a window of the default viewport size
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,900",
      // Default for everything outside our contexts: a dead proxy, so nothing reaches the network directly.
      // Each inspect context overrides it with its own InspectProxy.
      "--proxy-server=http://127.0.0.1:9",
      // Chrome bypasses proxies for loopback by default; "<-loopback>" removes that implicit rule
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--deny-permission-prompts",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  };
};

const renameHeadless = (list) => (list || []).map(({brand, version}) => ({brand: brand.replace(/HeadlessChrome/g, "Google Chrome"), version}));

/**
 * User-Agent client hints (sec-ch-ua*, navigator.userAgentData) matching the User-Agent: headless Chrome reports the
 * brand "HeadlessChrome" there, while the User-Agent string already says "Chrome". Only the brand is renamed, all
 * other values are the real ones of this browser (fallback: derived from the version if they cannot be read).
 *
 * @param {object|null} raw - navigator.userAgentData values read in the browser
 * @param {string} version - browser.version(), e.g. "HeadlessChrome/124.0.6367.91"
 */
exports.toUserAgentMetadata = (raw, version) => {
  const fullVersion = (/\/([\d.]+)/.exec(version || "") || [])[1] || "0.0.0.0";
  const major = fullVersion.split(".")[0];

  if (raw && Array.isArray(raw.brands) && raw.brands.length) {
    return {
      brands: renameHeadless(raw.brands),
      fullVersionList: renameHeadless(raw.fullVersionList),
      platform: raw.platform || "",
      platformVersion: raw.platformVersion || "",
      architecture: raw.architecture || "",
      model: raw.model || "",
      mobile: !!raw.mobile,
      bitness: raw.bitness || "",
      wow64: !!raw.wow64
    };
  }

  const platforms = {linux: "Linux", darwin: "macOS", win32: "Windows"};
  return {
    brands: [{brand: "Chromium", version: major}, {brand: "Google Chrome", version: major}, {brand: "Not-A.Brand", version: "99"}],
    fullVersionList: [{brand: "Chromium", version: fullVersion}, {brand: "Google Chrome", version: fullVersion}, {brand: "Not-A.Brand", version: "99.0.0.0"}],
    platform: platforms[process.platform] || "Linux",
    platformVersion: "",
    architecture: process.arch.startsWith("arm") ? "arm" : "x86",
    model: "",
    mobile: false,
    bitness: process.arch.includes("64") ? "64" : "32",
    wow64: false
  };
};

const readUserAgentData = async (browser) => {
  const page = await browser.newPage();

  try {
    return await page.evaluate(async () => {
      const data = navigator.userAgentData;
      if (!data) {
        return null;
      }
      const high = await data.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64"]);
      return {brands: data.brands, mobile: data.mobile, platform: data.platform, ...high, navigatorPlatform: navigator.platform};
    });
  } catch (e) {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
};

exports.create = ({concurrency, timeout}) => {
  const maxQueue = concurrency * 5;
  const queue = [];
  let active = 0;
  let browserPromise = null;
  let userAgent = null;
  let userAgentMetadata = null;
  let platform = null;

  const launch = () => {
    if (!browserPromise) {
      browserPromise = puppeteer.launch(exports.getLaunchOptions()).then(async (browser) => {
        userAgent = (await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
        const raw = await readUserAgentData(browser);
        const version = await browser.version();
        userAgentMetadata = exports.toUserAgentMetadata(raw, version);
        platform = raw?.navigatorPlatform || ({linux: "Linux x86_64", darwin: "MacIntel", win32: "Win32"})[process.platform] || "Linux x86_64";
        // Sites treat an outdated browser version as a bot signal, so it is worth seeing which Chrome actually runs
        Utils.log(`Inspect browser: ${version} (${exports.getLaunchOptions().executablePath || "puppeteer's bundled Chrome"}, ${exports.getLaunchOptions().headless ? "headless" : "headed"})`);
        browser.on("disconnected", () => {
          Utils.log("Inspect browser disconnected, it will be relaunched with the next request");
          browserPromise = null;
        });
        return browser;
      }).catch((e) => {
        browserPromise = null;
        throw e;
      });
    }

    return browserPromise;
  };

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      next.start();
    }
  };

  // Waits for a free slot. Rejects with "busy" if the queue is full, the deadline passes while waiting or the client
  // went away (signal).
  const acquire = (deadline, signal) => new Promise((resolve, reject) => {
    if (active < concurrency) {
      active++;
      resolve(release);
      return;
    }

    if (queue.length >= maxQueue) {
      reject(new InspectError("busy", `${active} inspects running, ${queue.length} waiting`));
      return;
    }

    const entry = {};
    const remove = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      remove();
      reject(new InspectError("busy", "client went away while waiting for a free slot"));
    };
    const timer = setTimeout(() => {
      remove();
      reject(new InspectError("busy", "no free slot before the timeout"));
    }, Math.max(deadline - Date.now(), 0));

    entry.start = () => {
      remove();
      active++;
      resolve(release);
    };

    signal?.addEventListener("abort", onAbort);
    queue.push(entry);
  });

  return {
    launch,
    acquire,
    timeout,
    getUserAgent: () => userAgent,
    getUserAgentMetadata: () => userAgentMetadata,
    getPlatform: () => platform,
    close: async () => {
      if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        await browser?.close();
      }
    }
  };
};
