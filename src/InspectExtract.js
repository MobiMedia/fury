// The metadata extraction of /inspect. `extractPageData` runs inside the page via page.evaluate, so it has to be
// self-contained (no closures over module scope) and must only return plain JSON values.

/* eslint-disable no-undef */
exports.extractPageData = (options) => {
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

  // --- Images: visible images and the ones the page declares (icons, sharing images) ------------------------------
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
  const looksLikeLogo = (el) => {
    for (let current = el, depth = 0; current && current.nodeType === 1 && depth < 4; current = current.parentElement, depth++) {
      const hint = `${current.id} ${typeof current.className === "string" ? current.className : ""} ${current.getAttribute("alt") || ""} ${current.getAttribute("src") || ""}`;
      if (/logo|brand/i.test(hint)) {
        return true;
      }
    }
    return false;
  };

  const visibleImages = Array.from(document.images)
    .slice(0, MAX_SCAN)
    .filter((img) => isVisible(img))
    .map((img) => {
      const rect = img.getBoundingClientRect();
      const hints = [];
      if (looksLikeLogo(img)) {
        hints.push("logo");
      }
      if (linksHome(img)) {
        hints.push("links-home");
      }
      if (rect.top + window.scrollY < window.innerHeight) {
        hints.push("above-fold");
      }
      return {
        url: absoluteUrl(img.currentSrc || img.src),
        source: "img",
        alt: truncate(img.getAttribute("alt") || "", 200),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        area: areaOf(img),
        hints
      };
    })
    .filter((image) => image.url && image.width >= 16 && image.height >= 16)
    // Logo candidates first, then the largest
    .sort((a, b) => Number(b.hints.includes("logo")) - Number(a.hints.includes("logo")) || b.width * b.height - a.width * a.height)
    .slice(0, 30);

  const declaredSize = (el) => {
    const match = /^(\d+)x(\d+)/i.exec(el.getAttribute("sizes") || "");
    return match ? {width: parseInt(match[1], 10), height: parseInt(match[2], 10)} : {width: null, height: null};
  };
  const declaredImages = [];
  document.querySelectorAll("link[rel~=icon i], link[rel~=apple-touch-icon i], link[rel~=apple-touch-icon-precomposed i], link[rel~=mask-icon i]").forEach((el) => {
    const rel = String(el.getAttribute("rel")).toLowerCase();
    const source = rel.includes("apple-touch-icon") ? "apple-touch-icon" : rel.includes("mask-icon") ? "mask-icon" : "icon";
    declaredImages.push({url: absoluteUrl(el.getAttribute("href")), source, alt: "", ...declaredSize(el), area: null, hints: []});
  });
  [["og:image", openGraph["og:image"] || openGraph["og:image:url"]], ["twitter:image", twitter["twitter:image"] || twitter["twitter:image:src"]]]
    .forEach(([source, value]) => [].concat(value || []).forEach((url) => {
      declaredImages.push({url: absoluteUrl(url), source, alt: "", width: null, height: null, area: null, hints: []});
    }));

  const images = [];
  const seenImages = new Set();
  [...visibleImages, ...declaredImages].forEach((image) => {
    const key = `${image.source}|${image.url}`;
    if (image.url && !seenImages.has(key) && images.length < 50) {
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
