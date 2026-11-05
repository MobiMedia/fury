const {describe, test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {startFixtureServer, startSecretServer, startFury, post, tempDir, jpegPixel, dataUrlPixel} = require("./helpers.js");

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
    const {response, metadata, screenshot} = await inspect({url: `${base}/shop.html`});

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
      canonical: `${base}/de/`
    });
    assert.deepEqual(metadata.alternates, [{hreflang: "en", url: `${base}/en/`}, {hreflang: "de", url: `${base}/de/`}]);

    // Images: visible ones (logo candidates first) and the declared ones, each with its file next to the JSON
    const logo = metadata.images[0];
    assert.deepEqual({...logo, file: undefined, bytes: undefined, x: undefined, y: undefined}, {
      url: `${base}/logo.svg`, file: undefined, bytes: undefined, rendered: false, source: "img", format: "svg",
      alt: "Nordlicht Shoes", width: 120, height: 40, naturalWidth: 120, naturalHeight: 40, x: undefined, y: undefined,
      shape: "landscape", area: "header", visible: true, hints: ["logo", "links-home", "header", "above-fold"],
      link: `${base}/`, color: null, background: "#ffffff"
    });
    assert.match(logo.file, /^[0-9a-f-]{36}-image-\d+\.svg$/);
    assert.deepEqual(fs.readFileSync(path.join(saveDir, logo.file)), fs.readFileSync(path.join(__dirname, "fixtures", "logo.svg")));
    assert.equal(logo.bytes, fs.statSync(path.join(saveDir, logo.file)).size);
    assert.ok(Number.isInteger(logo.x) && Number.isInteger(logo.y) && logo.y < 100);
    assert.ok(response.images.includes(logo.file));
    for (const image of metadata.images.filter((entry) => entry.file)) {
      assert.ok(fs.existsSync(path.join(saveDir, image.file)), image.file);
    }

    const instagram = metadata.images.find((image) => image.url === `${base}/instagram.svg`);
    assert.equal(instagram.area, "main");
    assert.equal(instagram.hints.includes("logo"), false);
    assert.equal(instagram.file, null, "404: no file");
    assert.equal(instagram.link, "https://www.instagram.com/nordlicht");

    // Declared, never loaded by the page: loaded afterwards through the page, the real type comes from the content
    const touchIcon = metadata.images.find((image) => image.source === "apple-touch-icon" && image.url === `${base}/apple-touch-icon.png`);
    assert.match(touchIcon.file, /-image-\d+\.png$/);
    assert.equal(touchIcon.format, "png");
    assert.ok(metadata.images.some((image) => image.source === "icon" && image.url === `${base}/favicon.ico`));
    assert.ok(metadata.images.some((image) => image.source === "og:image" && image.url === `${base}/og.jpg`));

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

    // Structured data as declared by the page, not interpreted
    const {jsonLd, microdata, openGraph, twitter} = metadata.structuredData;
    assert.equal(jsonLd.length, 2, "invalid JSON-LD is skipped");
    assert.equal(jsonLd[0]["@type"], "Organization");
    assert.deepEqual(jsonLd[1].offers, {"@type": "Offer", price: "149.90", priceCurrency: "EUR"});
    assert.deepEqual(microdata, [{
      type: "https://schema.org/Product",
      properties: {
        name: "Fjord Boot",
        offers: {type: "https://schema.org/Offer", properties: {price: "149.90", priceCurrency: "EUR"}}
      }
    }]);
    assert.deepEqual(openGraph, {"og:site_name": "Nordlicht Shoes", "og:type": "website", "og:image": `${base}/og.jpg`});
    assert.deepEqual(twitter, {"twitter:card": "summary"});

    // Forms: visible fields only (no hidden ones), labels from <label>/placeholder
    assert.deepEqual(metadata.forms, [{
      action: `${base}/login`,
      method: "post",
      area: "main",
      fields: [
        {type: "text", name: "user", label: "E-Mail", required: false},
        {type: "password", name: "password", label: "Passwort", required: true}
      ],
      submit: "Anmelden"
    }]);

    // Computed colors; the transparent header resolves to the white wrapper
    assert.deepEqual(metadata.colors.page, {background: "#f7f5f0", text: "#1b1d1e"});
    // Regions: semantic <header>/<main>/<footer>, each with its own colors
    const {header, content, footer} = metadata.colors;
    assert.equal(header.source, "semantic");
    assert.equal(header.background, "#ffffff");
    assert.equal(header.text, "#1b1d1e");
    assert.deepEqual(header.backgrounds, [{color: "#ffffff", share: 1}]);
    assert.deepEqual(header.links, ["#1b1d1e"]);
    assert.equal(content.source, "semantic");
    assert.equal(content.background, "#f7f5f0");
    assert.equal(content.backgrounds[0].color, "#f7f5f0");
    assert.equal(content.text, "#1b1d1e");
    assert.equal(content.headings, "#1b1d1e");
    assert.deepEqual(content.links, ["#2a6f97", "#ffffff"]);
    assert.deepEqual(content.buttons[0], {background: "#1f4e5f", text: "#ffffff", label: "Zum Sale"});
    assert.equal(footer.source, "semantic");
    assert.equal(footer.background, "#1f4e5f");
    assert.equal(footer.text, "#ffffff");
    assert.deepEqual(footer.links, ["#ffffff"]);
    assert.ok(header.bounds.y < content.bounds.y && content.bounds.y < footer.bounds.y);
    assert.deepEqual(metadata.colors.buttons[0], {background: "#1f4e5f", text: "#ffffff", label: "Zum Sale"});
    assert.ok(metadata.colors.buttons.some((button) => button.label === "Anmelden"));
    assert.equal(metadata.colors.links[0], "#2a6f97");
    assert.equal(metadata.colors.variables["--color-primary"], "#1f4e5f");
    assert.equal(metadata.colors.variables["--brand-accent"], "#2a6f97");
    assert.equal(metadata.colors.variables["--spacing"], undefined);
    assert.equal(metadata.colors.variables["--tw-channels"], undefined);

    assert.match(metadata.fonts.body, /Source Sans 3/);
    assert.match(metadata.fonts.headings, /Georgia/);
    for (const removed of ["products", "jsonLd", "logos", "hasLoginForm"]) {
      assert.equal(metadata[removed], undefined, removed);
    }

    assert.deepEqual(metadata.blocked, []);
    assert.equal(metadata.botProtection, null);
    assert.equal(typeof metadata.timings.navigationMs, "number");
    assert.ok(metadata.timings.totalMs >= metadata.timings.navigationMs);

    const pixel = await jpegPixel(screenshot, 0, 0);
    assert.equal(pixel.width, 1440);
    assert.equal(pixel.height, 900);
  });

  test("logos: inline SVG, hidden variant, CSS mask, ::before background, sprite, data URL", async () => {
    const {metadata} = await inspect({url: `${base}/logos.html`});
    const images = metadata.images;
    // An inline image is rendered by Fury into a PNG file
    const pngOf = (image) => {
      assert.equal(image.url, null);
      assert.equal(image.rendered, true);
      assert.equal(image.format, "png");
      assert.match(image.file, /-image-\d+\.png$/);
      return `data:image/png;base64,${fs.readFileSync(path.join(saveDir, image.file)).toString("base64")}`;
    };

    // Inline SVG wordmark: white on the black header, rendered to a PNG (at least 2x, longest side <= 512); color is
    // the dominant color of the rendering
    const wordmark = images[0];
    assert.deepEqual({...wordmark, file: undefined, bytes: undefined, x: undefined, y: undefined}, {
      url: null, file: undefined, bytes: undefined, rendered: true, source: "svg", format: "png", alt: "Shop Logo",
      width: 261, height: 73, naturalWidth: null, naturalHeight: null, x: undefined, y: undefined, shape: "landscape",
      area: "header", visible: true, hints: ["logo", "links-home", "header", "above-fold"], link: `${base}/`,
      color: "#ffffff", background: "#000000"
    });
    assert.equal(wordmark.x, 8);
    assert.ok(wordmark.y >= 8 && wordmark.y <= 12, String(wordmark.y));
    const wordmarkPixel = await dataUrlPixel(pngOf(wordmark), 100, 30);
    assert.equal(wordmarkPixel.width, 512);
    assert.deepEqual([wordmarkPixel.r, wordmarkPixel.g, wordmarkPixel.b, wordmarkPixel.a], [255, 255, 255, 255]);

    // Hidden square variant: intrinsic size, rendered with the inherited currentColor
    const square = images.find((image) => image.source === "svg" && image.visible === false);
    assert.equal(square.width, 124);
    assert.equal(square.shape, "square");
    assert.equal(square.color, "#ffffff");
    assert.ok(square.hints.includes("logo") && square.hints.includes("links-home") && square.hints.includes("header"));
    const squarePixel = await dataUrlPixel(pngOf(square), 124, 124);
    assert.deepEqual([squarePixel.r, squarePixel.g, squarePixel.b, squarePixel.a], [255, 255, 255, 255]);
    const cornerPixel = await dataUrlPixel(pngOf(square), 0, 0);
    assert.equal(cornerPixel.a, 0, "transparent background");

    // CSS mask in a link to a language start page: URL, the paint color and the background behind it; the hidden
    // duplicate is not listed
    const masks = images.filter((image) => image.source === "css-mask");
    assert.equal(masks.length, 1);
    assert.deepEqual({...masks[0], file: undefined, bytes: undefined, x: undefined, y: undefined}, {
      url: `${base}/mask-logo.svg`, file: undefined, bytes: undefined, rendered: false, source: "css-mask", format: "svg",
      alt: "Mask Shop Zustellung", width: 67, height: 23, naturalWidth: null, naturalHeight: null, x: undefined, y: undefined,
      shape: "landscape", area: "other", visible: true, hints: ["links-home", "header", "above-fold"], link: `${base}/de-de`,
      color: "#d40000", background: "#ffffff"
    });
    // The mask file as the page loaded it (only the shape; paint it in `color`)
    assert.deepEqual(fs.readFileSync(path.join(saveDir, masks[0].file)), fs.readFileSync(path.join(__dirname, "fixtures", "mask-logo.svg")));

    // ::before background image of a home link
    assert.ok(images.some((image) => image.source === "css-background" && image.url === `${base}/logo.svg` && image.hints.includes("logo")));

    // <use> of a sprite symbol outside the svg, painted in currentColor
    const sprite = images.find((image) => image.source === "svg" && image.color === "#123456");
    const spritePixel = await dataUrlPixel(pngOf(sprite), sprite.width, sprite.height);
    assert.deepEqual([spritePixel.r, spritePixel.g, spritePixel.b], [0x12, 0x34, 0x56]);

    // data: URL image in a home link
    const dataImage = images.find((image) => image.alt === "Data logo");
    assert.equal(dataImage.source, "img");
    assert.deepEqual([dataImage.naturalWidth, dataImage.naturalHeight], [4, 4]);
    const dataPixel = await dataUrlPixel(pngOf(dataImage), 10, 10);
    assert.deepEqual([dataPixel.r, dataPixel.g, dataPixel.b], [0x1f, 0x4e, 0x5f]);

    // The cart icon is no candidate; a partner logo in the footer ranks below the header logos
    assert.equal(images.some((image) => image.source === "svg" && image.width === 24), false);
    const partner = images.findIndex((image) => image.alt === "Payment partner logo");
    assert.ok(partner > images.indexOf(masks[0]));
    assert.deepEqual(images[partner].hints.filter((hint) => hint !== "above-fold"), ["logo"]);
  });

  test("colors per region without semantic elements (found by name), backgrounds by area", async () => {
    const {metadata} = await inspect({url: `${base}/regions.html`});
    const {header, content, footer} = metadata.colors;

    assert.equal(header.source, "name");
    assert.deepEqual(header.bounds, {x: 0, y: 0, width: 1440, height: 100});
    assert.equal(header.background, "#000000");
    assert.deepEqual(header.backgrounds, [{color: "#000000", share: 0.7}, {color: "#d40000", share: 0.3}]);
    assert.equal(header.text, "#ffffff");
    assert.deepEqual(header.links, ["#ffffff", "#ffd700"]);

    // Content: the body without header and footer; only the painted carousel slide and no fixed overlay count
    assert.equal(content.source, "body");
    assert.equal(content.bounds.y, 100);
    assert.equal(content.bounds.y + content.bounds.height, footer.bounds.y);
    assert.equal(content.background, "#ffffff");
    assert.equal(content.backgrounds[0].color, "#ffffff");
    const contentColors = content.backgrounds.map((entry) => entry.color);
    assert.ok(contentColors.includes("#00aa00"), JSON.stringify(content.backgrounds));
    assert.ok(!contentColors.includes("#ff00ff") && !contentColors.includes("#123456"), JSON.stringify(content.backgrounds));
    assert.equal(content.text, "#222222");
    assert.equal(content.headings, "#0a3d62");
    assert.deepEqual(content.buttons, [{background: "#0a3d62", text: "#ffffff", label: "Jetzt kaufen"}]);

    assert.equal(footer.source, "name");
    assert.equal(footer.background, "#333333");
    assert.deepEqual(footer.backgrounds, [{color: "#333333", share: 1}]);
    assert.equal(footer.text, "#eeeeee");
    assert.equal(footer.headings, null);
  });

  test("full height: a page scrolling inside an element is expanded for the screenshot", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/inner-scroll.html`});
    assert.equal(metadata.screenshot.scrollContainer, true);
    assert.equal(metadata.screenshot.pageHeight, 3000);
    assert.equal(metadata.screenshot.height, 3000);
    assert.equal(metadata.screenshot.truncated, false);

    const pixel = await jpegPixel(screenshot, 100, 2750);
    assert.equal(pixel.height, 3000);
    assert.ok(pixel.b > 200 && pixel.r < 50 && pixel.g < 50, JSON.stringify(pixel));
  });

  test("full height: a page scrolling in body below a clipped html is expanded", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/body-scroll.html`});
    assert.equal(metadata.screenshot.scrollContainer, true);
    assert.equal(metadata.screenshot.pageHeight, 3000);
    assert.equal(metadata.screenshot.height, 3000);

    const pixel = await jpegPixel(screenshot, 100, 2750);
    assert.ok(pixel.b > 200 && pixel.r < 50 && pixel.g < 50, JSON.stringify(pixel));
  });

  test("full height: an endless page is cut at maxHeight", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/endless.html`, maxHeight: 3000});
    assert.equal(metadata.screenshot.height, 3000);
    assert.equal(metadata.screenshot.truncated, true);
    assert.ok(metadata.screenshot.pageHeight > 3000);
    assert.equal(metadata.screenshot.scrollContainer, false);
    assert.equal((await jpegPixel(screenshot, 0, 0)).height, 3000);
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

  test("a bot protection challenge is reported (informational)", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/px-challenge`});
    assert.equal(metadata.status, 403);
    assert.equal(metadata.botProtection.vendor, "perimeterx");
    assert.equal(metadata.botProtection.challenge, true);
    assert.ok(metadata.botProtection.signals.includes("#px-captcha"));
    assert.ok(metadata.botProtection.signals.includes("status 403"));
    assert.ok(screenshot.length > 100, "screenshot and metadata are still returned");
  });

  test("the browser presents itself like a regular Chrome", async () => {
    const {metadata} = await inspect({url: `${base}/headers`});
    assert.doesNotMatch(metadata.text, /Headless/);
    assert.match(metadata.text, /user-agent=Mozilla\/5\.0 .*Chrome\/\d+/);
    assert.match(metadata.text, /sec-ch-ua=.*"Google Chrome";v="\d+"/);
    // Chrome generates the q-values from the language list
    assert.match(metadata.text, /accept-language=de-DE,de;q=0\.9,en;q=0\.8/);
    assert.match(metadata.text, /webdriver=false/);
    assert.match(metadata.text, /languages=de-DE,de,en/);
    assert.match(metadata.text, /brands=.*Google Chrome/);
  });

  test("acceptLanguage changes header and navigator.languages together", async () => {
    const {metadata} = await inspect({url: `${base}/headers`, acceptLanguage: "en-US,en"});
    assert.match(metadata.text, /accept-language=en-US,en;q=0\.9/);
    assert.match(metadata.text, /languages=en-US,en/);
  });

  test("redirects are listed", async () => {
    const {metadata} = await inspect({url: `${base}/redirect`});
    assert.equal(metadata.status, 200);
    assert.equal(metadata.finalUrl, `${base}/simple.html`);
    assert.deepEqual(metadata.redirects, [`${base}/redirect`, `${base}/simple.html`]);
  });

  test("images of the structured data: loaded, with where they are declared, without AVIF", async () => {
    fixture.productImageAccepts.length = 0;
    const {metadata} = await inspect({url: `${base}/product.html`});
    const declared = metadata.images.filter((image) => image.source === "structured-data");
    const byUrl = Object.fromEntries(declared.map((image) => [image.url.replace(base, ""), image]));

    assert.deepEqual(Object.keys(byUrl).sort(), ["/products/black-1.png", "/products/black-2.png", "/products/blue-1.png",
      "/products/cap-red.png", "/products/group.png"]);
    for (const image of declared) {
      assert.ok(image.file, `${image.url} has a file`);
      assert.equal(image.format, "png");
      assert.ok(fs.existsSync(path.join(saveDir, image.file)));
    }

    const group = {type: ["ProductGroup"], properties: {name: "Fjord Hoodie", productGroupID: "FH-1", url: "/product.html"}};
    assert.deepEqual(byUrl["/products/group.png"].declaredIn, {format: "json-ld", path: "jsonLd[0].image", index: 0, node: group, parent: null});
    assert.deepEqual(byUrl["/products/black-2.png"].declaredIn, {
      format: "json-ld", path: "jsonLd[0].hasVariant[0].image", index: 1, parent: group,
      node: {type: ["Product"], properties: {name: "Fjord Hoodie Schwarz", sku: "FH-1-BLK", color: "Schwarz",
        url: "/product.html?variant=blk"}}
    });
    assert.equal(byUrl["/products/blue-1.png"].declaredIn.node.properties.color, "Fjordblau");
    assert.deepEqual(byUrl["/products/cap-red.png"].declaredIn,
      {format: "microdata", path: "microdata[0].image", index: 0, parent: null,
        node: {type: ["https://schema.org/Product"], properties: {name: "Fjord Cap", color: "Rot"}}});

    assert.ok(fixture.productImageAccepts.length >= 5);
    for (const accept of fixture.productImageAccepts) {
      assert.doesNotMatch(accept, /avif/);
    }
  });

  test("page scripts cannot tamper with the extraction (isolated world)", async () => {
    const {metadata, screenshot} = await inspect({url: `${base}/tamper.html`});
    assert.equal(metadata.extractError, undefined);
    assert.equal(metadata.title, "Tampered page");
    assert.equal(metadata.finalUrl, `${base}/tamper.html`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.headings, [{level: 1, text: "Page scripts try to tamper with the extraction"}]);
    assert.deepEqual(metadata.links, [{url: `${base}/elsewhere`, text: "Elsewhere", area: "other", sameSite: true}]);
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

  test("images inline: data.images maps metadata.images[].file to the bytes (base64 / msgpack binary)", async () => {
    const url = `http://127.0.0.1:${fixture.port}/shop.html`;
    const logoFile = fs.readFileSync(path.join(__dirname, "fixtures", "logo.svg"));

    const {body} = await post(fury.port, "/inspect", {url});
    const logo = body.data.metadata.images[0];
    assert.match(logo.file, /^image-\d+\.svg$/);
    assert.deepEqual(Buffer.from(body.data.images[logo.file], "base64"), logoFile);
    assert.deepEqual(Object.keys(body.data.images).sort(), body.data.metadata.images.map((image) => image.file).filter(Boolean)
      .filter((file, index, all) => all.indexOf(file) === index).sort());

    const {body: packed} = await post(fury.port, "/inspect", {url}, {msgpack: true});
    const packedLogo = packed.data.metadata.images[0];
    assert.deepEqual(Buffer.from(packed.data.images[packedLogo.file]), logoFile);
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
