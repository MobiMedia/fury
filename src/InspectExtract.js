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
    ogSiteName: metaContent("meta[property='og:site_name']"),
    ogType: metaContent("meta[property='og:type']"),
    ogImage: absoluteUrl(metaContent("meta[property='og:image']") || metaContent("meta[property='og:image:url']")),
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

  // --- Logos ------------------------------------------------------------------------------------------------------
  const logos = [];
  const seenLogos = new Set();
  const addLogo = (url, source, alt) => {
    if (url && !seenLogos.has(url) && logos.length < 10) {
      seenLogos.add(url);
      logos.push({url, source, alt: truncate(alt || "", 100)});
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

  Array.from(document.images).slice(0, MAX_SCAN).forEach((img) => {
    const inHeader = !!img.closest("header, [role=banner], nav, [role=navigation]");
    const homeLink = img.closest("a[href]");
    const linksHome = homeLink && (() => {
      try {
        return new URL(homeLink.href).pathname.replace(/\/[a-z]{2}(-[a-z]{2})?\/?$/i, "/") === "/";
      } catch (e) {
        return false;
      }
    })();
    if (looksLikeLogo(img) || (inHeader && linksHome)) {
      addLogo(absoluteUrl(img.currentSrc || img.src), "img", img.alt);
    }
  });

  document.querySelectorAll("link[rel~=apple-touch-icon i], link[rel~=apple-touch-icon-precomposed i]").forEach((el) => {
    addLogo(absoluteUrl(el.getAttribute("href")), "apple-touch-icon");
  });

  Array.from(document.querySelectorAll("link[rel~=icon i]"))
    .map((el) => ({el, size: parseInt((el.getAttribute("sizes") || "0").split("x")[0], 10) || 0}))
    .sort((a, b) => b.size - a.size)
    .forEach(({el}) => addLogo(absoluteUrl(el.getAttribute("href")), "icon"));

  addLogo(meta.ogImage, "og:image");

  // --- Headings ---------------------------------------------------------------------------------------------------
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .slice(0, MAX_SCAN)
    .filter(isVisible)
    .map((el) => ({level: parseInt(el.tagName.slice(1), 10), text: truncate(el.innerText, 200)}))
    .filter((heading) => heading.text)
    .slice(0, 50);

  // --- Links ------------------------------------------------------------------------------------------------------
  const finalDomain = registrableDomain(location.hostname);
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

  // --- Text -------------------------------------------------------------------------------------------------------
  let text = collapse(main ? main.innerText : "");
  if (!text) {
    text = collapse(document.body ? document.body.innerText : "");
  }
  text = text.slice(0, maxText);

  // --- JSON-LD and products ---------------------------------------------------------------------------------------
  const jsonLdBlocks = [];
  document.querySelectorAll("script[type='application/ld+json' i]").forEach((el) => {
    try {
      jsonLdBlocks.push(JSON.parse(el.textContent));
    } catch (e) {
      // ignore invalid blocks
    }
  });

  const products = [];
  const seenProducts = new Set();
  const first = (value) => (Array.isArray(value) ? value[0] : value);
  const imageUrl = (value) => {
    const image = first(value);
    return absoluteUrl(image && typeof image === "object" ? image.url || image.contentUrl : image);
  };
  const addProduct = (product) => {
    const key = `${product.name}|${product.url}`;
    if ((product.name || product.url) && !seenProducts.has(key) && products.length < 30) {
      seenProducts.add(key);
      products.push(product);
    }
  };
  const hasType = (node, type) => {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return types.some((value) => typeof value === "string" && value.replace(/^.*[/#:]/, "") === type);
  };

  const fromJsonLdProduct = (node) => {
    const offer = first(node.offers) || {};
    const innerOffer = first(offer.offers) || {};
    const price = offer.price ?? offer.lowPrice ?? innerOffer.price ?? offer.priceSpecification?.price;
    addProduct({
      name: truncate(node.name || "", 200) || null,
      price: price !== undefined && price !== null ? String(price) : null,
      currency: offer.priceCurrency || innerOffer.priceCurrency || offer.priceSpecification?.priceCurrency || null,
      image: imageUrl(node.image),
      url: absoluteUrl(node.url || offer.url),
      source: "json-ld"
    });
  };

  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8 || products.length >= 30) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, depth + 1));
      return;
    }
    if (hasType(node, "Product") || hasType(node, "ProductGroup")) {
      fromJsonLdProduct(node);
    }
    ["@graph", "itemListElement", "item", "mainEntity", "hasVariant"].forEach((key) => walk(node[key], depth + 1));
  };
  jsonLdBlocks.forEach((block) => walk(block, 0));

  document.querySelectorAll("[itemtype*='schema.org/Product' i]").forEach((el) => {
    const prop = (name) => {
      const target = el.querySelector(`[itemprop~='${name}']`);
      if (!target) {
        return null;
      }
      return target.getAttribute("content") || target.getAttribute("href") || target.getAttribute("src") || collapse(target.innerText) || null;
    };
    addProduct({
      name: truncate(prop("name") || "", 200) || null,
      price: prop("price"),
      currency: prop("priceCurrency"),
      image: absoluteUrl(prop("image")),
      url: absoluteUrl(prop("url")),
      source: "microdata"
    });
  });

  if (/product/i.test(meta.ogType || "")) {
    addProduct({
      name: truncate(metaContent("meta[property='og:title']") || document.title, 200) || null,
      price: metaContent("meta[property='product:price:amount']") || metaContent("meta[property='og:price:amount']"),
      currency: metaContent("meta[property='product:price:currency']") || metaContent("meta[property='og:price:currency']"),
      image: meta.ogImage,
      url: absoluteUrl(metaContent("meta[property='og:url']") || location.href),
      source: "og"
    });
  }

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

  // --- Fonts, login -----------------------------------------------------------------------------------------------
  const headingForFont = firstVisible("h1") || firstVisible("h2");

  return {
    title: truncate(document.title, 300),
    lang: collapse(document.documentElement.getAttribute("lang")) || null,
    meta,
    alternates,
    logos,
    headings,
    links,
    text,
    products,
    jsonLd: jsonLdBlocks.slice(0, 10).map(limitBlock),
    colors,
    fonts: {
      body: truncate(getComputedStyle(document.body || document.documentElement).fontFamily, 200) || null,
      headings: headingForFont ? truncate(getComputedStyle(headingForFont).fontFamily, 200) || null : null
    },
    hasLoginForm: Array.from(document.querySelectorAll("input[type=password]")).some(isVisible)
  };
};
