#!/usr/bin/env node
// Linux/rootful Docker only. Changes are limited to this integration's bridge and chains.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

assert.equal(process.platform, "linux", "The sandbox firewall helper requires Linux/rootful Docker with iptables.");
assert.equal(process.getuid(), 0, "Run with sudo; configuring the dedicated sandbox firewall requires root.");
const networkName = "paperclip-factory-egress";
const bridge = "pc-factory0";
const subnet = "172.30.250.0/24";
const gateway = "172.30.250.1";
const docker = args => execFileSync("/usr/bin/docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const iptables = args => execFileSync("/usr/sbin/iptables", ["-w", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let network;
try { [network] = JSON.parse(docker(["network", "inspect", networkName])); }
catch (error) {
  // Inventory, rather than interpreting a generic Docker failure as absence.
  if (docker(["network", "ls", "--quiet", "--filter", `name=^${networkName}$`])) throw error;
  docker(["network", "create", "--driver", "bridge", "--subnet", subnet, "--gateway", gateway,
    "--opt", "com.docker.network.bridge.name=" + bridge,
    "--opt", "com.docker.network.bridge.enable_icc=false", "--label", "paperclip-provider=ompig-factory", networkName]);
  [network] = JSON.parse(docker(["network", "inspect", networkName]));
}
assert.equal(network.Labels?.["paperclip-provider"], "ompig-factory", "Refusing an unrelated Docker network.");
assert.equal(network.Driver, "bridge");
assert.equal(network.EnableIPv6, false);
assert.equal(network.Options?.["com.docker.network.bridge.enable_icc"], "false");
assert.equal(network.Options?.["com.docker.network.bridge.name"], bridge);
assert.deepEqual(network.IPAM.Config.map(({ Subnet, Gateway, IPRange = "" }) => ({ Subnet, Gateway, IPRange })),
  [{ Subnet: subnet, Gateway: gateway, IPRange: "" }]);

const privateRanges = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"];
const forward = [
  ["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
  ...privateRanges.map(range => ["-d", range, "-j", "DROP"]),
  ["-p", "tcp", "--dport", "443", "-j", "ACCEPT"],
  ...["1.1.1.1", "1.0.0.1"].flatMap(address => ["udp", "tcp"].map(protocol => ["-d", address, "-p", protocol, "--dport", "53", "-j", "ACCEPT"])),
  ["-j", "DROP"],
];
const input = [
  ["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
  ["-d", gateway, "-p", "tcp", "--dport", "8765", "-j", "ACCEPT"],
  ["-j", "DROP"],
];
function ensureChain(name, rules) {
  const existing = iptables(["-S"]).split("\n").some(line => line === `-N ${name}`);
  if (!existing) {
    iptables(["-N", name]);
    for (const rule of rules) iptables(["-A", name, ...rule]);
  } else {
    // Never flush live sandbox rules or silently append behind an existing DROP.
    const lines = iptables(["-S", name]).split("\n").filter(line => line.startsWith("-A "));
    assert.equal(lines.length, rules.length, `Firewall chain ${name} differs; reconcile explicitly before enabling sandboxes.`);
    for (const rule of rules) iptables(["-C", name, ...rule]);
  }
}
ensureChain("PCFACTORY-FWD", forward);
ensureChain("PCFACTORY-IN", input);
for (const [parent, child] of [["DOCKER-USER", "PCFACTORY-FWD"], ["INPUT", "PCFACTORY-IN"]]) {
  try { iptables(["-C", parent, "-i", bridge, "-j", child]); }
  catch { iptables(["-I", parent, "1", "-i", bridge, "-j", child]); }
}
console.log(JSON.stringify({ network: networkName, bridge, subnet, gateway,
  brokerUrl: `http://${gateway}:8765`, egress: "public TCP 443 and Cloudflare DNS only; private/host/peer traffic denied" }));
