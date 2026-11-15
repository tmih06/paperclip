import { readFile, stat } from "node:fs/promises";
import { openWorker, createWorkerServer } from "./worker.mjs";

const filename = process.argv[2];
if (!filename) throw new Error("Usage: node src/worker-main.mjs /etc/paperclip-factory/worker.json");
if ((await stat(filename)).mode & 0o077) throw new Error("Worker config contains credentials and must have mode 0600.");
const config = JSON.parse(await readFile(filename, "utf8"));
const worker = await openWorker(config);
const server = createWorkerServer(worker);
server.listen(config.port ?? 8787, config.host ?? "127.0.0.1", () => {
  console.log(`Factory worker ${worker.config.workerId} listening; ${worker.config.slots} slots.`);
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  worker.closed = true;
  server.close();
  server.closeAllConnections();
  // Docker lifetime guards remain authoritative during supervisor restart.
  await worker.close();
};
// Drain is an operator signal, not a company-token endpoint that could affect other tenants.
process.on("SIGHUP", () => { worker.config.draining = true; worker.notifyCapacity(); });
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
