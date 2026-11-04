// The metadata extraction of /inspect. `extractPageData` runs inside the page in an isolated world (see
// Inspect.evaluateIsolated): it shares the DOM with the page but not its JavaScript, so page scripts cannot tamper with
// the built-ins it uses. It has to be self-contained (no closures over module scope) and must only return plain JSON
// values.

/* eslint-disable no-undef */
exports.extractPageData = async (options) => {
  const {maxLinks, maxText} = options;
  const MAX_SCAN = 3000;

  const collapse = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const truncate = (value, max) => {
    const text = collapse(value);
    return text.length > max ? text.slice(0, max) : text;
  };

  const absoluteUrl = (value) => {
    if (!value) {
      return null;
    }

    try {
      const url = new URL(String(value).trim(), document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
      url.hash = "";
      return url.href;
    } catch (e) {
      return null;
    }
  };

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    if (el.checkVisibility) {
      return el.checkVisibility({opacityProperty: true, visibilityProperty: true});
    }

    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && parseFloat(style.opacity) > 0;
  };

  // Registrable domain: last two labels, three for "co.uk"-like second levels
  const registrableDomain = (hostname) => {
    const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
    if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) {
      return labels.join(".");
    }
    const secondLevel = labels[labels.length - 2];
    const isGenericSecondLevel = secondLevel.length <= 3 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gv|ltd|plc)$/.test(secondLevel);
    return labels.slice(isGenericSecondLevel ? -3 : -2).join(".");
  };

  // --- Colors -----------------------------------------------------------------------------------------------------
  // Any CSS color (rgb, hsl, oklch, color(), named) is painted on a 1x1 canvas and read back, so every color syntax
  // Chrome supports ends up as #rrggbb. Alpha < 0.5 counts as transparent (null).
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", {willReadFrequently: true});
  const colorCache = new Map();

  const toHex = (value) => {
    if (!value || !context) {
      return null;
    }

    const key = String(value).trim();
    if (colorCache.has(key)) {
      return colorCache.get(key);
    }

    let result = null;
    if (key && key !== "transparent" && CSS.supports("color", key)) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = key;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      if (a >= 128) {
        result = "#" + [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
      }
    }

    colorCache.set(key, result);
    return result;
  };

  // Background of an element, transparent backgrounds resolve to the first opaque ancestor
  const effectiveBackground = (el) => {
    for (let current = el; current && current.nodeType === 1; current = current.parentElement) {
      const color = toHex(getComputedStyle(current).backgroundColor);
      if (color) {
        return color;
      }
    }
    return "#ffffff";
  };

  const colorPair = (el) => (el ? {background: effectiveBackground(el), text: toHex(getComputedStyle(el).color)} : null);

  const firstVisible = (selector, last) => {
    const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);
    return last ? elements[elements.length - 1] : elements[0];
  };

  const main = document.querySelector("main, [role=main]");
  const header = firstVisible("header, [role=banner]");
  const footer = firstVisible("footer, [role=contentinfo]", true);

  const labelOf = (el) => truncate(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "", 60);

  const buttonCandidates = Array.from(document.querySelectorAll(
    "button, input[type=submit], input[type=button], [role=button], a[class*=btn i], a[class*=button i], a[class*=cta i]"
  )).slice(0, MAX_SCAN);

  const buttons = [];
  const seenButtons = new Set();
  buttonCandidates
    .filter(isVisible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {el, area: rect.width * rect.height};
    })
    .sort((a, b) => b.area - a.area)
    .forEach(({el}) => {
      if (buttons.length >= 8) {
        return;
      }
      const entry = {background: effectiveBackground(el), text: toHex(getComputedStyle(el).color), label: labelOf(el)};
      const key = `${entry.background}|${entry.text}|${entry.label}`;
      if (!seenButtons.has(key)) {
        seenButtons.add(key);
        buttons.push(entry);
      }
    });

  const linkColorCounts = new Map();
  Array.from((main || document.body || document.documentElement).querySelectorAll("a[href]"))
    .slice(0, MAX_SCAN)
    .filter((el) => collapse(el.innerText) && isVisible(el))
    .forEach((el) => {
      const color = toHex(getComputedStyle(el).color);
      if (color) {
        linkColorCounts.set(color, (linkColorCounts.get(color) || 0) + 1);
      }
    });

  const PRIORITY_VARIABLE = /color|colour|primary|secondary|accent|brand|theme|bg|background|text|link|button/i;
  const rootStyle = getComputedStyle(document.documentElement);
  const variableNames = new Set();
  for (let i = 0; i < rootStyle.length && i < 5000; i++) {
    if (rootStyle[i].startsWith("--")) {
      variableNames.add(rootStyle[i]);
    }
  }
  // Names from :root/html rules of readable (same origin) stylesheets, in case the computed style does not list them
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      continue;
    }
    for (const rule of Array.from(rules || []).slice(0, MAX_SCAN)) {
      if (rule.style && /(^|,)\s*(:root|html)\s*(,|$)/i.test(rule.selectorText || "")) {
        Array.from(rule.style).filter((name) => name.startsWith("--")).forEach((name) => variableNames.add(name));
      }
    }
  }

  const variableEntries = [];
  for (const name of Array.from(variableNames).slice(0, 5000)) {
    // Computed value, var() references are resolved
    const value = rootStyle.getPropertyValue(name).trim();
    // Only real colors, not channel lists like "255 0 0" or keywords like "inherit"
    if (!value || /^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(value) || !CSS.supports("color", value)) {
      continue;
    }
    const hex = toHex(value);
    if (hex) {
      variableEntries.push([name, hex]);
    }
  }
  variableEntries.sort((a, b) => Number(PRIORITY_VARIABLE.test(b[0])) - Number(PRIORITY_VARIABLE.test(a[0])));

  const colors = {
    page: colorPair(document.body || document.documentElement),
    links: Array.from(linkColorCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([color]) => color),
    buttons,
    header: colorPair(header),
    footer: colorPair(footer),
    variables: Object.fromEntries(variableEntries.slice(0, 30))
  };

  // --- Meta -------------------------------------------------------------------------------------------------------
  const metaContent = (selector) => {
    const el = document.querySelector(selector);
    return el ? collapse(el.getAttribute("content")) || null : null;
  };

  const meta = {
    description: truncate(metaContent("meta[name=description i]") || "", 1000) || null,
    themeColor: toHex(metaContent("meta[name=theme-color i]")),
    canonical: absoluteUrl(document.querySelector("link[rel=canonical i]")?.getAttribute("href"))
  };

  const alternates = [];
  const seenAlternates = new Set();
  document.querySelectorAll("link[rel=alternate i][hreflang]").forEach((el) => {
    const url = absoluteUrl(el.getAttribute("href"));
    const hreflang = collapse(el.getAttribute("hreflang"));
    if (url && hreflang && !seenAlternates.has(hreflang + url) && alternates.length < 50) {
      seenAlternates.add(hreflang + url);
      alternates.push({hreflang, url});
    }
  });

  // --- Page regions -----------------------------------------------------------------------------------------------
  const areaOf = (el) => {
    const container = el.closest("nav, [role=navigation], header, [role=banner], footer, [role=contentinfo], main, [role=main]");
    if (!container) {
      return "other";
    }
    const role = container.getAttribute("role");
    const tag = container.tagName.toLowerCase();
    if (tag === "nav" || role === "navigation") {
      return "nav";
    }
    if (tag === "header" || role === "banner") {
      return "header";
    }
    if (tag === "footer" || role === "contentinfo") {
      return "footer";
    }
    return "main";
  };

  // --- Structured data (declared by the page, not interpreted) ----------------------------------------------------
  // Each block at most ~5 KB: long strings and arrays are shortened step by step
  const shrink = (value, maxString, maxArray, depth) => {
    if (typeof value === "string") {
      return value.length > maxString ? value.slice(0, maxString) + "…" : value;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (depth > 6) {
      return Array.isArray(value) ? [] : {};
    }
    if (Array.isArray(value)) {
      return value.slice(0, maxArray).map((item) => shrink(item, maxString, maxArray, depth + 1));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, maxString, maxArray, depth + 1)]));
  };
  const limitBlock = (block) => {
    for (const [maxString, maxArray] of [[Infinity, Infinity], [500, 10], [150, 5], [60, 2]]) {
      const shrunk = shrink(block, maxString, maxArray, 0);
      if (JSON.stringify(shrunk).length <= 5000) {
        return shrunk;
      }
    }
    const scalars = Object.fromEntries(Object.entries(block && typeof block === "object" && !Array.isArray(block) ? block : {})
      .filter(([, value]) => typeof value !== "object")
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 200) : value]));
    return {...scalars, _truncated: true};
  };

  const jsonLd = [];
  document.querySelectorAll("script[type='application/ld+json' i]").forEach((el) => {
    if (jsonLd.length >= 10) {
      return;
    }
    try {
      jsonLd.push(limitBlock(JSON.parse(el.textContent)));
    } catch (e) {
      // invalid blocks are skipped
    }
  });

  // Microdata (WHATWG): top-level items with their properties, nested items as objects
  const microdataValue = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "meta") {
      return el.getAttribute("content") || "";
    }
    if (["audio", "embed", "iframe", "img", "source", "track", "video"].includes(tag)) {
      return absoluteUrl(el.getAttribute("src")) || el.getAttribute("src") || "";
    }
    if (["a", "area", "link"].includes(tag)) {
      return absoluteUrl(el.getAttribute("href")) || el.getAttribute("href") || "";
    }
    if (tag === "object") {
      return absoluteUrl(el.getAttribute("data")) || "";
    }
    if (tag === "data" || tag === "meter") {
      return el.getAttribute("value") || "";
    }
    if (tag === "time") {
      return el.getAttribute("datetime") || truncate(el.textContent, 500);
    }
    return truncate(el.getAttribute("content") || el.textContent, 500);
  };
  const microdataItem = (item, depth) => {
    const properties = {};
    // Properties of this item: [itemprop] descendants whose nearest item scope is this item
    Array.from(item.querySelectorAll("[itemprop]")).slice(0, 200).forEach((el) => {
      const owner = el.parentElement ? el.parentElement.closest("[itemscope]") : null;
      if (owner !== item) {
        return;
      }
      const value = el.hasAttribute("itemscope")
        ? (depth < 4 ? microdataItem(el, depth + 1) : {})
        : microdataValue(el);
      String(el.getAttribute("itemprop")).split(/\s+/).filter(Boolean).forEach((name) => {
        if (name in properties) {
          properties[name] = [].concat(properties[name], value);
        } else {
          properties[name] = value;
        }
      });
    });
    return {type: collapse(item.getAttribute("itemtype")) || null, properties};
  };
  const microdata = Array.from(document.querySelectorAll("[itemscope]:not([itemprop])"))
    .slice(0, 30)
    .map((item) => limitBlock(microdataItem(item, 0)));

  // Open Graph (incl. its namespaces like product:, article:) and Twitter cards; repeated keys become arrays
  const URL_KEY = /(^|:)(url|secure_url|image|video|audio)$/;
  const collectMeta = (selector, attribute, keyPattern) => {
    const result = {};
    Array.from(document.querySelectorAll(selector)).slice(0, 200).forEach((el) => {
      const key = collapse(el.getAttribute(attribute)).toLowerCase();
      if (!keyPattern.test(key) || Object.keys(result).length >= 50 && !(key in result)) {
        return;
      }
      let value = truncate(el.getAttribute("content") || "", 1000);
      if (URL_KEY.test(key)) {
        value = absoluteUrl(value) || value;
      }
      result[key] = key in result ? [].concat(result[key], value) : value;
    });
    return result;
  };
  const openGraph = collectMeta("meta[property]", "property", /^(og|product|article|book|profile|music|video|business|place):/);
  const twitter = {
    ...collectMeta("meta[name^='twitter:' i]", "name", /^twitter:/),
    ...collectMeta("meta[property^='twitter:' i]", "property", /^twitter:/)
  };

  // --- Images -----------------------------------------------------------------------------------------------------
  // Page images: every visible <img>, plus logo candidates inside links to the home page and inside elements named
  // like a logo - <img> (also hidden responsive variants), inline <svg>, <object>/<embed>, CSS background and mask
  // images (also on ::before/::after). Images without a fetchable URL (inline SVG, data: URLs) are rendered to a PNG
  // data URL if they are logo candidates. Logo candidates come first, then the largest. The images the page declares
  // (icons, sharing images) follow.
  const MIN_SIZE = 16;
  const MAX_PAGE_IMAGES = 100;
  const RASTER_LIMIT = 4;
  const RASTER_MAX_SIDE = 512;
  const RASTER_MIN_SIDE = 128;
  const MAX_DATA_URL = 150000;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const FORMATS = {
    svg: "svg", "svg+xml": "svg", png: "png", apng: "png", jpg: "jpeg", jpeg: "jpeg", pjpeg: "jpeg", gif: "gif",
    webp: "webp", avif: "avif", ico: "ico", "x-icon": "ico", "vnd.microsoft.icon": "ico"
  };
  const formatOf = (value, mime) => {
    const fromMime = (text) => (/^(?:data:)?image\/([a-z0-9.+-]+)/i.exec(String(text || "").trim()) || [])[1];
    let name = fromMime(mime) || fromMime(value);
    if (!name && value && !/^data:/i.test(String(value).trim())) {
      try {
        name = (/\.([a-z0-9]{2,5})$/i.exec(new URL(String(value).trim(), document.baseURI).pathname) || [])[1];
      } catch (e) {
        name = null;
      }
    }
    return FORMATS[String(name || "").toLowerCase()] || null;
  };

  const shapeOf = (width, height) => {
    if (!(width > 0 && height > 0)) {
      return null;
    }
    const ratio = width / height;
    return ratio >= 1.3 ? "landscape" : ratio <= 0.77 ? "portrait" : "square";
  };

  const numberAttribute = (el, name) => {
    const value = String(el.getAttribute(name) || "").trim();
    return /^\d+(\.\d+)?(px)?$/.test(value) ? parseFloat(value) : 0;
  };

  const isDataImage = (value) => /^data:image\//i.test(String(value || "").trim());

  // Links to the start page, also a language start page like /de/ or /de-de
  const linksHome = (el) => {
    const link = el.closest("a[href]");
    if (!link) {
      return false;
    }
    try {
      const url = new URL(link.href);
      return url.origin === location.origin && url.pathname.replace(/\/[a-z]{2}(-[a-z]{2})?\/?$/i, "/") === "/";
    } catch (e) {
      return false;
    }
  };

  // "logo", "wordmark", "signet" in a name, label or file name of the element or its parents (up to the link).
  // "brand" only as a whole word part of a class or id ("navbar-brand", "brand"), not in utility classes like
  // "bg-brand-2" or "text-brand".
  const LOGO_WORD = /logo|wordmark|signet/i;
  const BRAND_PART = /(^|[-_])brand($|[-_])/i;
  const UTILITY_CLASS = /^(bg|text|border|fill|stroke|from|via|to|ring|outline|shadow|decoration|accent|caret|divide|placeholder)-/i;
  const hasLogoHint = (el) => {
    for (let current = el, depth = 0; current && current.nodeType === 1 && depth < 5; current = current.parentElement, depth++) {
      for (const attribute of Array.from(current.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.slice(0, 300);
        if (name === "class") {
          const tokens = value.split(/\s+/).map((token) => token.replace(/^.*:/, "")).filter((token) => token && !UTILITY_CLASS.test(token));
          if (tokens.some((token) => LOGO_WORD.test(token) || BRAND_PART.test(token))) {
            return true;
          }
        } else if (["id", "alt", "src", "aria-label", "title"].includes(name) || name.startsWith("data-")) {
          if (LOGO_WORD.test(value) || (name === "id" && BRAND_PART.test(value))) {
            return true;
          }
        }
      }
      if (current.tagName.toLowerCase() === "a") {
        break;
      }
    }
    return false;
  };

  const inHeader = (el, visible, rect) => Boolean(el.closest("header, [role=banner]")) || (visible && rect.top + window.scrollY < 200);

  // Own label (alt, aria-label, title, <title> of an svg), otherwise the label or text of the surrounding link
  const labelFor = (el) => {
    const own = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") ||
      (el.tagName.toLowerCase() === "svg" ? el.querySelector("title")?.textContent : "") || "";
    if (collapse(own)) {
      return truncate(own, 200);
    }
    const link = el.closest("a[href]");
    return link ? truncate(link.getAttribute("aria-label") || link.getAttribute("title") || link.textContent || "", 200) : "";
  };

  const candidates = [];
  const addCandidate = (el, source, {url = null, inlineSrc = null, inlineSvg = false, format = null, size = null, color = null, natural = null}) => {
    const visible = isVisible(el);
    const rect = el.getBoundingClientRect();
    const width = Math.round(visible ? rect.width : (size && size.width) || 0);
    const height = Math.round(visible ? rect.height : (size && size.height) || 0);
    if (width < MIN_SIZE || height < MIN_SIZE) {
      return;
    }

    const hints = [];
    if (hasLogoHint(el)) {
      hints.push("logo");
    }
    if (linksHome(el)) {
      hints.push("links-home");
    }
    if (inHeader(el, visible, rect)) {
      hints.push("header");
    }
    if (visible && rect.top + window.scrollY < window.innerHeight) {
      hints.push("above-fold");
    }

    const score = (hints.includes("logo") ? 4 : 0) + (hints.includes("links-home") ? 4 : 0) + (hints.includes("header") ? 3 : 0) +
      (hints.includes("above-fold") ? 1 : 0) + (visible ? 1 : 0);

    const link = el.closest("a[href]");
    candidates.push({
      el, source, url, inlineSrc, inlineSvg, format, width, height, visible, hints, color, score,
      naturalWidth: natural && natural.width ? natural.width : null,
      naturalHeight: natural && natural.height ? natural.height : null,
      // Top left corner in page coordinates (CSS px), only for visible images
      x: visible ? Math.round(rect.left + window.scrollX) : null,
      y: visible ? Math.round(rect.top + window.scrollY) : null,
      link: link ? absoluteUrl(link.getAttribute("href")) : null,
      alt: labelFor(el),
      area: areaOf(el),
      // The background of a mask element is the logo color itself; what is behind it starts at the parent
      background: effectiveBackground(source === "css-mask" ? el.parentElement || el : el)
    });
  };

  const seenElements = new Set();

  const addImg = (img, onlyVisible) => {
    if (seenElements.has(img) || (onlyVisible && !isVisible(img))) {
      return;
    }
    seenElements.add(img);
    const src = String(img.currentSrc || img.getAttribute("src") || "").trim();
    const inline = isDataImage(src);
    const url = inline ? null : absoluteUrl(src);
    if (!url && !inline) {
      return;
    }
    addCandidate(img, "img", {
      url,
      inlineSrc: inline ? src : null,
      format: formatOf(src),
      size: {width: img.naturalWidth || numberAttribute(img, "width"), height: img.naturalHeight || numberAttribute(img, "height")},
      natural: {width: img.naturalWidth, height: img.naturalHeight}
    });
  };

  const svgSize = (svg) => {
    const width = numberAttribute(svg, "width");
    const height = numberAttribute(svg, "height");
    if (width && height) {
      return {width, height};
    }
    const box = svg.viewBox && svg.viewBox.baseVal;
    return box && box.width > 0 && box.height > 0 ? {width: box.width, height: box.height} : null;
  };

  const addSvg = (svg) => {
    if (seenElements.has(svg)) {
      return;
    }
    seenElements.add(svg);
    addCandidate(svg, "svg", {inlineSvg: true, format: "svg", size: svgSize(svg)});
  };

  const addObject = (el) => {
    if (seenElements.has(el)) {
      return;
    }
    seenElements.add(el);
    const value = el.getAttribute(el.tagName.toLowerCase() === "object" ? "data" : "src");
    const format = formatOf(value, el.getAttribute("type"));
    const url = absoluteUrl(value);
    if (url && format) {
      addCandidate(el, "object", {url, format, size: {width: numberAttribute(el, "width"), height: numberAttribute(el, "height")}});
    }
  };

  const cssImageUrl = (value) => {
    const match = /url\(\s*(["']?)(.*?)\1\s*\)/i.exec(value || "");
    return match ? match[2].trim() : null;
  };

  // CSS images of the element and its ::before/::after; hidden elements are skipped (no size to report)
  const addCss = (el) => {
    if (seenElements.has(el) || !isVisible(el)) {
      return;
    }
    seenElements.add(el);
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (pseudo && (style.content === "none" || style.content === "normal")) {
        continue;
      }
      const mask = cssImageUrl(style.getPropertyValue("mask-image")) || cssImageUrl(style.getPropertyValue("-webkit-mask-image"));
      const background = cssImageUrl(style.backgroundImage);
      for (const [source, value] of [["css-mask", mask], ["css-background", background]]) {
        if (!value) {
          continue;
        }
        const inline = isDataImage(value);
        const url = inline ? null : absoluteUrl(value);
        if (!url && !inline) {
          continue;
        }
        addCandidate(el, source, {
          url,
          inlineSrc: inline ? value : null,
          format: formatOf(value),
          // A mask shows the element's background color in the shape of the image
          color: source === "css-mask" ? toHex(style.backgroundColor) || toHex(style.color) : null
        });
      }
    }
  };

  // Logo candidates: everything inside links to the home page and inside elements named like a logo
  const LOGO_SELECTOR = [
    "[class*=logo i]", "[id*=logo i]", "[aria-label*=logo i]", "[title*=logo i]", "[alt*=logo i]", "[data-testid*=logo i]",
    "[data-test-id*=logo i]", "[data-test*=logo i]", "[data-qa*=logo i]", "[class*=navbar-brand i]", "[class*=wordmark i]"
  ].join(", ");
  const homeLinks = Array.from(document.querySelectorAll("a[href]")).slice(0, MAX_SCAN).filter(linksHome).slice(0, 10);
  const logoRoots = [...homeLinks, ...Array.from(document.querySelectorAll(LOGO_SELECTOR)).slice(0, 30)];

  logoRoots.forEach((root) => {
    // An element inside an <svg> stands for its outermost <svg>
    let start = root;
    while (start.ownerSVGElement) {
      start = start.ownerSVGElement;
    }
    [start, ...Array.from(start.querySelectorAll("*:not(svg *)")).slice(0, 80)].forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "svg") {
        addSvg(el);
      } else if (tag === "img") {
        addImg(el, false);
      } else if (tag === "object" || tag === "embed") {
        addObject(el);
      } else {
        addCss(el);
      }
    });
  });

  Array.from(document.images).slice(0, MAX_SCAN).forEach((img) => addImg(img, true));

  // CSS background images anywhere on the page (banners, teasers, product tiles); only the element's own background
  Array.from((document.body || document.documentElement).querySelectorAll("*:not(svg *)")).slice(0, MAX_SCAN).forEach((el) => {
    if (!seenElements.has(el) && /url\(/i.test(getComputedStyle(el).backgroundImage)) {
      addCss(el);
    }
  });

  candidates.sort((a, b) => b.score - a.score || b.width * b.height - a.width * a.height);

  // Rendering of inline images (inline SVG, data: URLs) to a PNG data URL, at least 2x the CSS size
  const loadImage = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error("timeout")), 2000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("image"));
    };
    image.src = src;
  });

  const drawContained = (ctx, image, width, height) => {
    const imageWidth = image.naturalWidth || width;
    const imageHeight = image.naturalHeight || height;
    const scale = Math.min(width / imageWidth, height / imageHeight);
    const drawWidth = imageWidth * scale;
    const drawHeight = imageHeight * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  };

  // {dataUrl, color}: color is the dominant color of the (mostly) opaque pixels, i.e. what the image is painted in.
  // null if nothing was painted (empty sprite reference, transparent placeholder) or the PNG is too big.
  const toPng = (width, height, draw) => {
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d");
    draw(ctx);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    // Colors in buckets of 4 bits per channel; the result is the average of the fullest bucket
    const buckets = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) {
        continue;
      }
      const key = ((pixels[i] >> 4) << 8) | ((pixels[i + 1] >> 4) << 4) | (pixels[i + 2] >> 4);
      const bucket = buckets.get(key) || {count: 0, r: 0, g: 0, b: 0};
      bucket.count++;
      bucket.r += pixels[i];
      bucket.g += pixels[i + 1];
      bucket.b += pixels[i + 2];
      buckets.set(key, bucket);
    }
    if (!buckets.size) {
      return null;
    }
    const dataUrl = output.toDataURL("image/png");
    if (dataUrl.length > MAX_DATA_URL) {
      return null;
    }
    const top = Array.from(buckets.values()).sort((a, b) => b.count - a.count)[0];
    const color = "#" + [top.r, top.g, top.b].map((sum) => Math.round(sum / top.count).toString(16).padStart(2, "0")).join("");
    return {dataUrl, color};
  };

  // A standalone copy of an inline <svg>: page CSS does not apply inside an image, so the computed presentation
  // values are written into style attributes. Elements the <svg> references from outside (sprites via <use>,
  // gradients) are copied into its <defs> unchanged. Scripts and foreignObject are removed.
  const SVG_PROPERTIES = [
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
    "stroke-dasharray", "opacity", "visibility", "display", "stop-color", "stop-opacity", "clip-rule", "color",
    "font-family", "font-size", "font-weight", "font-style", "text-anchor", "letter-spacing"
  ];
  const localReference = (value) => value.replace(/url\(\s*["']?[^"')]*#([^"')]+)["']?\s*\)/g, "url(#$1)");
  // The copied root may be hidden only by the page layout (a responsive variant, a hidden sprite container): its
  // display/visibility/opacity are not copied, and visibility (inherited) only where an element changes it itself
  const inlineStyles = (original, copy) => {
    const originals = [original, ...original.querySelectorAll("*")];
    const copies = [copy, ...copy.querySelectorAll("*")];
    originals.forEach((source, index) => {
      const target = copies[index];
      if (!target) {
        return;
      }
      const style = getComputedStyle(source);
      const parentVisibility = index > 0 && source.parentElement ? getComputedStyle(source.parentElement).visibility : null;
      const declarations = SVG_PROPERTIES
        .filter((name) => !(index === 0 && ["display", "visibility", "opacity"].includes(name)))
        .filter((name) => !(name === "visibility" && style.visibility === parentVisibility))
        .map((name) => {
          const value = style.getPropertyValue(name);
          return value ? `${name}:${localReference(value)}` : "";
        })
        .filter(Boolean);
      target.setAttribute("style", declarations.join(";"));
    });
  };

  const svgDataUrl = (svg, width, height, cssSize) => {
    if (svg.querySelectorAll("*").length > 3000) {
      return null;
    }
    const copy = svg.cloneNode(true);
    inlineStyles(svg, copy);

    const defs = document.createElementNS(SVG_NS, "defs");
    copy.insertBefore(defs, copy.firstChild);
    const references = new Set();
    const collectReferences = (root) => [root, ...root.querySelectorAll("*")].forEach((el) => {
      const href = el.getAttribute("href") || el.getAttribute("xlink:href") || "";
      if (el.tagName.toLowerCase() === "use" && href.startsWith("#")) {
        references.add(href.slice(1));
      }
      for (const name of ["style", "fill", "stroke", "clip-path", "mask", "filter"]) {
        for (const match of String(el.getAttribute(name) || "").matchAll(/url\(\s*["']?#([^"')]+)/g)) {
          references.add(match[1]);
        }
      }
    });
    collectReferences(copy);
    let copied = 0;
    for (const id of references) {
      if (copied >= 20) {
        break;
      }
      if (copy.querySelector(`[id="${CSS.escape(id)}"]`)) {
        continue;
      }
      const referenced = document.getElementById(id);
      if (!referenced || referenced.namespaceURI !== SVG_NS || referenced.contains(svg)) {
        continue;
      }
      // Copied as it is: its content inherits from the <use> (e.g. fill="currentColor"), computed values of the
      // sprite's own place in the page would break that
      const referencedCopy = referenced.cloneNode(true);
      defs.appendChild(referencedCopy);
      collectReferences(referencedCopy);
      copied++;
    }
    if (!defs.childNodes.length) {
      defs.remove();
    }

    copy.querySelectorAll("script, foreignObject").forEach((el) => el.remove());
    [copy, ...copy.querySelectorAll("*")].forEach((el) => Array.from(el.attributes).forEach((attribute) => {
      if (/^on/i.test(attribute.name)) {
        el.removeAttribute(attribute.name);
      }
    }));

    if (!copy.getAttribute("viewBox")) {
      const box = svgSize(svg) || cssSize;
      copy.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    }
    copy.setAttribute("width", String(width));
    copy.setAttribute("height", String(height));

    const markup = new XMLSerializer().serializeToString(copy);
    return markup.length <= 500000 ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup) : null;
  };

  const rasterize = async (candidate) => {
    const longest = Math.max(candidate.width, candidate.height);
    const scale = Math.min(RASTER_MAX_SIDE / longest, Math.max(2, RASTER_MIN_SIDE / longest));
    const width = Math.max(1, Math.round(candidate.width * scale));
    const height = Math.max(1, Math.round(candidate.height * scale));
    const src = candidate.inlineSvg
      ? svgDataUrl(candidate.el, width, height, {width: candidate.width, height: candidate.height})
      : candidate.inlineSrc;
    if (!src) {
      return null;
    }
    const image = await loadImage(src);
    return toPng(width, height, (ctx) => {
      if (candidate.inlineSvg) {
        ctx.drawImage(image, 0, 0, width, height);
        return;
      }
      drawContained(ctx, image, width, height);
      if (candidate.source === "css-mask") {
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = candidate.color || "#000000";
        ctx.fillRect(0, 0, width, height);
      }
    });
  };

  const rendered = new Map();
  await Promise.all(candidates
    .filter((candidate) => (candidate.inlineSvg || candidate.inlineSrc) && (candidate.hints.includes("logo") || candidate.hints.includes("links-home")))
    .slice(0, RASTER_LIMIT)
    .map(async (candidate) => {
      try {
        const png = await rasterize(candidate);
        if (png) {
          rendered.set(candidate, png);
        }
      } catch (e) {
        // not renderable (broken image, tainted canvas, timeout): the candidate is dropped
      }
    }));

  const pageImages = candidates
    .map((candidate) => ({
      url: candidate.url,
      dataUrl: rendered.has(candidate) ? rendered.get(candidate).dataUrl : null,
      source: candidate.source,
      format: candidate.format,
      alt: candidate.alt,
      width: candidate.width,
      height: candidate.height,
      naturalWidth: candidate.naturalWidth,
      naturalHeight: candidate.naturalHeight,
      x: candidate.x,
      y: candidate.y,
      shape: shapeOf(candidate.width, candidate.height),
      area: candidate.area,
      visible: candidate.visible,
      hints: candidate.hints,
      link: candidate.link,
      // A mask's paint color; for a rendered image the dominant color of the rendering
      color: candidate.source === "css-mask" ? candidate.color : rendered.has(candidate) ? rendered.get(candidate).color : null,
      background: candidate.background
    }))
    .filter((image) => image.url || image.dataUrl)
    .slice(0, MAX_PAGE_IMAGES);

  const declaredSize = (el) => {
    const match = /^(\d+)x(\d+)/i.exec(el.getAttribute("sizes") || "");
    return match ? {width: parseInt(match[1], 10), height: parseInt(match[2], 10)} : {width: null, height: null};
  };
  const declaredImage = (url, source, {format = null, width = null, height = null, color = null} = {}) => ({
    url: absoluteUrl(url), dataUrl: null, source, format: format || formatOf(url), alt: "", width, height,
    naturalWidth: null, naturalHeight: null, x: null, y: null, shape: shapeOf(width, height), area: null, visible: null,
    hints: [], link: null, color, background: null
  });
  const declaredImages = [];
  document.querySelectorAll("link[rel~=icon i], link[rel~=apple-touch-icon i], link[rel~=apple-touch-icon-precomposed i], link[rel~=mask-icon i]").forEach((el) => {
    const rel = String(el.getAttribute("rel")).toLowerCase();
    const source = rel.includes("apple-touch-icon") ? "apple-touch-icon" : rel.includes("mask-icon") ? "mask-icon" : "icon";
    const href = el.getAttribute("href");
    declaredImages.push(declaredImage(href, source, {
      ...declaredSize(el),
      format: formatOf(href, el.getAttribute("type")),
      // Safari pinned tab icons are a monochrome mask, painted in this color
      color: source === "mask-icon" ? toHex(el.getAttribute("color")) : null
    }));
  });
  [["og:image", openGraph["og:image"] || openGraph["og:image:url"]], ["twitter:image", twitter["twitter:image"] || twitter["twitter:image:src"]]]
    .forEach(([source, value]) => [].concat(value || []).forEach((url) => declaredImages.push(declaredImage(url, source))));

  const images = [];
  const seenImages = new Set();
  [...pageImages, ...declaredImages].forEach((image) => {
    const key = `${image.source}|${image.url || image.dataUrl}`;
    if ((image.url || image.dataUrl) && !seenImages.has(key) && images.length < 120) {
      seenImages.add(key);
      images.push(image);
    }
  });

  // --- Headings ---------------------------------------------------------------------------------------------------
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .slice(0, MAX_SCAN)
    .filter(isVisible)
    .map((el) => ({level: parseInt(el.tagName.slice(1), 10), text: truncate(el.innerText, 200)}))
    .filter((heading) => heading.text)
    .slice(0, 50);

  // --- Links ------------------------------------------------------------------------------------------------------
  const finalDomain = registrableDomain(location.hostname);

  const linkText = (el) => {
    let text = collapse(el.innerText || el.textContent);
    if (!text) {
      const img = el.querySelector("img[alt]");
      text = collapse(el.getAttribute("aria-label") || el.getAttribute("title") || (img && img.getAttribute("alt")) || "");
    }
    return text.slice(0, 100);
  };

  const links = [];
  const seenLinks = new Set();
  for (const el of document.querySelectorAll("a[href]")) {
    if (links.length >= maxLinks) {
      break;
    }
    const url = absoluteUrl(el.getAttribute("href"));
    if (!url || seenLinks.has(url)) {
      continue;
    }
    seenLinks.add(url);
    links.push({url, text: linkText(el), area: areaOf(el), sameSite: registrableDomain(new URL(url).hostname) === finalDomain});
  }

  // --- Forms ------------------------------------------------------------------------------------------------------
  const FIELD_SELECTOR = "input:not([type=hidden i]):not([type=submit i]):not([type=button i]):not([type=reset i]):not([type=image i]), select, textarea";
  const SUBMIT_SELECTOR = "button:not([type=button i]):not([type=reset i]), input[type=submit i], input[type=image i]";

  const fieldLabel = (el) => {
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = byFor || el.closest("label");
    return truncate((label && label.innerText) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "", 100) || null;
  };
  const fieldOf = (el) => ({
    type: el.tagName.toLowerCase() === "input" ? (el.getAttribute("type") || "text").toLowerCase() : el.tagName.toLowerCase(),
    name: el.getAttribute("name") || null,
    label: fieldLabel(el),
    required: el.required === true
  });
  const fieldsIn = (elements) => elements.filter(isVisible).slice(0, 20).map(fieldOf);

  const forms = [];
  Array.from(document.forms).slice(0, MAX_SCAN).forEach((form) => {
    const fields = fieldsIn(Array.from(form.querySelectorAll(FIELD_SELECTOR)));
    if (!fields.length || forms.length >= 10) {
      return;
    }
    const submit = Array.from(form.querySelectorAll(SUBMIT_SELECTOR)).find(isVisible);
    forms.push({
      // Without an action attribute a form submits to the page itself
      action: absoluteUrl(form.getAttribute("action") || location.href),
      method: (form.getAttribute("method") || "get").toLowerCase(),
      area: areaOf(form),
      fields,
      submit: submit ? labelOf(submit) || null : null
    });
  });
  // Fields outside of any <form> (common in client side rendered pages), as one entry
  const looseFields = fieldsIn(Array.from(document.querySelectorAll(FIELD_SELECTOR)).slice(0, MAX_SCAN).filter((el) => !el.form));
  if (looseFields.length && forms.length < 10) {
    forms.push({action: null, method: null, area: null, fields: looseFields, submit: null});
  }

  // --- Text -------------------------------------------------------------------------------------------------------
  let text = collapse(main ? main.innerText : "");
  if (!text) {
    text = collapse(document.body ? document.body.innerText : "");
  }
  text = text.slice(0, maxText);

  // --- Fonts ------------------------------------------------------------------------------------------------------
  const headingForFont = firstVisible("h1") || firstVisible("h2");

  return {
    title: truncate(document.title, 300),
    lang: collapse(document.documentElement.getAttribute("lang")) || null,
    meta,
    alternates,
    headings,
    links,
    text,
    images,
    forms,
    structuredData: {jsonLd, microdata, openGraph, twitter},
    colors,
    fonts: {
      body: truncate(getComputedStyle(document.body || document.documentElement).fontFamily, 200) || null,
      headings: headingForFont ? truncate(getComputedStyle(headingForFont).fontFamily, 200) || null : null
    }
  };
};

// Loads images the page did not load itself (declared icons, sharing images, lazy hidden variants) as plain images,
// so they go through the page's network stack (proxy, address checks, budget, browser identity) and their bodies are
// captured like all other images. Runs in the isolated world; resolves after all loaded/failed or the timeout.
exports.preloadImages = async ({urls, timeout}) => {
  await Promise.all(urls.map((url) => new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(resolve, timeout);
    image.onload = image.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    image.src = url;
  })));
  return true;
};
