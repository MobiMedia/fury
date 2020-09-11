const Browser = require("./src/Browser.js");
const BrowserUtils = require("./src/BrowserUtils.js");
const Utils = require("./src/Utils.js");
const express = require("express");
const { Cluster } = require("puppeteer-cluster");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({limit: "100mb"}));

let
  concurrentLimit = process.env.CONCURRENT_LIMIT,
  timeout = process.env.TIMEOUT;

try {
  concurrentLimit = parseInt(concurrentLimit);
} catch (ignored) {
  concurrentLimit = 1;
}

if (!timeout) {
  timeout = Utils.DEFAULT_TIMEOUT;
} else {
  try {
    timeout = parseInt(timeout);
  } catch (ignored) {
    timeout = Utils.DEFAULT_TIMEOUT;
  }
}

let cluster;

Cluster.launch({
  concurrency: Cluster.CONCURRENCY_CONTEXT,
  maxConcurrency: concurrentLimit,
  puppeteerOptions: BrowserUtils.getPuppeteerParams(),
  timeout: timeout
}).then((_cluster) => {
  cluster = _cluster;

  app.listen(port, () => {
    console.log(`Fury Server started at Port ${port}`);
  });
});

process.on("exit", async () => {
  await cluster.close();
});

app.post("/screenshot", async (req, res) => {
  const
    params = req.body;

  try {
    await cluster.execute(async ({ page }) => {
      const image = await Browser.screenshot(page, params);
      res.send({data: image, error: null});
    });
  } catch (e) {
    res.send({data: null, error: Utils.getError(e)});
  }
});

app.post("/pdf", async (req, res) => {
  const
    params = req.body;

  try {
    await cluster.execute(async ({ page }) => {
      const pdf = await Browser.pdf(page, params);
      res.send({data: pdf, error: null});
    });
  } catch (e) {
    res.send({data: null, error: Utils.getError(e)});
  }
});