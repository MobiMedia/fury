const { Cluster } = require("puppeteer-cluster");
const Browser = require("./src/Browser.js");
const BrowserUtils = require("./src/BrowserUtils.js");
const express = require("express");
const msgpack = require("@msgpack/msgpack");
const path = require("path");
const Utils = require("./src/Utils.js");
const AddressPolicy = require("./src/AddressPolicy.js");
const Inspect = require("./src/Inspect.js");
const InspectBrowser = require("./src/InspectBrowser.js");

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

// FURY_ENDPOINTS: "render" (default: /screenshot, /pdf, /file), "inspect" (/inspect) or both ("render,inspect")
const endpoints = new Set((process.env.FURY_ENDPOINTS || "render").split(",").map((entry) => entry.trim()).filter(Boolean));
const renderEnabled = endpoints.has("render");
const inspectEnabled = endpoints.has("inspect");

for (const entry of endpoints) {
  if (entry !== "render" && entry !== "inspect") {
    console.warn(`Unknown entry "${entry}" in FURY_ENDPOINTS, allowed are "render" and "inspect"`);
  }
}

let cluster;
let inspectManager;

const parsePositiveInt = (value, defaultValue) => {
  const number = parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : defaultValue;
};

const inspectAllowPrivate = AddressPolicy.parseAllowPrivate(process.env.FURY_INSPECT_ALLOW_PRIVATE);
const inspectSaveDirMaxAge = parsePositiveInt(process.env.FURY_SAVE_DIR_MAX_AGE, 3600);

const launches = [];

if (renderEnabled) {
  launches.push(Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: concurrentLimit,
    puppeteerOptions: BrowserUtils.getPuppeteerParams(),
    timeout: timeout
  }).then((_cluster) => {
    cluster = _cluster;
  }));
}

if (inspectEnabled) {
  if (inspectAllowPrivate.all || inspectAllowPrivate.hosts.size) {
    console.warn(`WARNING: FURY_INSPECT_ALLOW_PRIVATE is set (${inspectAllowPrivate.all ? "all private addresses" : [...inspectAllowPrivate.hosts].join(", ")}). /inspect may reach private addresses. Never set this in production!`);
  }

  inspectManager = InspectBrowser.create({
    concurrency: parsePositiveInt(process.env.CONCURRENT_LIMIT_INSPECT, 2),
    timeout
  });
  launches.push(inspectManager.launch());
}

Promise.all(launches).then(() => {
  app.listen(port, () => {
    console.log(`Fury server started at port ${port} (endpoints: ${[...endpoints].join(", ")})`);
  });
});

process.on("exit", async () => {
  if (cluster) {
    await cluster.close();
  }
  if (inspectManager) {
    await inspectManager.close();
  }
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

if (renderEnabled) {
  app.post("/screenshot", createHandler("screenshot", "jpeg"));
  app.post("/pdf", createHandler("pdf", "pdf"));
  app.post("/file", createHandler("file", "bin"));
}

if (inspectEnabled) {
  app.post("/inspect", async (req, res) => {
    // Aborted when the client goes away, so a waiting request leaves the queue
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    let result;

    try {
      Utils.log(`Received inspect request for "${req.body?.url}"`);

      if (saveDir) {
        Inspect.cleanupSaveDir(saveDir, inspectSaveDirMaxAge);
      }

      const inspected = await Inspect.run(inspectManager, req.body, {
        signal: abortController.signal,
        allowPrivate: inspectAllowPrivate
      });

      if (BrowserUtils.isDebugMode()) {
        // The screenshot itself is not printed, only its size
        const imageBytes = inspected.images.reduce((sum, image) => sum + image.data.length, 0);
        Utils.log(`Inspect result for "${req.body?.url}" (screenshot: ${inspected.screenshot.length} bytes JPEG, ${inspected.images.length} images: ${imageBytes} bytes):\n${JSON.stringify(inspected.metadata, null, 2)}`);
      }

      if (saveDir) {
        result = {...await Inspect.writeFiles(saveDir, inspected), error: null};
        if (BrowserUtils.isDebugMode()) {
          Utils.log(`Inspect files: ${path.join(saveDir, result.file)}, ${path.join(saveDir, result.screenshot)}, ${result.images.length} images`);
        }
      } else {
        result = {
          data: {
            metadata: inspected.metadata,
            screenshot: req.respondWithMsgPack ? inspected.screenshot : inspected.screenshot.toString("base64"),
            // metadata.images[].file -> image bytes
            images: Object.fromEntries(inspected.images.map((image) => [image.name, req.respondWithMsgPack ? image.data : image.data.toString("base64")]))
          },
          error: null
        };
      }
    } catch (e) {
      result = {data: null, error: Utils.getError(e)};
      if (BrowserUtils.isDebugMode()) {
        Utils.log(`Inspect error for "${req.body?.url}": ${result.error}`);
      }
    } finally {
      Utils.log(`Finished inspect request for "${req.body?.url}"`);
    }

    res.send(req.respondWithMsgPack ? Buffer.from(msgpack.encode(result)) : result);
  });
}
