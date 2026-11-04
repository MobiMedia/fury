// Recognizes bot protection / CAPTCHA pages for /inspect. Informational only: Fury does not solve or click through a
// challenge, it only tells the caller that the page it got is (or contains) one. (Separately, InspectBrowser reduces
// the automation signals of the browser so it is not blocked merely for being headless - see README "Bot protection".)

// Collected inside the page (must stay self-contained). Runs in an isolated world: page JavaScript globals are not
// visible there, so everything is read from the DOM.
exports.collectPageSignals = () => {
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  };
  const has = (selector) => safe(() => !!document.querySelector(selector), false);

  return {
    title: safe(() => String(document.title || ""), ""),
    description: safe(() => document.querySelector("meta[name=description i]")?.getAttribute("content") || "", ""),
    text: safe(() => (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim().slice(0, 2000), ""),
    sources: safe(() => Array.from(document.querySelectorAll("script[src], iframe[src]")).map((el) => el.src).slice(0, 200), []),
    markers: {
      pxCaptcha: has("#px-captcha"),
      // The PerimeterX snippet sets window._pxAppId in an inline script
      pxGlobal: safe(() => Array.from(document.querySelectorAll("script:not([src])")).slice(0, 100)
        .some((el) => String(el.textContent || "").slice(0, 50000).includes("_pxAppId")), false),
      cloudflareChallenge: has("#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running, .cf-browser-verification"),
      turnstile: has(".cf-turnstile, iframe[src*='challenges.cloudflare.com']"),
      recaptcha: has(".g-recaptcha, iframe[src*='google.com/recaptcha'], iframe[src*='recaptcha.net']"),
      hcaptcha: has(".h-captcha, iframe[src*='hcaptcha.com']")
    }
  };
};

const BLOCKING_STATUS = [401, 403, 429, 503];

const HUMAN_CHECK_TEXT = /(are you a (human|robot)|not a robot|verify (that )?you are (a )?human|confirm you are (a )?human|unusual traffic|automated (queries|requests|access)|bot detection|press (&|and) hold|checking (if the site connection is secure|your browser))/i;

/**
 * @param {object} input
 * @param {number|null} input.status - HTTP status of the main document
 * @param {object} input.headers - response headers of the main document (lower case names)
 * @param {object|null} input.page - collectPageSignals() result
 * @returns {{vendor: string, challenge: boolean, signals: string[]}|null}
 */
exports.detect = ({status, headers = {}, page}) => {
  const signals = page || {title: "", description: "", text: "", sources: [], markers: {}};
  const markers = signals.markers || {};
  const sources = (signals.sources || []).join(" ").toLowerCase();
  const title = signals.title || "";
  const text = signals.text || "";
  const header = (name) => String(headers[name] || "").toLowerCase();
  const blockingStatus = BLOCKING_STATUS.includes(status);

  // Each candidate: vendor, the signals that matched, and whether the page itself is a challenge
  const candidates = [];
  const add = (vendor, found, challenge) => {
    const matched = found.filter(Boolean);
    if (matched.length) {
      candidates.push({vendor, challenge: !!challenge, signals: matched});
    }
  };

  // PerimeterX / HUMAN
  {
    const captcha = markers.pxCaptcha || /px-captcha/i.test(signals.description);
    add("perimeterx", [
      markers.pxCaptcha && "#px-captcha",
      /px-captcha/i.test(signals.description) && "meta description px-captcha",
      markers.pxGlobal && "_pxAppId script",
      /px-cdn\.net|px-cloud\.net|perimeterx\.net|\/px\/client\/main\.min\.js/.test(sources) && "PerimeterX script"
    ], captcha || (blockingStatus && /access to this page has been denied/i.test(title)));
  }

  // Cloudflare
  {
    const mitigated = header("cf-mitigated") === "challenge";
    const interstitialTitle = /^just a moment\.\.\.$|attention required! \| cloudflare/i.test(title.trim());
    add("cloudflare", [
      mitigated && "cf-mitigated: challenge",
      interstitialTitle && `title "${title.trim()}"`,
      markers.cloudflareChallenge && "challenge form",
      markers.turnstile && "Turnstile widget",
      /\/cdn-cgi\/challenge-platform\//.test(sources) && "challenge-platform script"
    ], mitigated || interstitialTitle || markers.cloudflareChallenge || (blockingStatus && markers.turnstile));
  }

  // DataDome
  {
    const captcha = /captcha-delivery\.com/.test(sources);
    add("datadome", [
      headers["x-datadome"] !== undefined && "x-datadome header",
      headers["x-dd-b"] !== undefined && "x-dd-b header",
      captcha && "captcha-delivery.com",
      /js\.datadome\.co|datadome\.co\/tags/.test(sources) && "DataDome script"
    ], captcha || (blockingStatus && (headers["x-datadome"] !== undefined || headers["x-dd-b"] !== undefined)));
  }

  // Akamai
  {
    const denied = blockingStatus && /access denied/i.test(title + " " + text) && /reference\s*#/i.test(text);
    add("akamai", [
      denied && "Access Denied with reference",
      /akamaighost/.test(header("server")) && blockingStatus && "server: AkamaiGHost",
      /powered and protected by akamai/i.test(text) && "protected by Akamai"
    ], denied || (blockingStatus && /powered and protected by akamai/i.test(text)));
  }

  // Imperva / Incapsula
  {
    const incident = /incapsula incident id|_incapsula_resource/i.test(text + " " + sources);
    add("imperva", [
      incident && "Incapsula incident / resource",
      headers["x-iinfo"] !== undefined && "x-iinfo header",
      /incapsula/.test(header("x-cdn")) && "x-cdn: Incapsula"
    ], incident);
  }

  // AWS WAF
  {
    const action = header("x-amzn-waf-action");
    add("aws-waf", [
      action && `x-amzn-waf-action: ${action}`,
      /awswaf\.com/.test(sources) && "AWS WAF script"
    ], action === "captcha" || action === "challenge");
  }

  // Generic CAPTCHA widgets: a challenge only if the page itself was refused
  add("recaptcha", [markers.recaptcha && "reCAPTCHA widget"], blockingStatus);
  add("hcaptcha", [markers.hcaptcha && "hCaptcha widget"], blockingStatus);

  // A refused page asking to prove being human, without a known vendor
  if (!candidates.some((candidate) => candidate.challenge) && blockingStatus && HUMAN_CHECK_TEXT.test(`${title} ${text}`)) {
    candidates.push({vendor: "unknown", challenge: true, signals: [`status ${status}`, "human check text"]});
  }

  if (!candidates.length) {
    return null;
  }

  // A challenge wins over mere presence of a vendor script
  const result = candidates.find((candidate) => candidate.challenge) || candidates[0];
  if (result.challenge && status && !result.signals.includes(`status ${status}`)) {
    result.signals.push(`status ${status}`);
  }
  return result;
};
