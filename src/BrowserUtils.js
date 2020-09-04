const puppeteer = require("puppeteer");

exports.setCookies = async (page, cookies, url) => {
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

exports.getRenderEventPromise = (page, renderEventName, timeout) => {
  // If we have to wait with the rendering for a specific Function call, we have
  // to expose the given EventName to the page und resolve the Promise after calling
  // this function

  let eventPromise;

  if (renderEventName) {
    eventPromise = new Promise((resolve, reject) => {
      timeout = timeout || 30 * 1000;

      let
        resolved = false;

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(`Timeout of ${timeout / 1000}s exeeded by waiting for renderEventName`);
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

exports.getPuppeteerParams = (width, height) => {
  const
    debug = exports.isDebugMode();

  return {
    headless: !debug,
    devtools: debug,
    ignoreHTTPSErrors: true,
    defaultViewport: {
      width: width || 1920,
      height: height || 1080
    }
  };
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

exports.openBrowserAndNavigate = async (useDimensionsFromParams, params) => {
  const
    {url, width, height, cookies, renderEventName, timeout} = params,
    browser = await puppeteer.launch(exports.getPuppeteerParams(useDimensionsFromParams ? width : null, useDimensionsFromParams ? height : null)),
    page = await browser.newPage();

    // Expose all Parameters to the target page so the page can 
    // Double stringify to stringify all type of quotes (' and ")
    await windowSetObject(page, "FURY_PARAMS", JSON.stringify(JSON.stringify(params)));

    page.setDefaultTimeout(timeout || 30 * 1000);

    await exports.setCookies(page, cookies, url);

    const
      renderEventPromise = exports.getRenderEventPromise(page, renderEventName, timeout);

    await page.goto(url, {
      waitUntil: "networkidle0"
    });

    // Wait for the renderEvent...If it isn't defined, this will resolve immediately
    await renderEventPromise;

    return {
      page: page,
      browser: browser
    }
};