const Utils = require("./Utils.js");

const setCookies = async (page, cookies, url) => {
  if (cookies) {
    const
      mappedCookies = Object.keys(cookies).map((key) => {
        return {
          name: key,
          value: cookies[key],
          url: url
        };
      });

    await page.setCookie.apply(page, mappedCookies);
  }
};

exports.getRenderEventPromise = (page, renderEventName, timeout, continueAfterTimeout) => {
  // If we have to wait with the rendering for a specific Function call, we have
  // to expose the given EventName to the page und resolve the Promise after calling
  // this function

  let eventPromise;

  if (renderEventName) {
    eventPromise = new Promise((resolve) => {
      timeout = timeout || Utils.DEFAULT_TIMEOUT;

      let
        resolved = false;

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.error(`Timeout of ${timeout / 1000}s exeeded by waiting for renderEventName function call: "${renderEventName}()"`, continueAfterTimeout ? "Page will be processed anyway..." : "Aborting...");
          resolve();
        }
      }, timeout);

      page.exposeFunction(renderEventName, () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  } else {
    eventPromise = Promise.resolve();
  }

  return eventPromise;
};

exports.getPuppeteerParams = () => {
  const
    debug = exports.isDebugMode(),
    result = {
      headless: !debug,
      devtools: debug,
      args: ["--no-sandbox", "--no-zygote"],
      ignoreHTTPSErrors: true
    };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    result.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return result;
};

exports.isDebugMode = () => {
  return process.env.DEBUG === "1";
}

const windowSetObject = async (page, name, value) => {
  await page.evaluateOnNewDocument(`
    Object.defineProperty(window, '${name}', {
      get() {
        return JSON.parse(${value});
      }
    })
  `);
};

exports.navigate = async (useDimensionsFromParams, page, params) => {
  const
    {url, width, height, cookies, renderEventName, timeout, renderEventNameTimeout} = params;

  Utils.log(`Processing request for "${url}"`);

  if (useDimensionsFromParams) {
    page.setViewport({width: width || 1920, height: height || 1080});
  }

  // Expose all Parameters to the target page so the page can read the values and prepare the page for rendering
  // Double stringify to stringify all type of quotes (' and ")
  await windowSetObject(page, "FURY_PARAMS", JSON.stringify(JSON.stringify(params)));

  page.setDefaultTimeout(timeout || Utils.DEFAULT_TIMEOUT);

  page.on("console", (msg) => {
    const {url, lineNumber, columnNumber} = msg.location();
    let locationMessage = url;

    if (lineNumber) {
      locationMessage += `:${lineNumber}`;
    }

    if (columnNumber) {
      locationMessage += `:${columnNumber}`;
    }

    Utils.log(`[PAGE][${msg.type()}] ${msg.text()} (${locationMessage})`);
  });

  await setCookies(page, cookies, url);

  const defaultTimeout = timeout || Utils.DEFAULT_TIMEOUT;
  let renderEventTimeout = defaultTimeout;

  if (renderEventNameTimeout && renderEventNameTimeout < renderEventTimeout) {
    renderEventTimeout = renderEventNameTimeout;
  }

  const
    renderEventPromise = exports.getRenderEventPromise(page, renderEventName, renderEventTimeout, renderEventTimeout < defaultTimeout);

  await page.goto(url, {
    waitUntil: "networkidle0"
  });

  // Wait for the renderEvent...If it isn't defined, this will resolve immediately
  await renderEventPromise;
  
  const errorObjectText = await page.$$eval(".furyError", (divs) => divs.map((div) => div.innerText));

  if (errorObjectText.length && errorObjectText[0].trim()) {
    throw "An error occured on the page: " + errorObjectText[0].trim();
  }
};
