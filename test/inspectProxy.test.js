const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const AddressPolicy = require("../src/AddressPolicy.js");
const InspectProxy = require("../src/InspectProxy.js");
const {startSecretServer} = require("./helpers.js");

const MB = 1024 * 1024;

// A target server answering every request with `size` bytes
const startTarget = async (size = 10) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {"content-type": "text/plain", "x-path": req.url, "x-host": req.headers.host || ""});
    res.end(Buffer.alloc(size, "a"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {port: server.address().port, close: () => new Promise((resolve) => server.close(resolve))};
};

const startProxy = async (allowPrivate, {lookup, maxResponseBytes = 10 * MB, maxTotalBytes = 40 * MB} = {}) => {
  const blocked = [];
  const checker = AddressPolicy.createChecker(AddressPolicy.parseAllowPrivate(allowPrivate), lookup ? {lookup} : {});
  const proxy = await InspectProxy.start({
    checker, maxResponseBytes, maxTotalBytes,
    onBlocked: (target, reason) => blocked.push(`${target} (${reason})`)
  });
  return {proxy, blocked};
};

// Sends CONNECT and returns the status line plus the socket
const connect = (proxyPort, target) => new Promise((resolve, reject) => {
  const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buffer = "";
  const onData = (chunk) => {
    buffer += chunk.toString("latin1");
    const end = buffer.indexOf("\r\n\r\n");
    if (end >= 0) {
      socket.removeListener("data", onData);
      resolve({status: buffer.split("\r\n")[0], socket, rest: buffer.slice(end + 4)});
    }
  };
  socket.on("data", onData);
  socket.on("error", reject);
  socket.on("close", () => resolve({status: buffer.split("\r\n")[0] || "closed", socket, rest: ""}));
});

// Reads until the socket closes, returns the number of bytes
const drain = (socket) => new Promise((resolve) => {
  let bytes = 0;
  socket.on("data", (chunk) => (bytes += chunk.length));
  socket.on("close", () => resolve(bytes));
  socket.on("error", () => {});
});

const proxiedGet = (proxyPort, url) => new Promise((resolve, reject) => {
  const req = http.request({host: "127.0.0.1", port: proxyPort, path: url, method: "GET", headers: {host: new URL(url).host}}, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    res.on("error", () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted: true}));
  });
  req.on("error", reject);
  req.end();
});

test("CONNECT to a private address is refused and never reaches the target", async () => {
  const secret = await startSecretServer();
  const {proxy, blocked} = await startProxy("");

  try {
    for (const target of [`127.0.0.1:${secret.port}`, `localhost:${secret.port}`, `[::1]:${secret.port}`, "169.254.169.254:80"]) {
      const {status, socket} = await connect(proxy.port, target);
      socket.destroy();
      assert.match(status, /403/, target);
    }

    assert.equal(secret.state.connections, 0);
    assert.ok(blocked.some((entry) => entry.includes(`127.0.0.1:${secret.port} (private address)`)), blocked.join("\n"));
    assert.ok(blocked.some((entry) => entry.includes("169.254.169.254:80 (private address)")), blocked.join("\n"));
    assert.equal(proxy.failures.get(`127.0.0.1:${secret.port}`).code, "blocked address");
  } finally {
    await proxy.close();
    await secret.close();
  }
});

test("plain HTTP to a private address answers a marked 502", async () => {
  const secret = await startSecretServer();
  const {proxy} = await startProxy("");

  try {
    const response = await proxiedGet(proxy.port, `http://127.0.0.1:${secret.port}/secret`);
    assert.equal(response.status, 502);
    assert.equal(response.headers["x-fury-proxy-error"], "blocked address");
    assert.equal(secret.state.connections, 0);
  } finally {
    await proxy.close();
    await secret.close();
  }
});

