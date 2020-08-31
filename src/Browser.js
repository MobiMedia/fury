const puppeteer = require("puppeteer");

const
  puppeteerParams = (width, height, isLandscape) => {
    return {
      headless: true,
      devtools: false,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: width || 1920,
        height: height || 1080,
        isLandscape: !!isLandscape
      }
    };
  };

exports.screenshot = async (params = {}) => {
  const
    {url, width, height, cookies, renderEventName} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  const
    browser = await puppeteer.launch(puppeteerParams(width, height, false)),
    page = await browser.newPage();

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

  // If we have to wait with the rendering for a specific Function call, we have
  // to expose the given EventName to the page und resolve the Promise after calling
  // this function
  let eventPromise;
  if (renderEventName) {
    eventPromise = new Promise((resolve) => {
      page.exposeFunction(renderEventName, () => {
        resolve();
      });
    });
  } else {
    eventPromise = Promise.resolve();
  }

  await page.goto(url);

  // Wait for the renderEvent...If it isn't defined, this will resolve immediately
  await eventPromise;

  const imageData = await page.screenshot({
    quality: 100,
    encoding: "base64",
    type: "jpeg",
  });

  await browser.close();

  return imageData;
};
