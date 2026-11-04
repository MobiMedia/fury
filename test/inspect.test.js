const {describe, test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {startFixtureServer, startSecretServer, startFury, post, tempDir, jpegPixel} = require("./helpers.js");

// Integration tests: real Fury processes with Chrome against local fixture servers.

describe("/inspect with files (FURY_SAVE_DIR) and an exempt fixture host", () => {
  let fixture;
  let secret;
  let fury;
  let saveDir;
  let base;

  const oldInspectFile = "0b6c2c1e-5d0a-4a43-9a51-1d2c3b4a5f60.json";
  const oldOtherFile = "a1b2c3-1700000000000.jpeg";

  before(async () => {
    secret = await startSecretServer();
    fixture = await startFixtureServer({secretPort: secret.port});
    base = `http://127.0.0.1:${fixture.port}`;
    saveDir = tempDir();

    // Old files for the cleanup test
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    for (const name of [oldInspectFile, oldOtherFile]) {
      fs.writeFileSync(path.join(saveDir, name), "x");
      fs.utimesSync(path.join(saveDir, name), old, old);
    }

    fury = await startFury({
      FURY_ENDPOINTS: "render,inspect",
      FURY_INSPECT_ALLOW_PRIVATE: `127.0.0.1:${fixture.port}`,
      FURY_SAVE_DIR: saveDir,
      FURY_SAVE_DIR_MAX_AGE: "3600"
    });
  });

  after(async () => {
    await fury?.close();
    await fixture?.close();
    await secret?.close();
  });

  const inspect = async (body) => {
    const {body: response} = await post(fury.port, "/inspect", body);
    assert.equal(response.error, null, response.error);
    return {
      response,
      metadata: JSON.parse(fs.readFileSync(path.join(saveDir, response.file), "utf8")),
      screenshot: fs.readFileSync(path.join(saveDir, response.screenshot))
    };
  };

  test("warns at start about FURY_INSPECT_ALLOW_PRIVATE", () => {
    assert.match(fury.output(), /FURY_INSPECT_ALLOW_PRIVATE is set \(127\.0\.0\.1:\d+\)/);
  });

  test("files: <id>.jpg and <id>.json, the response names them; old /inspect files are cleaned up", async () => {
    const {response, screenshot} = await inspect({url: `${base}/simple.html`});

    assert.match(response.file, /^[0-9a-f-]{36}\.json$/);
    assert.equal(response.screenshot, response.file.replace(/\.json$/, ".jpg"));
    assert.deepEqual([...screenshot.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(fs.readdirSync(saveDir).some((name) => name.endsWith(".tmp")), false);

    // The cleanup runs in the background of the request
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(path.join(saveDir, oldInspectFile)), false);
    assert.equal(fs.existsSync(path.join(saveDir, oldOtherFile)), true);
  });

  test("metadata of a shop page", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/shop.html`});

    assert.equal(metadata.requestedUrl, `${base}/shop.html`);
    assert.equal(metadata.finalUrl, `${base}/shop.html`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.redirects, []);
    assert.equal(metadata.title, "Nordlicht Shoes – Schuhe aus dem Norden");
    assert.equal(metadata.lang, "de");
    assert.equal(metadata.extractError, undefined);

    assert.deepEqual(metadata.meta, {
      description: "Handgemachte Schuhe aus Hamburg.",
      themeColor: "#1f4e5f",
      ogSiteName: "Nordlicht Shoes",
      ogType: "website",
      ogImage: `${base}/og.jpg`,
      canonical: `${base}/de/`
    });
    assert.deepEqual(metadata.alternates, [{hreflang: "en", url: `${base}/en/`}, {hreflang: "de", url: `${base}/de/`}]);

    assert.deepEqual(metadata.logos[0], {url: `${base}/logo.svg`, source: "img", alt: "Nordlicht Shoes"});
    assert.ok(metadata.logos.some((logo) => logo.source === "apple-touch-icon" && logo.url === `${base}/apple-touch-icon.png`));
    assert.ok(metadata.logos.some((logo) => logo.source === "icon" && logo.url === `${base}/favicon.ico`));
    assert.ok(metadata.logos.some((logo) => logo.source === "og:image"));

    assert.deepEqual(metadata.headings, [{level: 1, text: "Schuhe aus dem Norden"}, {level: 2, text: "Neu eingetroffen"}]);

    // Deduplicated by URL (fragment removed), document order, no mailto/tel/javascript, areas from the closest landmark
    assert.deepEqual(metadata.links, [
      {url: `${base}/`, text: "Nordlicht Shoes", area: "header", sameSite: true},
      {url: `${base}/women`, text: "Women", area: "nav", sameSite: true},
      {url: `${base}/men`, text: "Men", area: "nav", sameSite: true},
      {url: `${base}/p/fjord-boot`, text: "Fjord Boot", area: "main", sameSite: true},
      {url: "https://www.instagram.com/nordlicht", text: "Instagram", area: "main", sameSite: false},
      {url: `${base}/sale`, text: "Zum Sale", area: "main", sameSite: true},
      {url: `${base}/impressum`, text: "Impressum", area: "footer", sameSite: true}
    ]);

    assert.match(metadata.text, /Robuste Stiefel, handgemacht in Hamburg\./);
    assert.doesNotMatch(metadata.text, /Impressum/, "text comes from main");

    assert.deepEqual(metadata.products, [{
      name: "Fjord Boot", price: "149.90", currency: "EUR", image: `${base}/img/fjord.jpg`, url: `${base}/p/fjord-boot`, source: "json-ld"
    }]);
    assert.equal(metadata.jsonLd.length, 2, "invalid JSON-LD is skipped");
    assert.equal(metadata.jsonLd[0]["@type"], "Organization");

    // Computed colors; the transparent header resolves to the white wrapper
    assert.deepEqual(metadata.colors.page, {background: "#f7f5f0", text: "#1b1d1e"});
    assert.deepEqual(metadata.colors.header, {background: "#ffffff", text: "#1b1d1e"});
    assert.deepEqual(metadata.colors.footer, {background: "#1f4e5f", text: "#ffffff"});
    assert.deepEqual(metadata.colors.buttons[0], {background: "#1f4e5f", text: "#ffffff", label: "Zum Sale"});
    assert.ok(metadata.colors.buttons.some((button) => button.label === "Anmelden"));
    assert.equal(metadata.colors.links[0], "#2a6f97");
    assert.equal(metadata.colors.variables["--color-primary"], "#1f4e5f");
    assert.equal(metadata.colors.variables["--brand-accent"], "#2a6f97");
    assert.equal(metadata.colors.variables["--spacing"], undefined);
    assert.equal(metadata.colors.variables["--tw-channels"], undefined);

    assert.match(metadata.fonts.body, /Source Sans 3/);
    assert.match(metadata.fonts.headings, /Georgia/);
    assert.equal(metadata.hasLoginForm, true);

    assert.deepEqual(metadata.blocked, []);
    assert.equal(typeof metadata.timings.navigationMs, "number");
    assert.ok(metadata.timings.totalMs >= metadata.timings.navigationMs);

    const pixel = await jpegPixel(screenshot, 0, 0);
    assert.equal(pixel.width, 1440);
    assert.equal(pixel.height, 900);
  });

  test("a client side rendered page shows up in text and screenshot", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/csr.html`});

    assert.match(metadata.text, /Rendered by script/);
    const pixel = await jpegPixel(screenshot, 50, 50);
    assert.ok(pixel.r > 200 && pixel.g < 60 && pixel.b < 60, JSON.stringify(pixel));
  });

  test("security: private targets of the page are aborted, listed and never reached", async () => {
    const {metadata} = await inspect({url: `${base}/security.html`});

    const blocked = metadata.blocked.join("\n");
    assert.match(blocked, new RegExp(`http://127\\.0\\.0\\.1:${secret.port}/secret-iframe \\(private address\\)`));
    assert.match(blocked, new RegExp(`http://localhost:${secret.port}/secret-img \\(private address\\)`));
    assert.match(blocked, /http:\/\/169\.254\.169\.254\/latest\/meta-data\/ \(private address\)/);

    // iframe, img, fetch and WebSocket: not a single TCP connection reached the secret server
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(secret.state.connections, 0);
  });

  test("HTTP status >= 400 is not an error", async () => {
    const {metadata} = await inspect({url: `${base}/missing.html`});
    assert.equal(metadata.status, 404);
    assert.equal(metadata.title, "Not found");
  });

  test("redirects are listed", async () => {
    const {metadata} = await inspect({url: `${base}/redirect`});
    assert.equal(metadata.status, 200);
    assert.equal(metadata.finalUrl, `${base}/simple.html`);
    assert.deepEqual(metadata.redirects, [`${base}/redirect`, `${base}/simple.html`]);
  });

  test("an exception in the extraction keeps the screenshot", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/broken-extract.html`});
    assert.match(metadata.extractError, /title getter exploded/);
    assert.equal(metadata.status, 200);
    assert.ok(screenshot.length > 100);
  });

  test("/screenshot still loads a localhost page (no regression)", async () => {
    const {body} = await post(fury.port, "/screenshot", {url: `http://localhost:${fixture.port}/simple.html`, width: 800, height: 600});
    assert.equal(body.error, undefined);
    assert.match(body.file, /\.jpeg$/);
    assert.ok(fs.statSync(path.join(saveDir, body.file)).size > 100);
  });
});

