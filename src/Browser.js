const puppeteer = require("puppeteer");
const BrowserUtils = require("./BrowserUtils.js");

exports.screenshot = async (params = {}) => {
  const
    {url, width, height, cookies, renderEventName, timeout} = params;
  let
    browser,
    imageData;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  try {
    browser = await puppeteer.launch(BrowserUtils.getPuppeteerParams(width, height, false));
    const
      page = await browser.newPage();

    page.setDefaultTimeout(timeout || 30 * 1000);

    await BrowserUtils.setCookies(page, cookies, url);

    const
      renderEventPromise = BrowserUtils.getRenderEventPromise(page, renderEventName, timeout);

    await page.goto(url, {
      waitUntil: "networkidle0"
    });

    // Wait for the renderEvent...If it isn't defined, this will resolve immediately
    await renderEventPromise;

    imageData = await page.screenshot({
      quality: 100,
      encoding: "base64",
      type: "jpeg",
    });

    return imageData;
  } finally {
    // Always close Browser to prevent memory leaks!
    if (browser) {
      await browser.close();
    }
  }
};
