
const BrowserUtils = require("./BrowserUtils.js");
const fs = require('fs');

exports.screenshot = async (page, params, rawData, screenshotOptions = {}) => {
  const
    {url, quality} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  await BrowserUtils.navigate(true, page, params);

  const imageData = await page.screenshot({
    quality: quality ?? 90,
    encoding: rawData ? "binary" : "base64",
    type: "jpeg",
    ...screenshotOptions
  });

  return imageData;
};

exports.pdf = async (page, params, rawData, pdfOptions = {}) => {
  const
    {url, format, width, height, printBackground, landscape, margin, injectIFrameCSS} = params;

  // We need to have an url parameter to proceed
  if (!url) {
    return;
  }

  await BrowserUtils.navigate(false, page, params);

  // Inject custom CSS into all child frames (iframes)
  if (injectIFrameCSS) {
    const applyFrameCSS = async (frame) => {
      try {
        // Create a timeout promise that rejects after specified time
        const timeout = parseInt(process.env.FURY_IFRAME_EVALUATE_TIMEOUT) || 30000; // Default 30 seconds
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Frame evaluation timeout')), timeout)
        );

        // Race between the frame.evaluate and the timeout
        await Promise.race([
          frame.evaluate((cssContent) => {
            const style = document.createElement('style');
            style.textContent = cssContent;
            document.head.appendChild(style);
          }, injectIFrameCSS),
          timeoutPromise
        ]);
      } catch (error) {
        console.warn(`Failed to inject CSS to frame: ${error.message}`);
      }
    };

    // Apply to all child frames (iframes)
    const childFrames = page.mainFrame().childFrames();
    for (const frame of childFrames) {
      await applyFrameCSS(frame);
    }
  }

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

exports.file = async (page, params, rawData, fileOptions = {}) => {
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

      // Convert blob to base64 so puppeteer can forward it correctly to node.js
      const blobToBase64URI = (blob) => {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      }
      const data = await blobToBase64URI(result);
      return {type: result.type, size: result.size, data: data};
    }, params);
  if (!exportData || !exportData.data) {
    return;
  }
  // Decode base64 back to blob
  const decode = (dataURI) => {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (var i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], {type: mimeString});
  }

  const decoded = decode(exportData.data);

  if (fileOptions.path) {
    const buffer = await decoded.arrayBuffer();
    let fileHandle;
    try {
      fileHandle = await fs.promises.open(fileOptions.path, 'w');
      await fileHandle.write(Buffer.from(buffer));
      await fileHandle.sync();
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }

  const bytes = await decoded.bytes();
  return rawData ? bytes : bytes.toString("base64");
};
