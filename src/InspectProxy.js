const http = require("http");
const net = require("net");
const AddressPolicy = require("./AddressPolicy.js");

// A small forward proxy, one instance per /inspect request, listening on 127.0.0.1 on a random port. The browser
// context of the request uses it for all traffic (documents, subresources, workers, WebSockets):
// - CONNECT host:port (HTTPS, WSS, WS) is tunneled
// - absolute-URI requests (plain HTTP) are forwarded
// Every target is checked with the AddressPolicy and the proxy connects to exactly the checked address, so DNS
// rebinding cannot reach a private address. It also enforces the byte limits: per inspect for everything, per response
// for plain HTTP. A tunnel has no limit of its own: its content is encrypted, so the proxy cannot tell the responses
// apart, and with HTTP/2 one tunnel carries all requests to a host - a limit per tunnel would be one per host.

const CONNECT_TIMEOUT = 10 * 1000;

// Hop-by-hop headers which must not be forwarded
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te",
  "trailer", "transfer-encoding", "upgrade"];

const parseHostPort = (value, defaultPort) => {
  const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(value) || /^([^:]+)(?::(\d+))?$/.exec(value);

  if (!match) {
    return null;
  }

  return {host: match[1].toLowerCase(), port: match[2] ? parseInt(match[2], 10) : defaultPort};
};

const connectToAny = (addresses, port) => new Promise((resolve, reject) => {
  let index = 0;
  let lastError;

  const tryNext = () => {
    if (index >= addresses.length) {
      reject(lastError || new Error("no address"));
      return;
    }

    const {address} = addresses[index++];
    const socket = net.connect({host: address, port});

    socket.setTimeout(CONNECT_TIMEOUT, () => socket.destroy(new Error(`connect timeout to ${address}:${port}`)));
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      lastError = error;
      tryNext();
    });
  };

  tryNext();
});

/**
 * @param {object} options
 * @param {object} options.checker - AddressPolicy.createChecker() result (shared with the request interception)
 * @param {number} options.maxResponseBytes - per forwarded response (plain HTTP)
 * @param {number} options.maxTotalBytes - per inspect, tunnels included
 * @param {function(string, string)} options.onBlocked - (target, reason)
 * @returns {Promise<{port: number, failures: Map, close: function, exhausted: function}>}
 */
