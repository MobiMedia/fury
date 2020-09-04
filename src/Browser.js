
const BrowserUtils = require("./BrowserUtils.js");
const Utils = require("./Utils.js");

exports.screenshot = async (params = {}) => {
  const
    {url} = params;
  let
    puppeteerBrowser;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  try {
    const
      {page, browser} = await BrowserUtils.openBrowserAndNavigate(true, params);

    puppeteerBrowser = browser;
   
    const imageData = await page.screenshot({
      quality: 100,
      encoding: "base64",
      type: "jpeg",
    });

    return imageData;
  } finally {
    // Always close Browser to prevent memory leaks!
    if (puppeteerBrowser) {
      await puppeteerBrowser.close();
    }
  }
};

exports.pdf = async (params = {}) => {
  const
    {url, format, width, height, printBackground, landscape, margin} = params;
  let
    puppeteerBrowser;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  try {
    const
      {page, browser} = await BrowserUtils.openBrowserAndNavigate(false, params);

    puppeteerBrowser = browser;

    await page.emulateMediaType("screen");
    
    const pdfData = await page.pdf({
      format: width && height ? undefined : format,
      width: width,
      height: height,
      scale: 1,
      printBackground: !!printBackground,
      landscape: !!landscape,
      margin: margin
    });

    return Utils.base64ArrayBuffer(pdfData);
  } finally {
    // Always close Browser to prevent memory leaks!
    if (puppeteerBrowser) {
      await puppeteerBrowser.close();
    }
  }
};