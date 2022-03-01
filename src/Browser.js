
const BrowserUtils = require("./BrowserUtils.js");

exports.screenshot = async (page, params, rawData) => {
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
  });

  return imageData;
};

exports.pdf = async (page, params, rawData) => {
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
    timeout: 0
  });

  return rawData ? pdfData : pdfData.toString("base64");
};