const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const AddressPolicy = require("../src/AddressPolicy.js");
const Inspect = require("../src/Inspect.js");
const InspectBrowser = require("../src/InspectBrowser.js");
const Utils = require("../src/Utils.js");
const {tempDir} = require("./helpers.js");

test("parseParams: defaults", () => {
  const params = Inspect.parseParams({url: "https://www.example.com"}, 30000);
  assert.equal(params.width, 1440);
  assert.equal(params.height, 900);
  assert.equal(params.fullPage, true);
  assert.equal(params.maxHeight, 4000);
  assert.equal(params.quality, 70);
  assert.equal(params.scroll, true);
  assert.equal(params.timeout, 20000);
  assert.equal(params.maxLinks, 200);
  assert.equal(params.maxText, 20000);
  assert.equal(params.acceptLanguage, "de-DE,de,en");
});

test("parseParams: acceptLanguage is a language list, q-values are dropped", () => {
  const parse = (acceptLanguage) => Inspect.parseParams({url: "https://www.example.com", acceptLanguage}, 30000).acceptLanguage;
  assert.equal(parse("en-US,en;q=0.9"), "en-US,en");
  assert.equal(parse("fr"), "fr");
  assert.equal(parse(" it-IT , it ; q=0.8 "), "it-IT,it");
  assert.equal(parse("en\r\nX-Evil: 1"), "de-DE,de,en");
  assert.equal(parse(""), "de-DE,de,en");
  assert.equal(parse(42), "de-DE,de,en");
});

test("parseParams: numbers are clamped, the timeout stays below TIMEOUT", () => {
  const params = Inspect.parseParams({
    url: "https://www.example.com", width: 99999, height: 1, maxHeight: "50000", quality: 0, timeout: 120000,
    maxLinks: -5, maxText: "abc", fullPage: false, scroll: "false", acceptLanguage: "en\r\nX-Evil: 1"
  }, 30000);
  assert.equal(params.width, 3840);
  assert.equal(params.height, 320);
  assert.equal(params.maxHeight, 16000);
  assert.equal(params.quality, 1);
  assert.equal(params.timeout, 22000);
  assert.equal(params.maxLinks, 0);
  assert.equal(params.maxText, 20000);
  assert.equal(params.fullPage, false);
  assert.equal(params.scroll, false);
  assert.equal(params.acceptLanguage, "de-DE,de,en");
});

test("parseParams: invalid urls", () => {
  for (const url of [undefined, "", "not a url", "/relative", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/",
    "https://user:pass@example.com/", "https://example.com/" + "a".repeat(3000)]) {
    assert.throws(() => Inspect.parseParams({url}, 30000), (e) => e.code === "invalid" && Utils.getError(e).startsWith("invalid: "), String(url));
  }
});

// A manager whose acquire must never be called: refused start URLs are rejected before taking a slot
const strictManager = {
  timeout: 30000,
  acquire: () => {
    throw new Error("acquire must not be called");
  }
};

test("run: a start URL on a private address answers 'blocked address'", async () => {
  const allowPrivate = AddressPolicy.parseAllowPrivate("");

  for (const url of ["http://localhost/", "http://127.0.0.1/", "http://2130706433/", "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[::1]:443/", "https://8.8.8.8:8443/"]) {
    await assert.rejects(Inspect.run(strictManager, {url}, {allowPrivate}), (e) => {
      assert.equal(e.code, "blocked address", url);
      assert.match(Utils.getError(e), /^blocked address: /);
      return true;
    }, url);
  }
});

test("run: an unknown host answers 'dns'", async () => {
  await assert.rejects(
    Inspect.run(strictManager, {url: "https://fury-test.invalid/"}, {allowPrivate: AddressPolicy.parseAllowPrivate("")}),
    (e) => e.code === "dns"
  );
});

test("queue: bounded, deadline and client abort answer 'busy'", async () => {
  const manager = InspectBrowser.create({concurrency: 1, timeout: 30000});
  const farDeadline = Date.now() + 60000;

  const release = await manager.acquire(farDeadline);

  // 5 may wait (concurrency * 5), the 6th is refused immediately
  const waiting = Array.from({length: 5}, () => manager.acquire(farDeadline));
  await assert.rejects(manager.acquire(farDeadline), (e) => e.code === "busy");

  // Releasing hands the slot to the first waiting request
  release();
  const secondRelease = await waiting[0];

  // A waiting request whose client went away leaves the queue
  const controller = new AbortController();
  const aborted = manager.acquire(farDeadline, controller.signal);
  controller.abort();
  await assert.rejects(aborted, (e) => e.code === "busy" && /went away/.test(e.message));

  // Waiting longer than the deadline
  secondRelease();
  for (const promise of waiting.slice(1)) {
    (await promise)();
  }
  const blocker = await manager.acquire(farDeadline);
  await assert.rejects(manager.acquire(Date.now() + 50), (e) => e.code === "busy" && /before the timeout/.test(e.message));
  blocker();
});

test("files: written under UUID names, cleanup removes only old /inspect files", async () => {
  const dir = tempDir();

  const files = await Inspect.writeFiles(dir, {metadata: {title: "Ä"}, screenshot: Buffer.from([0xff, 0xd8, 0xff])});
  assert.match(files.file, /^[0-9a-f-]{36}\.json$/);
  assert.equal(files.screenshot, files.file.replace(".json", ".jpg"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, files.file), "utf8")), {title: "Ä"});
  assert.deepEqual([...fs.readFileSync(path.join(dir, files.screenshot))], [0xff, 0xd8, 0xff]);

  const old = new Date(Date.now() - 2 * 3600 * 1000);
  const oldInspect = "0b6c2c1e-5d0a-4a43-9a51-1d2c3b4a5f60.json";
  const oldTmp = "0b6c2c1e-5d0a-4a43-9a51-1d2c3b4a5f60.jpg.tmp";
  const oldOther = "a1b2c3-1700000000000.jpeg";
  for (const name of [oldInspect, oldTmp, oldOther]) {
    fs.writeFileSync(path.join(dir, name), "x");
    fs.utimesSync(path.join(dir, name), old, old);
  }

  await Inspect.cleanupSaveDir(dir, 3600);

  const remaining = fs.readdirSync(dir).sort();
  assert.deepEqual(remaining, [files.file, files.screenshot, oldOther].sort());
});
