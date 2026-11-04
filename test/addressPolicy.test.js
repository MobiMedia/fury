const test = require("node:test");
const assert = require("node:assert/strict");
const AddressPolicy = require("../src/AddressPolicy.js");

const BLOCKED = [
  "0.0.0.0", "0.1.2.3",
  "10.0.0.1", "10.255.255.255",
  "100.64.0.1", "100.127.255.254",
  "127.0.0.1", "127.255.255.254",
  "169.254.169.254", "169.254.0.1",
  "172.16.0.1", "172.31.255.255",
  "192.168.0.1", "192.168.255.255",
  "192.0.0.170", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
  "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  "::", "::1", "0:0:0:0:0:0:0:1",
  "fc00::1", "fd00::1", "fd00:ec2::254", "fdff:ffff::1",
  "fe80::1", "febf::1", "fec0::1",
  "ff02::1",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1",
  "0:0:0:0:0:ffff:192.168.1.1",
  "::127.0.0.1", "::10.0.0.1",
  "::ffff:0:127.0.0.1",
  "64:ff9b::7f00:1", "64:ff9b::8.8.8.8", "64:ff9b:1::1",
  "2002:7f00:1::1", "2002:a9fe:a9fe::1",
  "2001::1", "2001:db8::1",
  "100::1",
  "fe80::1%lo0",
  "not an ip", ""
];

const PUBLIC = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
  "169.253.255.255", "192.167.255.255", "223.255.255.255",
  "2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::1"
];

for (const ip of BLOCKED) {
  test(`blocks ${ip || "(empty)"}`, () => {
    assert.equal(AddressPolicy.isPublicAddress(ip), false);
  });
}

for (const ip of PUBLIC) {
  test(`allows ${ip}`, () => {
    assert.equal(AddressPolicy.isPublicAddress(ip), true);
  });
}

test("URL parsing normalizes IPv4 notations before the check", () => {
  // WHATWG URL (Chrome and Node) turns decimal, hex and octal hosts into dotted IPv4
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/"]) {
    assert.equal(new URL(url).hostname, "127.0.0.1", url);
  }
  assert.equal(new URL("http://[::ffff:127.0.0.1]/").hostname, "[::ffff:7f00:1]");
});

const fakeLookup = (table) => async (host) => {
  if (!(host in table)) {
    const error = new Error("not found");
    error.code = "ENOTFOUND";
    throw error;
  }
  return table[host];
};

test("checker: every resolved address must be public", async () => {
  const checker = AddressPolicy.createChecker(AddressPolicy.parseAllowPrivate(""), {
    lookup: fakeLookup({
      "public.test": [{address: "93.184.216.34", family: 4}, {address: "2606:2800::1", family: 6}],
      "mixed.test": [{address: "93.184.216.34", family: 4}, {address: "10.0.0.1", family: 4}],
      "v6first.test": [{address: "2606:2800::1", family: 6}, {address: "93.184.216.34", family: 4}]
    })
  });

  assert.deepEqual(await checker.check("public.test", 443), {
    ok: true,
    addresses: [{address: "93.184.216.34", family: 4}, {address: "2606:2800::1", family: 6}]
  });

  const mixed = await checker.check("mixed.test", 443);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "private address");

  // IPv4 first
  assert.equal((await checker.check("v6first.test", 80)).addresses[0].address, "93.184.216.34");

  const unknown = await checker.check("unknown.test", 443);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "dns");
});

test("checker: IP literals, ports and brackets", async () => {
  const checker = AddressPolicy.createChecker(AddressPolicy.parseAllowPrivate(""), {lookup: fakeLookup({})});

  assert.equal((await checker.check("127.0.0.1", 80)).reason, "private address");
  assert.equal((await checker.check("[::1]", 443)).reason, "private address");
  assert.equal((await checker.check("[::ffff:7f00:1]", 443)).reason, "private address");
  assert.equal((await checker.check("8.8.8.8", 8080)).reason, "port");
  assert.equal((await checker.check("8.8.8.8", 443)).ok, true);
  assert.equal((await checker.check("[2606:4700:4700::1111]", 80)).ok, true);
});

test("checker: caches lookups per checker", async () => {
  let calls = 0;
  const checker = AddressPolicy.createChecker(AddressPolicy.parseAllowPrivate(""), {
    lookup: async () => {
      calls++;
      return [{address: "93.184.216.34", family: 4}];
    }
  });

  await checker.check("cached.test", 443);
  await checker.check("CACHED.test", 443);
  assert.equal(calls, 1);
});

test("FURY_INSPECT_ALLOW_PRIVATE: exact host:port exemptions", async () => {
  const allowPrivate = AddressPolicy.parseAllowPrivate("127.0.0.1:4000, [::1]:4001");
  assert.equal(allowPrivate.all, false);

  const checker = AddressPolicy.createChecker(allowPrivate, {
    lookup: fakeLookup({"localhost": [{address: "127.0.0.1", family: 4}]})
  });

  assert.equal((await checker.check("127.0.0.1", 4000)).ok, true);
  assert.equal((await checker.check("[::1]", 4001)).ok, true);
  assert.equal((await checker.check("127.0.0.1", 4001)).reason, "private address");
  assert.equal((await checker.check("localhost", 4000)).reason, "private address");
});

test("FURY_INSPECT_ALLOW_PRIVATE=1 allows everything", async () => {
  const allowPrivate = AddressPolicy.parseAllowPrivate("1");
  assert.equal(allowPrivate.all, true);

  const checker = AddressPolicy.createChecker(allowPrivate, {lookup: fakeLookup({})});
  assert.equal((await checker.check("10.0.0.1", 8080)).ok, true);
  assert.equal(AddressPolicy.parseAllowPrivate(undefined).all, false);
});
