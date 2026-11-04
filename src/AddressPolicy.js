const dns = require("dns");
const net = require("net");

// Decides which hosts /inspect may connect to. Used by the request interception (to report full URLs in `blocked`)
// and by the InspectProxy (which enforces it: it connects to exactly the addresses checked here, so a DNS answer that
// changes between check and connect - DNS rebinding - cannot reach a private address).

const ALLOWED_PORTS = [80, 443];

// [network, prefix length]
const BLOCKED_IPV4 = [
  ["0.0.0.0", 8],        // "this" network
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, cloud metadata service
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // documentation
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // documentation
  ["203.0.113.0", 24],   // documentation
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4]       // reserved, broadcast
];

const ipv4ToInt = (ip) => ip.split(".").reduce((acc, part) => ((acc << 8) | parseInt(part, 10)) >>> 0, 0);

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([network, prefix]) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // ">>> 0" keeps the values unsigned (JS bit operations are signed 32 bit)
  return {network: (ipv4ToInt(network) & mask) >>> 0, mask};
});

const isPublicIPv4 = (ip) => {
  const value = ipv4ToInt(ip);
  return !BLOCKED_IPV4_RANGES.some(({network, mask}) => ((value & mask) >>> 0) === network);
};

// Parses an IPv6 address into 8 16-bit groups (supports "::" and an embedded dotted IPv4 tail)
const parseIPv6 = (ip) => {
  let address = ip.split("%")[0];
  let tail = [];

  const lastColon = address.lastIndexOf(":");
  if (address.includes(".", lastColon)) {
    const v4 = ipv4ToInt(address.slice(lastColon + 1));
    tail = [v4 >>> 16, v4 & 0xffff];
    // "::ffff:1.2.3.4" -> "::ffff", "::1.2.3.4" -> "::"
    address = address.slice(0, lastColon + 1);
    if (!address.endsWith("::")) {
      address = address.slice(0, -1);
    }
  }

  const [head, rest] = address.includes("::") ? address.split("::") : [address, undefined];
  const toGroups = (part) => (part ? part.split(":").filter((group) => group !== "").map((group) => parseInt(group, 16)) : []);
  const headGroups = toGroups(head);
  const restGroups = toGroups(rest);

  if (rest === undefined) {
    return [...headGroups, ...tail];
  }

  const missing = 8 - headGroups.length - restGroups.length - tail.length;
  return [...headGroups, ...new Array(Math.max(missing, 0)).fill(0), ...restGroups, ...tail];
};

const groupsToIPv4 = (high, low) => [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");

const isPublicIPv6 = (ip) => {
  const groups = parseIPv6(ip);

  if (groups.length !== 8 || groups.some((group) => isNaN(group))) {
    return false;
  }

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, includes :: and ::1)
  if (firstFiveZero && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && g7 <= 1) {
      return false; // :: and ::1
    }
    return isPublicIPv4(groupsToIPv4(g6, g7));
  }

  // ::ffff:0:a.b.c.d (IPv4-translated)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isPublicIPv4(groupsToIPv4(g6, g7));
  }

  if (g0 === 0x64 && g1 === 0xff9b) {
    return false; // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48
  }

  if (g0 === 0x2002) {
    return isPublicIPv4(groupsToIPv4(g1, g2)); // 6to4 embeds an IPv4 address
  }

  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) {
    return false; // Teredo (embeds an obfuscated IPv4), documentation
  }

  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return false; // discard prefix 100::/64
  }

  if ((g0 & 0xfe00) === 0xfc00) {
    return false; // unique local fc00::/7 (incl. fd00:ec2::254)
  }

  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) {
    return false; // link-local fe80::/10, deprecated site-local fec0::/10
  }

  if ((g0 & 0xff00) === 0xff00) {
    return false; // multicast
  }

  return true;
};

exports.isPublicAddress = (ip) => {
  const version = net.isIP(ip.split("%")[0]);

  if (version === 4) {
    return isPublicIPv4(ip);
  }

  if (version === 6) {
    return isPublicIPv6(ip);
  }

  return false;
};

// FURY_INSPECT_ALLOW_PRIVATE: "1" allows everything (local experiments), otherwise a comma separated list of exact
// "host:port" entries which skip the address and port checks (test fixtures).
exports.parseAllowPrivate = (value) => {
  if (!value) {
    return {all: false, hosts: new Set()};
  }

  if (value.trim() === "1") {
    return {all: true, hosts: new Set()};
  }

  return {
    all: false,
    hosts: new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))
  };
};

const stripBrackets = (host) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

const formatHostPort = (host, port) => (net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`);

exports.formatHostPort = formatHostPort;

const isExempt = (allowPrivate, host, port) => {
  return allowPrivate.all || allowPrivate.hosts.has(formatHostPort(host, port).toLowerCase());
};

const lookupAll = (host) => new Promise((resolve, reject) => {
  dns.lookup(host, {all: true, verbatim: true}, (error, addresses) => {
    if (error) {
      reject(error);
    } else {
      resolve(addresses);
    }
  });
});

const sortIPv4First = (addresses) => [...addresses].sort((a, b) => a.family - b.family);

/**
 * Creates a checker with its own DNS cache (one per inspect request).
 *
 * check(host, port) resolves to
 *   {ok: true, addresses: [{address, family}]} - connect to exactly these addresses, IPv4 first
 *   {ok: false, reason: "private address" | "port" | "dns", message}
 */
exports.createChecker = (allowPrivate, {lookup = lookupAll} = {}) => {
  const cache = new Map();

  const resolve = async (host, port) => {
    const exempt = isExempt(allowPrivate, host, port);
    let addresses;

    if (net.isIP(host)) {
      addresses = [{address: host, family: net.isIP(host)}];
    } else {
      try {
        addresses = await lookup(host);
      } catch (e) {
        return {ok: false, reason: "dns", message: `${host}: ${e.code || e.message}`};
      }

      if (!addresses.length) {
        return {ok: false, reason: "dns", message: `${host}: no addresses`};
      }
    }

    if (!exempt) {
      const privateAddress = addresses.find(({address}) => !exports.isPublicAddress(address));

      if (privateAddress) {
        return {ok: false, reason: "private address", message: `${host} resolves to ${privateAddress.address}`};
      }

      if (!ALLOWED_PORTS.includes(port)) {
        return {ok: false, reason: "port", message: `port ${port} is not allowed`};
      }
    }

    return {ok: true, addresses: sortIPv4First(addresses)};
  };

  return {
    check: (rawHost, port) => {
      const host = stripBrackets(String(rawHost).toLowerCase());
      const key = formatHostPort(host, port);

      if (!cache.has(key)) {
        cache.set(key, resolve(host, port));
      }

      return cache.get(key);
    }
  };
};

// Port of a WHATWG URL, with the scheme default
exports.urlPort = (url) => (url.port ? parseInt(url.port, 10) : (url.protocol === "https:" || url.protocol === "wss:") ? 443 : 80);
