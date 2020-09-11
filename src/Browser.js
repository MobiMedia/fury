
const BrowserUtils = require("./BrowserUtils.js");
const Utils = require("./Utils.js");

exports.screenshot = async (page, params) => {
  const
    {url} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  await BrowserUtils.navigate(true, page, params);

  const imageData = await page.screenshot({
    quality: 100,
    encoding: "base64",
    type: "jpeg",
  });

  return imageData;
};

exports.pdf = async (page, params) => {
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
    margin: margin
  });

  return Utils.base64ArrayBuffer(pdfData);
};