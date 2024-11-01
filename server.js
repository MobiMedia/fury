const { Cluster } = require("puppeteer-cluster");
const Browser = require("./src/Browser.js");
const BrowserUtils = require("./src/BrowserUtils.js");
const express = require("express");
const msgpack = require("@msgpack/msgpack");
const path = require("path");
const Utils = require("./src/Utils.js");

const app = express();
const port = process.env.PORT || 3000;
const saveDir = process.env.FURY_SAVE_DIR || false;
let timeout = Utils.DEFAULT_TIMEOUT;
let envTimeout = process.env.TIMEOUT

app.use(express.json({limit: "100mb"}));

app.use((req, res, next) => {
  // Return msgpack if the HTTP accept header contains the string "msgpack", else we fall back to json
  req.respondWithMsgPack = (req.get('accept') || "").includes("msgpack");

  res.type(req.respondWithMsgPack ? "application/msgpack" : "application/json");

  next();
});

let
  concurrentLimit = process.env.CONCURRENT_LIMIT;

if (!concurrentLimit) {
  concurrentLimit = 1;
} else {
  try {
    concurrentLimit = parseInt(concurrentLimit);

    if (!Number.isInteger(concurrentLimit)) {
      concurrentLimit = 1;
    }
  } catch (ignored) {
    concurrentLimit = 1;
  }
}

if (envTimeout) {
  try {
    timeout = parseInt(envTimeout);

    if (!Number.isInteger(timeout)) {
      timeout = Utils.DEFAULT_TIMEOUT;
    }
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
    console.log(`Fury server started at port ${port}`);
  });
});

process.on("exit", async () => {
  await cluster.close();
});

const gracefulShutdown = () => {
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

app.get("/", async (req, res) => {
  res.send({ok: true});
});

const createHandler = (functionName, extension) => {
  return async (req, res) => {
    const
      params = req.body;

    try {
      Utils.log(`Received ${functionName} request`);
      await cluster.execute(async ({ page }) => {
        let result = {};

        if (saveDir) {
          result.file = Utils.createUniqueFileName(extension);
        }

        const data = await Browser[functionName](page, {...params, ...{ timeout }}, req.respondWithMsgPack || saveDir, {
          path: result.file ? path.join(saveDir, result.file) : undefined
        });

        if (!saveDir) {
          result.data = data;
        }

        if (req.respondWithMsgPack) {
          result = Buffer.from(msgpack.encode(result));
        }

        res.send(result);
      });
    } catch (e) {
      let result = {data: null, error: Utils.getError(e)};

      if (req.respondWithMsgPack) {
          result = Buffer.from(msgpack.encode(result));
      }

      res.send(result);
    } finally {
      Utils.log(`Finished ${functionName} request`);
    }
  };
}

app.post("/screenshot", createHandler("screenshot", "jpeg"));
app.post("/pdf", createHandler("pdf", "pdf"));
app.post("/file", createHandler("file", "bin"));
