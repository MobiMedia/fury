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
    ignoreHTTPSErrors: true,
    args: [
      ...base.args,
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

exports.create = ({concurrency, timeout}) => {
  const maxQueue = concurrency * 5;
  const queue = [];
  let active = 0;
  let browserPromise = null;
  let userAgent = null;

  const launch = () => {
    if (!browserPromise) {
      browserPromise = puppeteer.launch(exports.getLaunchOptions()).then(async (browser) => {
        userAgent = (await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
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
    close: async () => {
      if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        await browser?.close();
      }
    }
  };
};