test("connects to exactly the checked address (DNS rebinding)", async () => {
  const target = await startTarget();
  // The name only resolves through the checker's lookup; the proxy must not resolve it again
  let lookups = 0;
  const lookup = async (host) => {
    lookups++;
    if (host === "shop.test") {
      return [{address: "127.0.0.1", family: 4}];
    }
    throw Object.assign(new Error("not found"), {code: "ENOTFOUND"});
  };
  const {proxy} = await startProxy(`shop.test:${target.port}`, {lookup});

  try {
    const response = await proxiedGet(proxy.port, `http://shop.test:${target.port}/hello?x=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-path"], "/hello?x=1");
    assert.equal(response.headers["x-host"], `shop.test:${target.port}`);

    const {status, socket} = await connect(proxy.port, `shop.test:${target.port}`);
    assert.match(status, /200/);
    socket.write(`GET /tunnel HTTP/1.1\r\nHost: shop.test\r\nConnection: close\r\n\r\n`);
    const bytes = await drain(socket);
    assert.ok(bytes > 0);

    assert.equal(lookups, 1, "one lookup, cached for the whole inspect");
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("a lookup answering a private address is refused even for a public looking name", async () => {
  const secret = await startSecretServer();
  const lookup = async () => [{address: "93.184.216.34", family: 4}, {address: "127.0.0.1", family: 4}];
  const {proxy, blocked} = await startProxy("", {lookup});

  try {
    const {status, socket} = await connect(proxy.port, "rebind.test:443");
    socket.destroy();
    assert.match(status, /403/);
    assert.ok(blocked.some((entry) => entry.includes("rebind.test:443 (private address)")));
  } finally {
    await proxy.close();
    await secret.close();
  }
});

test("ports other than 80/443 are refused", async () => {
  const lookup = async () => [{address: "93.184.216.34", family: 4}];
  const {proxy, blocked} = await startProxy("", {lookup});

  try {
    const {status, socket} = await connect(proxy.port, "public.test:22");
    socket.destroy();
    assert.match(status, /403/);
    assert.ok(blocked.some((entry) => entry.includes("(port)")));
  } finally {
    await proxy.close();
  }
});

test("a plain HTTP response over the per-response limit is cut", async () => {
  const target = await startTarget(3 * MB);
  const {proxy, blocked} = await startProxy(`127.0.0.1:${target.port}`, {maxResponseBytes: 1 * MB, maxTotalBytes: 100 * MB});

  try {
    const response = await proxiedGet(proxy.port, `http://127.0.0.1:${target.port}/big`).catch(() => ({body: Buffer.alloc(0)}));
    assert.ok(response.body.length <= 1 * MB + 64 * 1024, `received ${response.body.length}`);
    assert.ok(blocked.some((entry) => entry.includes("response over 1 MB")), blocked.join("\n"));
    assert.equal(proxy.exhausted(), false);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("a tunnel has no limit of its own: many responses to one host pass until the total budget", async () => {
  // HTTP/2 sends all requests to a host through one tunnel: 3 MB here, far over the limit of a single response
  const target = await startTarget(3 * MB);
  const {proxy, blocked} = await startProxy(`127.0.0.1:${target.port}`, {maxResponseBytes: 1 * MB, maxTotalBytes: 100 * MB});

  try {
    const {status, socket} = await connect(proxy.port, `127.0.0.1:${target.port}`);
    assert.match(status, /200/);
    socket.write(`GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    const bytes = await drain(socket);
    assert.ok(bytes >= 3 * MB, `received ${bytes}`);
    assert.deepEqual(blocked, []);
    assert.equal(proxy.exhausted(), false);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("the total budget stops everything and refuses new connections", async () => {
  const target = await startTarget(800 * 1024);
  const {proxy, blocked} = await startProxy(`127.0.0.1:${target.port}`, {maxTotalBytes: 2 * MB});

  try {
    for (let i = 0; i < 4; i++) {
      const {status, socket} = await connect(proxy.port, `127.0.0.1:${target.port}`);
      if (!/200/.test(status)) {
        socket.destroy();
        break;
      }
      socket.write(`GET /chunk HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      await drain(socket);
    }

    assert.equal(proxy.exhausted(), true);
    assert.ok(blocked.some((entry) => entry.startsWith("budget")), blocked.join("\n"));

    const {status, socket} = await connect(proxy.port, `127.0.0.1:${target.port}`);
    socket.destroy();
    assert.match(status, /403/);
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("an unreachable target is recorded as connect failure", async () => {
  // The proxy is started first: it listens on a random port too, and Linux may hand out a just freed port again,
  // the proxy would then connect to itself (200 instead of 403)
  const {proxy} = await startProxy("1");

  // A port nobody listens on
  let port;
  do {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
  } while (port === proxy.port);

  try {
    const {status, socket} = await connect(proxy.port, `127.0.0.1:${port}`);
    socket.destroy();
    assert.match(status, /403/);
    assert.equal(proxy.failures.get(`127.0.0.1:${port}`).code, "connect");
  } finally {
    await proxy.close();
  }
});
