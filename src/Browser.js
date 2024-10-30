
const BrowserUtils = require("./BrowserUtils.js");

exports.screenshot = async (page, params, rawData, screenshotOptions = {}) => {
  const
    {url} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  await BrowserUtils.navigate(true, page, params);

  const imageData = await page.screenshot({
    quality: 100,
    encoding: rawData ? "binary" : "base64",
    type: "jpeg",
    ...screenshotOptions
  });

  return imageData;
};

exports.pdf = async (page, params, rawData, pdfOptions = {}) => {
  const
    {url, format, width, height, printBackground, landscape, margin} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  await BrowserUtils.navigate(false, page, params);

  const pdfData = await page.pdf({
    format: format,
    width: width,
    height: height,
    scale: 1,
    printBackground: !!printBackground,
    landscape: !!landscape,
    margin: margin,
    timeout: 0,
    ...pdfOptions
  });

  return rawData ? pdfData : pdfData.toString("base64");
};

exports.file = async (page, params, rawData, pdfOptions = {}) => {
  const
    {url} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  await BrowserUtils.navigate(false, page, params);

  const exportData = await page.evaluate(async (params) => {
      const pageObject = window.mobi?.app?.page;
      if (!pageObject?.blobExport) {
        throw new Error('Page not loaded!');
        return;
      }

      const result = await pageObject.blobExport(params);
      if (!result) {
        return;
      }
      const text = await result.text();
      return {type: result.type, text: text};
    }, params);
  if (!exportData) {
    return;
  }
  const blob = new Blob([exportData.text], {type: exportData.type});
  const bytes = await blob.bytes();
  return rawData ? bytes : bytes.toString("base64");
};
