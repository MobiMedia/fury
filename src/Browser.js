
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

  const pageObject = window.mobi?.app?.page;
  if (!pageObject) {
    return;
  }
  const exportData = pageObject.blobExport(params);
  if (!exportData) {
    return;
  }

  return rawData ? exportData : exportData.toString("base64");
};
