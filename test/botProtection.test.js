const test = require("node:test");
const assert = require("node:assert/strict");
const BotProtection = require("../src/BotProtection.js");
const InspectBrowser = require("../src/InspectBrowser.js");

const page = (overrides = {}) => ({
  title: "", description: "", text: "", sources: [],
  ...overrides,
  markers: {pxCaptcha: false, pxGlobal: false, cloudflareChallenge: false, turnstile: false, recaptcha: false, hcaptcha: false, ...overrides.markers}
});

const CASES = [
  {
    name: "PerimeterX press & hold (as seen on a real site)",
    input: {status: 403, headers: {}, page: page({
      title: "Access to this page has been denied", description: "px-captcha",
      text: "Before we continue... Press & Hold to confirm you are a human (and not a bot). Reference ID b1d6683f"
    })},
    expected: {vendor: "perimeterx", challenge: true}
  },
  {
    name: "PerimeterX captcha element",
    input: {status: 403, headers: {}, page: page({markers: {pxCaptcha: true}})},
    expected: {vendor: "perimeterx", challenge: true}
  },
  {
    name: "PerimeterX sensor on a normal page",
    input: {status: 200, headers: {}, page: page({title: "Shop", markers: {pxGlobal: true}, sources: ["https://client.px-cloud.net/PXabc/main.min.js"]})},
    expected: {vendor: "perimeterx", challenge: false}
  },
  {
    name: "Cloudflare managed challenge header",
    input: {status: 403, headers: {"cf-mitigated": "challenge", server: "cloudflare"}, page: page({title: "Just a moment..."})},
    expected: {vendor: "cloudflare", challenge: true}
  },
  {
    name: "Cloudflare interstitial title only",
    input: {status: 503, headers: {}, page: page({title: "Just a moment..."})},
    expected: {vendor: "cloudflare", challenge: true}
  },
  {
    name: "Cloudflare challenge-platform script on a normal page",
    input: {status: 200, headers: {}, page: page({title: "Shop", sources: ["https://shop.example.com/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"]})},
    expected: {vendor: "cloudflare", challenge: false}
  },
  {
    name: "DataDome captcha",
    input: {status: 403, headers: {"x-datadome": "protected"}, page: page({sources: ["https://geo.captcha-delivery.com/captcha/?initialCid=abc"]})},
    expected: {vendor: "datadome", challenge: true}
  },
  {
    name: "Akamai access denied",
    input: {status: 403, headers: {server: "AkamaiGHost"}, page: page({
      title: "Access Denied", text: "Access Denied You don't have permission to access \"http://www.example.com/\" on this server. Reference #18.abc.123"
    })},
    expected: {vendor: "akamai", challenge: true}
  },
  {
    name: "Imperva incident",
    input: {status: 200, headers: {"x-iinfo": "1-2-3"}, page: page({text: "Request unsuccessful. Incapsula incident ID: 123-456"})},
    expected: {vendor: "imperva", challenge: true}
  },
  {
    name: "AWS WAF captcha",
    input: {status: 405, headers: {"x-amzn-waf-action": "captcha"}, page: page({})},
    expected: {vendor: "aws-waf", challenge: true}
  },
  {
    name: "reCAPTCHA on a contact form is not a challenge",
    input: {status: 200, headers: {}, page: page({title: "Contact", markers: {recaptcha: true}})},
    expected: {vendor: "recaptcha", challenge: false}
  },
  {
    name: "Unknown vendor asking to prove being human",
    input: {status: 429, headers: {}, page: page({title: "Blocked", text: "We detected unusual traffic from your network. Please verify you are human."})},
    expected: {vendor: "unknown", challenge: true}
  }
];

for (const {name, input, expected} of CASES) {
  test(`detects: ${name}`, () => {
    const result = BotProtection.detect(input);
    assert.ok(result, "detected");
    assert.equal(result.vendor, expected.vendor);
    assert.equal(result.challenge, expected.challenge);
    assert.ok(result.signals.length > 0);
  });
}

test("a normal page has no bot protection", () => {
  assert.equal(BotProtection.detect({status: 200, headers: {server: "nginx"}, page: page({title: "Shop", text: "Welcome"})}), null);
  // A plain 404 is not a challenge
  assert.equal(BotProtection.detect({status: 404, headers: {}, page: page({title: "Not found"})}), null);
  // No page signals (evaluation failed)
  assert.equal(BotProtection.detect({status: 200, headers: {}, page: null}), null);
});

test("client hints: HeadlessChrome is renamed, everything else stays", () => {
  const metadata = InspectBrowser.toUserAgentMetadata({
    brands: [{brand: "Chromium", version: "124"}, {brand: "HeadlessChrome", version: "124"}, {brand: "Not-A.Brand", version: "99"}],
    fullVersionList: [{brand: "Chromium", version: "124.0.6367.91"}, {brand: "HeadlessChrome", version: "124.0.6367.91"}],
    platform: "Linux", platformVersion: "6.1.0", architecture: "x86", model: "", mobile: false, bitness: "64", wow64: false
  }, "HeadlessChrome/124.0.6367.91");

  assert.deepEqual(metadata.brands, [{brand: "Chromium", version: "124"}, {brand: "Google Chrome", version: "124"}, {brand: "Not-A.Brand", version: "99"}]);
  assert.deepEqual(metadata.fullVersionList[1], {brand: "Google Chrome", version: "124.0.6367.91"});
  assert.equal(metadata.platform, "Linux");
  assert.equal(metadata.platformVersion, "6.1.0");
  assert.doesNotMatch(JSON.stringify(metadata), /Headless/);
});

test("client hints: fallback from the version when they cannot be read", () => {
  const metadata = InspectBrowser.toUserAgentMetadata(null, "HeadlessChrome/124.0.6367.91");
  assert.deepEqual(metadata.brands.map((brand) => brand.brand), ["Chromium", "Google Chrome", "Not-A.Brand"]);
  assert.equal(metadata.brands[0].version, "124");
  assert.equal(metadata.fullVersionList[0].version, "124.0.6367.91");
  assert.equal(metadata.mobile, false);
});
