# Fury Rendering Server

Fury is a Node.js wrapper for the [Puppeteer](https://github.com/puppeteer/puppeteer) `screenshot` and `pdf` function.

You can `POST` to `/screenshot` or `/pdf` to create either a screenshot or generate a pdf from a given URL.
`/inspect` returns a screenshot and structured metadata of any public website, see [Inspect a website](#inspect-a-website).
All parameters have to be sent in the `POST` body and they have to be in JSON syntax.

Unless `renderEventName` isn't set, Fury will wait for the screenshot or pdf creation until no network request is
made for at least 500 milliseconds.

All given parameters will be forwarded to the target page via the `FURY_PARAMS` object in the `window` object of the browser.

## Environment Settings
There are several environment variables which Fury is using:
- `DEBUG`: If `DEBUG=1`, Fury will open the browser not in headless mode and open the development tools in each browser. `/inspect` additionally prints the console output of the page and its result (the metadata, the screenshot size, the written files or the error) to the console.
- `CONCURRENT_LIMIT`: Defines the amount of max. concurrent rendering processes. Default is one concurrent rendering.
- `TIMEOUT`: Defines the timeout for all requests in milliseconds. Default: 30000 (30 seconds)
- `PROTOCOL_TIMEOUT`: Defines the protocolTimeout for puppeteer in milliseconds. Default: 300000 (5 minutes)
- `FURY_SAVE_DIR`: If set, results are written to this directory and the response contains the file name(s) instead of the data.
- `FURY_ENDPOINTS`: Which endpoints this instance serves, comma separated. `render` (default): `/screenshot`, `/pdf`, `/file`. `inspect`: [`/inspect`](#inspect-a-website). `render,inspect`: both. Endpoints which are not enabled answer 404 and their browser is not started.
- `CONCURRENT_LIMIT_INSPECT`: Max. concurrent `/inspect` requests. Default: 2. Up to five times as many requests wait in a queue, further requests are answered with `busy` right away.
- `FURY_SAVE_DIR_MAX_AGE`: Age in seconds after which result files of `/inspect` in `FURY_SAVE_DIR` are deleted (checked on every `/inspect`, other files are not touched). Default: 3600.
- `FURY_INSPECT_ALLOW_PRIVATE`: **For development and tests only, never in production.** `1` allows `/inspect` to reach non-public addresses and every port; a comma separated list of `host:port` entries (e.g. `127.0.0.1:8080`) exempts exactly these. Fury logs a warning at start when it is set.

## Request
### Take a screenshot
`/screenshot`

#### Available Parameters
- `url` (**Required**): The URL to the target page for the screenshot
- `width`: Width in pixel of the resulting image. Default: 1920.
- `height`: Height in pixel of the resulting image. Default: 1080.
- `cookies`: Cookies which will be set before taking the screenshot. You can find a detailed explanation below.
- `renderEventName`: The RenderFunctionName. You can find a detailed explanation below.

#### Example
```shell script
curl --location --request POST 'http://localhost:3000/screenshot' \
--header 'Content-Type: application/json' \
--data-raw '{
    "url": "https://google.com",
    "width": 800,
    "height": 800,
    "timeout": 60000,
    "cookies": {
        "cookie1": "value1"
    }
}'
```

This request will set the cookie named `cookie` with `value1` and take a screenshot from `https://google.com` with dimensions of 800px x 800px.
The `POST` will fail if the page doesn't respond after 60 seconds.

---

## Create a PDF
`/pdf`
Creates a PDF of the given page by simulating a printout.

#### Available Parameters
- `url` (**Required**): The URL to the target page for the screenshot
- `width`: Width of the page. If `format` is defined, this will be ignored. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `height`: Height of the page. If `format` is defined, this will be ignored. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `format`: Format of the page. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `cookies`: Cookies which will be set before taking the screenshot. You can find a detailed explanation below.
- `renderEventName`: The RenderFunctionName. You can find a detailed explanation below.
- `renderEventNameTimeout`: The timeout in milliseconds for waiting to call `renderEventName`. If not specified, the default Timeout of the Fury Application will be used. Must be smaller than the global Request Timeout
- `printBackground`: Include background media in the pdf ? This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `landscape`: Is the page landscape orientated ? Only works, if `format` is provided. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `margin`: Margin for the printout. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).

#### Example
```shell script
curl --location --request POST 'http://localhost:3000/pdf' \
--header 'Content-Type: application/json' \
--data-raw '{
    "url": "https://google.com",
    "format": "A4",
    "printBackground":  true,
    "landscape": true,
    "cookies": {
        "cookie1": "value1"
    }
}
```

This request will create a pdf by simulating a printout of `https://google.com`. The page size in the pdf is `A4` in landscape mode. Additionally, Fury will set the cookie `cookie1` with the value `value`.

---

## Defining Required Cookies
Both methods supports the `cookies` parameter to define some required cookies to process the page.
This can be used for example to take a screenshot of a page which requires a login cookie.

The syntax is pretty straight forward. You define the cookies in JSON syntax, where the key represents the cookie name and the value is the value of the cookie.
Syntax: 
   ```json
  {
    "cookiename1": "cookievalue1",
    "cookiename2": "cookievalue2"
  } 
  ```

## RenderEventName
If the target page have to do some work before the page is ready for the screenshot, you can define with the `renderEventName` parameter a function name for which
Fury will wait. The function name will be exposed to the global `window` object of the browser. After calling the function from the target page, the screenshot or the pdf
will be created unless the `timeout` expires before.

## Page errors
A page can provide an error message which will be considered after page navigation.
To provide an error message, just create a `<div class="furyError">` on the page and fill it with the error message if you don't want to print the page.

If this div exists and has a content, the content of the div will be returned as `error`.

## Response
After processing the target page, Fury will send a response in JSON syntax:
```json
{
  "data": "",
  "error": ""
}
```

`data`: The image or pdf encoded via base64 or null, if an error occured.

`error`: If an error occured, this will contain the error message and call stack of the error. Otherwise null.

### MessagePack
If the HTTP request has the string `msgpack` in the HTTP `Accept:` header, Fury will return the same response as a [MessagePack](https://msgpack.org/) map. Because MessagePack allows binary data, this is more efficient because the data doesn't have to be encoded to base64 and it allows to return larger files.

---

## Inspect a website
`/inspect` (only with `FURY_ENDPOINTS` containing `inspect`)

Opens any URL of the public web in an isolated browser and returns **what the page looks like** (a JPEG screenshot)
and **what is on it** (structured metadata: links, text, headings, images, forms, structured data, colors, fonts, ...).
Fury describes the page as it is and does not interpret it for a specific kind of site: a shop, a blog or a company
page all return the same fields.
Typical uses are crawlers, link previews, site analysis or AI agents which browse the web page by page.

The URL comes from whoever calls the service, so `/inspect` treats every page as hostile and refuses to reach anything
that is not on the public internet, see [Security model](#security-model). It is a separate endpoint with its own
browser: `/screenshot`, `/pdf` and `/file` are not affected and keep loading any URL, including `localhost`.

Unlike the other endpoints, `/inspect` does not support `cookies` or `renderEventName` and does not expose
`FURY_PARAMS` to the page, so no data of the caller is passed on to the visited site.

#### Available Parameters
| Parameter | Default | Meaning |
|---|---|---|
| `url` (**Required**) | | Absolute `http(s)` URL, without credentials |
| `width`, `height` | 1440, 900 | Viewport (320-3840 x 320-2160), `deviceScaleFactor` 1 |
| `fullPage` | `true` | Screenshot of the whole page height, capped at `maxHeight`. Pages whose content scrolls inside an element instead of the document are expanded to their full height first |
| `maxHeight` | 10000 | Cap of a full-page screenshot in px (clipped, not scaled; max. 16000). Endless scrolling pages are cut here |
| `quality` | 70 | JPEG quality (1-100) |
| `scroll` | `true` | Scroll down in viewport steps before the screenshot (lazy images, infinite lists), at most `maxHeight` px and 3 s, then back to the top |
| `timeout` | 20000 | Max. ms for navigation plus waiting for a quiet network. Reduced to `TIMEOUT - 8000` if higher |
| `maxLinks` | 200 | Cap of `links` (max. 1000) |
| `maxText` | 20000 | Cap of `text` in characters (max. 200000) |
| `acceptLanguage` | `de-DE,de,en` | Languages of the visitor, comma separated. Chrome generates the `Accept-Language` header from it (with q-values, e.g. `de-DE,de;q=0.9,en;q=0.8`) and `navigator.languages` matches it. q-values in the parameter are ignored |

Numbers outside the allowed range are clamped, not rejected.

#### Behaviour
1. Every request gets a fresh incognito browser context (no cookies or storage from earlier requests) with its own
   proxy (see [Security model](#security-model)). Invalid TLS certificates are accepted, like for the other endpoints.
   The browser presents itself like a regular Chrome, see [Bot protection](#bot-protection).
2. Fury navigates until `domcontentloaded`, then waits until there are no more than 2 open connections for 500 ms, at
   most until `timeout`. A page which never becomes idle (analytics, chat widgets) is not an error: Fury takes what
   is there. Content rendered client side by then is included.
3. Optional scrolling, 300 ms to settle, screenshot, metadata extraction.
4. Fury does not interact with the page. Cookie/consent banners are not dismissed, so the screenshot may show one;
   links, text and metadata are extracted anyway.
5. Dialogs (`alert`/`confirm`) are dismissed, popups closed, downloads denied, service workers bypassed and permission
   prompts denied.
6. The whole request, including the time waiting for a free slot, is limited by `TIMEOUT`.

#### Example
```shell script
npm install
npx puppeteer browsers install chrome   # once, npm >= 11 does not run puppeteer's install script
mkdir -p /tmp/fury
FURY_ENDPOINTS=render,inspect FURY_SAVE_DIR=/tmp/fury PORT=3100 DEBUG=1 node server.js
curl -s localhost:3100/inspect -H 'Content-Type: application/json' -d '{"url":"https://www.example.com"}'
```

#### Response
Without `FURY_SAVE_DIR`, the result is returned inline, the screenshot base64 encoded (binary with
[MessagePack](#messagepack)):
```json
{"data": {"metadata": {...}, "screenshot": "/9j/4AAQ...", "images": {"image-1.svg": "PHN2Zy...", "image-2.png": "iVBORw0..."}}, "error": null}
```
`images` maps `metadata.images[].file` to the image bytes (base64; binary with MessagePack).

With `FURY_SAVE_DIR`, Fury writes the files and only returns their names. This avoids sending the images over HTTP when
the caller can read the directory (e.g. a shared volume):
```json
{"file": "<id>.json", "screenshot": "<id>.jpg", "images": ["<id>-image-1.svg", "<id>-image-2.png"], "error": null}
```
- `<id>.jpg`: the screenshot
- `<id>-image-<n>.<ext>`: the images of the page, referenced by `metadata.images[].file`
- `<id>.json`: the metadata (UTF-8), written last: when it exists, all files it names exist too

`<id>` is a random UUID. The files are written under a temporary name and renamed, so they are complete when the
response arrives. The caller is expected to delete them after reading (`images` lists the image files); as a safety net,
Fury deletes `/inspect` files older than `FURY_SAVE_DIR_MAX_AGE` (other files in the directory are never touched).

#### Metadata
```json
{
  "requestedUrl": "https://shop.example.com",
  "finalUrl": "https://shop.example.com/en/",
  "status": 200,
  "redirects": ["https://shop.example.com/", "https://shop.example.com/en/"],
  "title": "...",
  "lang": "en",
  "meta": {"description": "...", "themeColor": "#1f4e5f", "canonical": "https://..."},
  "alternates": [{"hreflang": "de", "url": "https://..."}],
  "headings": [{"level": 1, "text": "..."}],
  "links": [{"url": "https://...", "text": "Women", "area": "nav|header|footer|main|other", "sameSite": true}],
  "text": "visible text of the page (innerText of main, else body), whitespace collapsed",
  "images": [
    {"url": null, "file": "image-1.png", "bytes": 5120, "rendered": true, "source": "svg", "format": "png",
     "alt": "Shop Logo", "width": 261, "height": 73, "naturalWidth": null, "naturalHeight": null, "x": 24, "y": 12,
     "shape": "landscape", "area": "header", "visible": true, "hints": ["logo", "links-home", "header", "above-fold"],
     "link": "https://shop.example.com/", "color": "#ffffff", "background": "#000000"},
    {"url": "https://.../logo-mask.svg", "file": "image-2.svg", "bytes": 2048, "rendered": false, "source": "css-mask",
     "format": "svg", "alt": "Shop home", "width": 67, "height": 23, "naturalWidth": null, "naturalHeight": null,
     "x": 686, "y": 20, "shape": "landscape", "area": "header", "visible": true, "hints": ["links-home", "header", "above-fold"],
     "link": "https://shop.example.com/de-de", "color": "#000000", "background": "#ffffff"},
    {"url": "https://.../p/boot.jpg", "file": "image-3.jpg", "bytes": 48213, "rendered": false, "source": "img",
     "format": "jpeg", "alt": "Fjord Boot", "width": 300, "height": 300, "naturalWidth": 800, "naturalHeight": 800,
     "x": 40, "y": 620, "shape": "square", "area": "main", "visible": true, "hints": [],
     "link": "https://shop.example.com/p/fjord-boot", "color": null, "background": "#ffffff"},
    {"url": "https://.../apple-touch-icon.png", "file": "image-4.png", "bytes": 3311, "rendered": false,
     "source": "apple-touch-icon", "format": "png", "alt": "", "width": 180, "height": 180, "naturalWidth": null,
     "naturalHeight": null, "x": null, "y": null, "shape": "square", "area": null, "visible": null, "hints": [],
     "link": null, "color": null, "background": null}
  ],
  "forms": [
    {"action": "https://.../login", "method": "post", "area": "main", "submit": "Sign in",
     "fields": [{"type": "email", "name": "email", "label": "E-Mail", "required": true}, {"type": "password", "name": "password", "label": "Password", "required": true}]}
  ],
  "structuredData": {
    "jsonLd": [{"@type": "Organization", "name": "..."}],
    "microdata": [{"type": "https://schema.org/Product", "properties": {"name": "...", "offers": {"type": "https://schema.org/Offer", "properties": {"price": "149.90"}}}}],
    "openGraph": {"og:site_name": "...", "og:type": "website", "og:image": "https://..."},
    "twitter": {"twitter:card": "summary_large_image"}
  },
  "colors": {
    "page": {"background": "#f7f5f0", "text": "#1b1d1e"},
    "header": {
      "source": "semantic", "bounds": {"x": 0, "y": 0, "width": 1440, "height": 100},
      "background": "#000000", "backgrounds": [{"color": "#000000", "share": 0.7}, {"color": "#d40000", "share": 0.3}],
      "text": "#ffffff", "texts": [{"color": "#ffffff", "share": 0.82}, {"color": "#ffd700", "share": 0.18}],
      "headings": null, "links": ["#ffffff", "#ffd700"], "buttons": []
    },
    "content": {
      "source": "semantic", "bounds": {"x": 0, "y": 100, "width": 1440, "height": 2400},
      "background": "#f7f5f0", "backgrounds": [{"color": "#f7f5f0", "share": 0.91}, {"color": "#1f4e5f", "share": 0.06}],
      "text": "#1b1d1e", "texts": [{"color": "#1b1d1e", "share": 0.74}, {"color": "#2a6f97", "share": 0.2}],
      "headings": "#1b1d1e", "links": ["#2a6f97"],
      "buttons": [{"background": "#1f4e5f", "text": "#ffffff", "label": "Add to cart"}]
    },
    "footer": {
      "source": "semantic", "bounds": {"x": 0, "y": 2500, "width": 1440, "height": 320},
      "background": "#1f4e5f", "backgrounds": [{"color": "#1f4e5f", "share": 1}],
      "text": "#ffffff", "texts": [{"color": "#ffffff", "share": 1}], "headings": "#ffffff", "links": ["#ffffff"], "buttons": []
    },
    "links": ["#2a6f97"],
    "buttons": [{"background": "#1f4e5f", "text": "#ffffff", "label": "Add to cart"}],
    "variables": {"--color-primary": "#1f4e5f"}
  },
  "fonts": {"body": "Source Sans 3, sans-serif", "headings": "..."},
  "botProtection": null,
  "screenshot": {"width": 1440, "height": 10000, "pageHeight": 23400, "truncated": true, "scrollContainer": false},
  "blocked": ["http://169.254.169.254/latest/meta-data/ (private address)"],
  "timings": {"navigationMs": 1830, "totalMs": 4120}
}
```
- `status`: HTTP status of the main document. A status >= 400 is not an error: you get the metadata and screenshot of
  the error page.
- `redirects`: the redirect chain of the main document including the final URL, empty without redirects.
- All URLs are absolute, without `#fragment`. `links` are deduplicated by URL in document order, only `http(s)`; the
  `text` is trimmed to 100 characters (falls back to `aria-label`/`title`/`alt` of an image inside); `area` comes from the
  closest `nav`/`header`/`footer`/`main` (or ARIA role); `sameSite` = same registrable domain as `finalUrl` (last two
  labels, three for `co.uk`-like second levels).
- `colors` are **computed** styles as `#rrggbb` (any CSS color syntax; alpha < 0.5 counts as transparent, transparent
  backgrounds resolve to the first opaque ancestor).
  - `page`: background and text color of `body`.
  - `header`, `content`, `footer`: the colors of each page region, `null` if the region was not found.
    - `source`: how the region was found. `semantic`: `<header>`/`[role=banner]`, `<main>`/`[role=main]`,
      `<footer>`/`[role=contentinfo]` (a header or footer inside `article`/`aside`/`main` belongs to that, not to the
      page). `name`: an element whose id or class contains "header"/"footer" and that spans at least 80% of the
      page width (header: at most 600 px high, starting in the top 200 px). `body` (content only): no `<main>`, the
      body without header and footer.
    - `bounds`: position and size in page coordinates (CSS px), including content overflowing the element; for
      `source: "body"` the span between header and footer.
    - `background`: the background color behind the region (first opaque ancestor).
    - `backgrounds`: up to 5 background colors **by painted area** within the region, with their `share` (0..1,
      at least 0.01). Only what is really painted counts: content clipped by an `overflow: hidden` ancestor (hidden
      carousel slides) and fixed overlays are left out. A black header with a red top bar is
      `[{"color": "#000000", "share": 0.7}, {"color": "#d40000",
      "share": 0.3}]`. Background images and gradients are not counted (their area goes to the color below).
    - `text`: the dominant text color (by number of characters of visible text); `texts`: up to 3 with their share.
    - `headings`: the dominant color of `h1`-`h6`, `null` without headings.
    - `links`: up to 3 colors of visible text links, the most frequent first.
    - `buttons`: up to 5 visible buttons/button-like links of the region, the largest first.
  - `links`: the link colors of `content` (`main`, otherwise the page without header and footer); `buttons`: page
    wide, up to 8, the largest first.
  - `variables`: up to 30 custom properties on `:root` whose value is a color, names like `primary`/`brand`/`color`
    first.
- `images`: up to 120, and **the images themselves** as files (see [Response](#response)): no need to download
  anything (a second download would also run into the bot protection). First the page images (up to 100, at least
  16x16 px): every visible `<img>`, CSS background images on the page, and the logo candidates found inside links to
  the start page and inside elements named like a logo (also inline SVG, CSS masks and hidden responsive variants,
  e.g. a square logo shown only on mobile). Ordered by the hints (logo candidates first), then by size. Then the
  images the page declares (icons, sharing images).
  - `url`: absolute `http(s)` URL of the image, `null` for an inline image (inline `<svg>`, `data:` URL).
  - `file`: the image file (with `FURY_SAVE_DIR` the file name in the directory, otherwise the key in `data.images`),
    `null` if Fury has no bytes for it (failed to load, not an image, over the byte limits). Several entries with the
    same URL share one file. `bytes`: its size.
  - The files are **exactly what the site served** (the browser's own responses; images the page did not load itself,
    like `apple-touch-icon`, `og:image` or a hidden variant, are loaded through the page afterwards). Only real image
    formats are stored: the type is detected from the content, not from the server's `Content-Type`.
  - `rendered: true`: the file is Fury's PNG rendering of an inline logo candidate (transparent background, at least
    twice the CSS size, longest side at most 512 px).
  - `source`: where the image comes from: `img`, `svg` (inline SVG), `css-background`, `css-mask`, `object`
    (`<object>`/`<embed>`), or for declared images `icon`, `apple-touch-icon`, `mask-icon`, `og:image`,
    `twitter:image`.
  - `format`: format of the `file` (detected from its content): `svg`, `png`, `jpeg`, `gif`, `webp`, `avif`, `ico`,
    `bmp`; without a file the format guessed from the URL, or `null`. **SVG files are the site's original and may
    contain scripts**: rasterize or sanitize them before serving them from your own domain.
  - **`css-mask`** and **`mask-icon`**: the image is only a shape. The site paints it in `color`, so render it as a
    mask filled with `color`.
  - `alt`: `alt`, `aria-label`, `title` (or an SVG `<title>`), otherwise the label or text of the surrounding link.
  - `width`/`height`: rendered size in CSS px; for hidden images the intrinsic size (`width`/`height` attributes,
    `viewBox`, natural size); for declared images their `sizes`, otherwise `null`. `naturalWidth`/`naturalHeight`:
    pixel size of an `<img>`'s image, otherwise `null`. `shape`: `landscape` (ratio >= 1.3), `portrait` (<= 0.77),
    `square` (in between) or `null`.
  - `x`/`y`: top left corner in page coordinates (CSS px, top left of the page is 0/0), `null` if not visible.
  - `area`: page region like for links (`null` for declared images). `visible`: shown in the inspected viewport
    (`false` for hidden variants, `null` for declared images). `link`: URL of the surrounding link (e.g. a product
    page), otherwise `null`.
  - `hints` are observations, not conclusions: `logo` (the element or a close ancestor up to the link mentions
    "logo", "wordmark" or "signet" in a name, label, `data-*` attribute or file name, or "brand" as a class/id part
    like `navbar-brand`), `links-home` (inside a link to the start page, also a language start page like `/de-de`),
    `header` (inside `header`/`[role=banner]` or in the top 200 px), `above-fold` (visible without scrolling).
  - `color`: the color the image is painted in: the fill color of a `css-mask` or `mask-icon`, and for a `rendered`
    image the dominant color of the rendering; otherwise `null`. `background`: the background color behind the image on the page (first opaque ancestor),
    `null` for declared images. A white logo on a black header has `"color": "#ffffff", "background": "#000000"`:
    show it on a dark background.
- `forms`: up to 10 forms with visible fields. `action` is absolute (a form without `action` submits to the page
  itself), `method` lower case. `fields`: up to 20 visible fields (no hidden fields, buttons or values), `type` is the
  input type or `select`/`textarea`, `label` from `<label>`, `aria-label`, `placeholder` or `title`. `submit`: label of
  the first visible submit button. Visible fields outside of any `<form>` (common in client side rendered pages) are
  collected in one extra entry with `action`, `method` and `area` set to `null`. Example: a login page has a form
  with a `password` field.
- `structuredData`: what the page declares for machines, as it is (not interpreted, so products, articles, events,
  recipes, organizations, ... all show up here):
  - `jsonLd`: the parsed `application/ld+json` blocks (invalid ones skipped), up to 10, each shortened to ~5 KB.
  - `microdata`: top-level microdata items (`itemscope`), up to 30, as `{"type", "properties"}`; nested items are
    objects of the same shape, repeated properties become arrays.
  - `openGraph`: all Open Graph tags including their namespaces (`og:`, `product:`, `article:`, ...), up to 50 keys;
    repeated keys (e.g. several `og:image`) become arrays, URLs are absolute.
  - `twitter`: the `twitter:` card tags, the same way.
- `botProtection`: informational, `null` if nothing was recognized. Otherwise
  `{"vendor": "...", "challenge": true|false, "signals": ["..."]}`:
  - `vendor`: `perimeterx`, `cloudflare`, `datadome`, `akamai`, `imperva`, `aws-waf`, `recaptcha`, `hcaptcha` or
    `unknown` (a refused page asking to prove being human, without a known vendor).
  - `challenge: true`: the page **is** a block or CAPTCHA page instead of the requested content (usually together with
    status 403/429/503). Screenshot and metadata show the challenge, not the site.
  - `challenge: false`: the vendor's protection or a CAPTCHA widget is present on an otherwise normal page (e.g. a
    reCAPTCHA in a contact form); the content is real.
  - `signals`: what matched (headers, elements, scripts, status), for debugging.

  See [Bot protection](#bot-protection) for what Fury does and does not do about it.
- `screenshot`: what the screenshot shows. `width`/`height`: its size in px; `pageHeight`: the height of the page (CSS
  px, after scrolling; at least the viewport height); `truncated`: the page is higher than the screenshot (cut at
  `maxHeight`, e.g. an endless page, or `fullPage: false`); `scrollContainer`: the page's content scrolled inside an
  element spanning the viewport (or inside `body`) and was expanded to its full height (the positions in the metadata
  refer to that expanded layout).
- `blocked`: requests Fury refused, with the reason: `private address`, `port`, `scheme`, `media`, `budget`,
  `connection over 10 MB` (up to 50 entries).
- `extractError`: only present if the extraction failed. The screenshot, the fields up to `redirects`, `screenshot`,
  `blocked` and `timings` are still there.
- The whole JSON is kept below ~500 KB (`text`, then `links`, ... are shortened if necessary). The image files count
  towards the byte limits of the page (10 MB per connection, 25 MB per inspect), not towards the JSON.

#### Errors
`{"data": null, "error": "<code>: <message>"}` with one of these codes:

| Code | Meaning |
|---|---|
| `invalid` | Missing or invalid `url` |
| `blocked address` | The URL (or a redirect of it) points to a non-public address or to a port other than 80/443 |
| `dns` | The host name cannot be resolved |
| `connect` | The connection failed |
| `timeout` | No `domcontentloaded` within `timeout`, or the whole request took longer than `TIMEOUT` |
| `busy` | All slots and the queue are full, or no slot became free before `TIMEOUT` |

### Bot protection
Many sites sit behind bot protection (PerimeterX/HUMAN, Cloudflare, DataDome, Akamai, ...) which blocks headless
browsers with a CAPTCHA or an "access denied" page, while a regular Chrome gets through. Fury's `/inspect` browser
therefore **deliberately reduces the signals that mark it as an automated browser**, so that it is not blocked merely
for being headless. It presents itself like the regular Chrome it is built from, without inventing anything:

- the User-Agent and the client hints (`sec-ch-ua*`, `navigator.userAgentData`) say `Chrome`/`Google Chrome` instead
  of `HeadlessChrome`; all other values (version, platform, architecture) are the real ones
- Chrome's automation switches are not set (`--enable-automation` dropped, `AutomationControlled` disabled), so
  `navigator.webdriver` is `false` like in a normal browser
- `Accept-Language` and `navigator.languages` come from the same setting (`acceptLanguage`), so they are consistent
- a window of the viewport size, Chrome's own TLS and HTTP/2 stacks (the proxy only tunnels)

What Fury does **not** do: it does not solve or click through challenges (CAPTCHAs, "press and hold"), it does not
fake fingerprints (WebGL, canvas, fonts, plugins) and it does not hide that it is headless beyond the points above.
Whether a site lets Fury in also depends on things outside Fury: the reputation of the IP address (data center ranges
are often blocked outright), the request rate, and the fact that every `/inspect` starts without cookies, so a site
sees a first-time visitor each time. If a page is a challenge, the metadata says so in `botProtection`.

Whether inspecting a site this way is in line with its terms of service is the responsibility of the operator and the
caller, not something Fury can decide.

### Security model
Fury usually runs inside a private network (a data center, a cloud VPC, a Kubernetes cluster), and the `/inspect`
URL is chosen by the caller, possibly on behalf of untrusted users. Without protection, a page could make the browser
load internal services or the cloud metadata service and leak their content through the screenshot or the metadata
(server-side request forgery). Everything below applies to `/inspect` only.

- **Separate browser.** `/inspect` has its own Chrome, independent of the browser of the other endpoints. Its default
  proxy is a dead address, so nothing reaches the network outside an inspect context.
- **A proxy per request.** Every inspect context sends all its traffic (documents, subresources, workers, WebSockets)
  through a small proxy inside Fury (`src/InspectProxy.js`, on `127.0.0.1`, random port). The proxy resolves the host
  itself, refuses it unless **every** address is public and the port is 80 or 443, and then connects to **exactly the
  checked address**. Chrome never resolves names itself, so DNS rebinding (a second DNS answer pointing to an internal
  address) does not work. Refused are loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, the
  cloud metadata service), CGNAT (100.64/10), 0/8, multicast/reserved and documentation ranges, IPv6 `::1`,
  `fc00::/7`, `fe80::/10`, multicast, IPv4-mapped/compatible/6to4 forms of the above, NAT64 `64:ff9b::/96` and Teredo.
- **Request interception** checks every request of the page with the same rules as well (so `blocked` shows full
  URLs), allows only `http(s)`, `data:` and `blob:`, and aborts `media` (video/audio).
- **Byte limits** (in the proxy): a connection is closed after 10 MB, an inspect stops after 25 MB in total (further
  requests are refused, `blocked` gets a `budget` entry). With HTTP/2 one connection carries all requests to a host, so
  the 10 MB apply per connection rather than per file.
- **Extraction in an isolated world.** The metadata is read in a separate JavaScript world of the page (it shares the
  DOM, not the page's scripts), so a page cannot tamper with the built-ins the extraction uses. Only the known
  metadata keys are taken from it; `requestedUrl`, `finalUrl`, `status`, `redirects`, `blocked` and `timings` are
  always set by Fury. Image files are only stored if their content is a real image format, and Fury's own renderings
  are checked to be PNGs.
- **Further restrictions:** WebRTC is limited to the proxy (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`),
  service workers are bypassed, downloads and permission prompts denied, popups closed, dialogs dismissed.

**Limits:**
- **Chrome runs without its sandbox** (`--no-sandbox`, like for the other endpoints). A renderer exploit on a hostile
  page would run code as the Fury user and could open connections **past the proxy** and read or write
  `FURY_SAVE_DIR`. Keep Chrome up to date: rebuild and redeploy the image regularly to get Chrome security updates.
- **Restrict the network as well (defense in depth).** Block egress from the Fury host or container to private ranges
  and to the metadata service (`169.254.169.254`, `fd00:ec2::254`), except what Fury really needs, e.g. with a
  Kubernetes NetworkPolicy, firewall rules or security groups. Such rules usually cannot block `localhost` inside the
  same host or pod; that part relies on the proxy.
- `FURY_INSPECT_ALLOW_PRIVATE` turns the address checks off (fully or for single `host:port` entries). It is meant for
  development and tests only; never set it in production.

## Tests
```bash
npm test
```
Runs the `node:test` suites in `test/`: unit tests for the address check, the proxy (with real sockets), parameters and
files, and integration tests which start Fury (with puppeteer's Chrome) against local fixture servers.
