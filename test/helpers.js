const {spawn} = require("child_process");
const express = require("express");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const msgpack = require("@msgpack/msgpack");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const freePort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
};

// Serves test/fixtures; security.html gets the port of the "secret" server inserted
exports.startFixtureServer = async ({secretPort} = {}) => {
  const app = express();

  app.get("/security.html", (req, res) => {
    const html = fs.readFileSync(path.join(FIXTURES, "security.html"), "utf8").replace(/__SECRET_PORT__/g, String(secretPort));
    res.type("html").send(html);
  });
  app.get("/missing.html", (req, res) => {
    res.status(404).type("html").send("<!doctype html><title>Not found</title><h1>Seite nicht gefunden</h1>");
  });
  app.get("/redirect", (req, res) => res.redirect(302, "/simple.html"));
  // A bot protection challenge like PerimeterX answers it: status 403 plus a captcha page
  app.get("/px-challenge", (req, res) => res.status(403).sendFile(path.join(FIXTURES, "px-challenge.html")));
  // Echoes the identity headers the browser sent
  app.get("/headers", (req, res) => {
    const echo = ["user-agent", "sec-ch-ua", "sec-ch-ua-platform", "accept-language"].map((name) => `${name}=${req.headers[name] || ""}`).join(" | ");
    res.type("html").send(`<!doctype html><title>Headers</title><main><pre id="h">${echo.replace(/</g, "&lt;")}</pre><pre id="n"></pre>
      <script>document.getElementById("n").textContent = "webdriver=" + navigator.webdriver + " | languages=" + navigator.languages.join(",") +
        " | platform=" + navigator.platform + " | brands=" + (navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand).join(",") : "");</script></main>`);
  });
  // Product photos of product.html: any name serves the same PNG; the Accept headers of the requests are kept
  const productImageAccepts = [];
  app.get("/products/:name.png", (req, res) => {
    productImageAccepts.push(req.headers.accept || "");
    res.type("png").sendFile(path.join(FIXTURES, "apple-touch-icon.png"));
  });
  app.use(express.static(FIXTURES));

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {port: server.address().port, productImageAccepts, close: () => new Promise((resolve) => server.close(resolve))};
};

// A server that must never be reached: counts every TCP connection
exports.startSecretServer = async () => {
  const state = {connections: 0};
  const server = net.createServer((socket) => {
    state.connections++;
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nsecret");
  });
  const port = await listen(server);

  return {port, state, close: () => new Promise((resolve) => server.close(resolve))};
};

exports.tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fury-test-"));

// Starts `node server.js` with the given env and waits for the start message
exports.startFury = async (env) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {...process.env, DEBUG: "", ...env, PORT: String(port)},
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fury did not start:\n${output}`)), 60000);
    const check = () => {
      if (output.includes("Fury server started")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fury exited with ${code}:\n${output}`));
    });
  });

  return {
    port,
    output: () => output,
    close: () => new Promise((resolve) => {
      child.removeAllListeners("exit");
      child.once("exit", resolve);
      child.kill("SIGTERM");
    })
  };
};

exports.post = async (port, endpoint, body, {msgpack: useMsgpack = false} = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: {"Content-Type": "application/json", ...(useMsgpack ? {Accept: "application/msgpack"} : {})},
    body: JSON.stringify(body)
  });

  if (useMsgpack) {
    return {status: response.status, body: msgpack.decode(new Uint8Array(await response.arrayBuffer()))};
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = text;
  }
  return {status: response.status, body: parsed};
};

// Reads the color of one pixel of an image data URL (decoded by Chrome, no extra dependency)
const dataUrlPixel = async (dataUrl, x, y) => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({headless: true, args: ["--no-sandbox"]});

  try {
    const page = await browser.newPage();
    return await page.evaluate(async (src, px, py) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const [r, g, b, a] = context.getImageData(px, py, 1, 1).data;
      return {r, g, b, a, width: image.width, height: image.height};
    }, dataUrl, x, y);
  } finally {
    await browser.close();
  }
};

exports.dataUrlPixel = dataUrlPixel;
exports.jpegPixel = (jpeg, x, y) => dataUrlPixel(`data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`, x, y);