describe("/inspect inline (without FURY_SAVE_DIR)", () => {
  let fixture;
  let fury;

  before(async () => {
    fixture = await startFixtureServer();
    fury = await startFury({FURY_ENDPOINTS: "inspect", FURY_INSPECT_ALLOW_PRIVATE: `127.0.0.1:${fixture.port}`});
  });

  after(async () => {
    await fury?.close();
    await fixture?.close();
  });

  test("JSON: metadata and base64 screenshot", async () => {
    const {body} = await post(fury.port, "/inspect", {url: `http://127.0.0.1:${fixture.port}/simple.html`});
    assert.equal(body.error, null);
    assert.equal(body.data.metadata.title, "Simple");
    assert.match(body.data.screenshot, /^\/9j\//);
  });

  test("msgpack: binary screenshot", async () => {
    const {body} = await post(fury.port, "/inspect", {url: `http://127.0.0.1:${fixture.port}/simple.html`}, {msgpack: true});
    assert.equal(body.error, null);
    assert.equal(body.data.metadata.title, "Simple");
    assert.deepEqual([...body.data.screenshot.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  });

  test("render endpoints are not served in inspect mode", async () => {
    const {status} = await post(fury.port, "/screenshot", {url: `http://127.0.0.1:${fixture.port}/simple.html`});
    assert.equal(status, 404);
  });
});

describe("/inspect without FURY_INSPECT_ALLOW_PRIVATE", () => {
  let fixture;
  let fury;

  before(async () => {
    fixture = await startFixtureServer();
    fury = await startFury({FURY_ENDPOINTS: "inspect"});
  });

  after(async () => {
    await fury?.close();
    await fixture?.close();
  });

  test("a local start URL answers 'blocked address'", async () => {
    for (const url of ["http://localhost/", `http://127.0.0.1:${fixture.port}/shop.html`, "http://169.254.169.254/"]) {
      const {body} = await post(fury.port, "/inspect", {url});
      assert.equal(body.data, null);
      assert.match(body.error, /^blocked address: /, url);
    }

    const {body} = await post(fury.port, "/inspect", {url: "http://localhost/"}, {msgpack: true});
    assert.match(body.error, /^blocked address: /);
  });

  test("an invalid request answers 'invalid'", async () => {
    const {body} = await post(fury.port, "/inspect", {url: "file:///etc/passwd"});
    assert.match(body.error, /^invalid: /);
  });

  test("no warning without the flag", () => {
    assert.doesNotMatch(fury.output(), /FURY_INSPECT_ALLOW_PRIVATE/);
  });
});
