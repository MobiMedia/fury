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

exports.getPuppeteerParams = (width, height, isLandscape) => {
  const
    debug = exports.isDebugMode();

  return {
    headless: !debug,
    devtools: debug,
    ignoreHTTPSErrors: true,
    defaultViewport: {
      width: width || 1920,
      height: height || 1080,
      isLandscape: !!isLandscape
    }
  };
};

exports.isDebugMode = () => {
  return process.env.DEBUG === "1";
}