exports.start = async ({checker, maxResponseBytes, maxTotalBytes, onBlocked}) => {
  const sockets = new Set();
  // "host:port" -> {code: "dns"|"connect"|"blocked address", message}, used to explain a failed main navigation
  const failures = new Map();
  let totalBytes = 0;
  let budgetExhausted = false;
  let closed = false;

  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };

  const exhaustBudget = () => {
    if (!budgetExhausted) {
      budgetExhausted = true;
      onBlocked("budget", `more than ${Math.round(maxTotalBytes / 1024 / 1024)} MB in total`);
    }

    for (const socket of sockets) {
      socket.destroy();
    }
  };

  // Counts bytes of one connection towards the total and, with a `limit`, towards its own; returns false (and
  // destroys) when a limit is exceeded
  const createCounter = (label, destroy, limit = Infinity) => {
    let bytes = 0;

    return (chunk) => {
      bytes += chunk.length;
      totalBytes += chunk.length;

      if (totalBytes > maxTotalBytes) {
        exhaustBudget();
        return false;
      }

      if (bytes > limit) {
        onBlocked(label, `response over ${Math.round(limit / 1024 / 1024)} MB`);
        destroy();
        return false;
      }

      return true;
    };
  };

  // Checks the target; on failure records it and returns null
  const checkTarget = async (host, port, label) => {
    if (budgetExhausted) {
      return null;
    }

    const result = await checker.check(host, port);
    const key = AddressPolicy.formatHostPort(host, port);

    if (!result.ok) {
      failures.set(key, {code: result.reason === "dns" ? "dns" : "blocked address", message: result.message});

      if (result.reason !== "dns") {
        onBlocked(label, result.reason);
      }

      return null;
    }

    return result.addresses;
  };

  const connectChecked = async (host, port, addresses) => {
    try {
      return await connectToAny(addresses, port);
    } catch (e) {
      failures.set(AddressPolicy.formatHostPort(host, port), {code: "connect", message: `${host}: ${e.code || e.message}`});
      return null;
    }
  };

  const server = http.createServer();

  server.on("connection", (socket) => track(socket));

  // CONNECT host:port - HTTPS, WSS and (in Chrome) WS
  server.on("connect", async (req, clientSocket, head) => {
    const target = parseHostPort(req.url, 443);

    if (!target) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const label = `${target.port === 443 ? "https" : "http"}://${AddressPolicy.formatHostPort(target.host, target.port)}`;
    const addresses = await checkTarget(target.host, target.port, label);
    const upstream = addresses && !clientSocket.destroyed ? await connectChecked(target.host, target.port, addresses) : null;

    if (!upstream || closed || clientSocket.destroyed) {
      if (upstream) {
        upstream.destroy();
      }
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    track(upstream);

    const destroyBoth = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    const count = createCounter(label, destroyBoth);

    // The side that is still open is ended, not destroyed: what was written to it but not sent yet (the end of a
    // response whose server closes the connection) still goes out
    upstream.on("close", (hadError) => (hadError ? clientSocket.destroy() : clientSocket.end()));
    clientSocket.on("close", (hadError) => (hadError ? upstream.destroy() : upstream.end()));

    upstream.on("data", (chunk) => {
      if (count(chunk)) {
        clientSocket.write(chunk);
      }
    });
    clientSocket.on("data", (chunk) => {
      if (count(chunk)) {
        upstream.write(chunk);
      }
    });

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (head && head.length && count(head)) {
      upstream.write(head);
    }
  });

  // Absolute-URI request: plain HTTP
  server.on("request", async (req, res) => {
    let url;

    try {
      url = new URL(req.url);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }

    if (url.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }

    const port = AddressPolicy.urlPort(url);
    const label = `${url.origin}${url.pathname}`;
    const addresses = await checkTarget(url.hostname, port, label);

    const fail = (code) => {
      // Marked so the inspect can tell a proxy error page from a real response of the site
      if (!res.headersSent) {
        res.writeHead(502, {"x-fury-proxy-error": code, "content-type": "text/plain"});
      }
      res.end();
    };

    if (!addresses) {
      fail(failures.get(AddressPolicy.formatHostPort(url.hostname.replace(/^\[|\]$/g, ""), port))?.code || "blocked address");
      return;
    }

    const headers = {...req.headers};
    for (const name of HOP_BY_HOP) {
      delete headers[name];
    }

    const upstreamReq = http.request({
      host: addresses[0].address,
      port,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      setHost: false,
      agent: false,
      // Connect only to a checked address, also on retries
      lookup: (hostname, options, callback) => {
        const {address, family} = addresses[0];
        if (options && options.all) {
          callback(null, [{address, family}]);
        } else {
          callback(null, address, family);
        }
      }
    });

    upstreamReq.setTimeout(CONNECT_TIMEOUT, () => upstreamReq.destroy(new Error("timeout")));
    upstreamReq.on("socket", (socket) => track(socket));

    upstreamReq.on("error", (e) => {
      failures.set(AddressPolicy.formatHostPort(url.hostname.replace(/^\[|\]$/g, ""), port), {code: "connect", message: `${url.hostname}: ${e.code || e.message}`});
      fail("connect");
    });

    upstreamReq.on("response", (upstreamRes) => {
      upstreamReq.setTimeout(0);

      const responseHeaders = {...upstreamRes.headers};
      for (const name of HOP_BY_HOP) {
        delete responseHeaders[name];
      }

      const count = createCounter(label, () => {
        upstreamRes.destroy();
        res.destroy();
      }, maxResponseBytes);

      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, responseHeaders);
      upstreamRes.on("data", (chunk) => {
        if (count(chunk)) {
          res.write(chunk);
        }
      });
      upstreamRes.on("end", () => res.end());
      upstreamRes.on("error", () => res.destroy());
    });

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      upstreamReq.write(chunk);
    });
    req.on("end", () => upstreamReq.end());
  });

  // Upgrade through an absolute-URI request (ws:// without CONNECT): not used by Chrome, refused to be safe
  server.on("upgrade", (req, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    port: server.address().port,
    failures,
    exhausted: () => budgetExhausted,
    close: () => new Promise((resolve) => {
      closed = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    })
  };
};
