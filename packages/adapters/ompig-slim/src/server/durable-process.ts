// Runs inside the selected execution target, never on the controller as a fallback.
// The Durable store remains authoritative; this shim only transports stdin and events.
export const DURABLE_PROCESS = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1024 * 1024) { console.error('ompig assignment exceeds 1 MiB'); process.exit(1); }
});
process.stdin.on('end', () => {
  let child;
  let timer;
  let fd;
  try {
    const assignment = JSON.parse(input);
    const { command, stateDir, cwd, model, requestId, prompt, promptHash, maxTurns, requireExisting } = assignment;
    const jobPath = path.join(stateDir, 'job.json');
    const existed = fs.existsSync(jobPath);
    if (requireExisting && !existed) throw Error('Durable state is missing. Restore the complete workdesk and original workspace; refusing to replay.');
    if (existed) {
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      if (job.version !== 1 || job.request_id !== requestId || job.cwd !== cwd || job.model !== model
        || (requireExisting ? createHash("sha256").update(job.prompt).digest("hex") !== promptHash : job.prompt !== prompt) || job.max_turns !== maxTurns) {
        throw Error('Durable assignment mismatch. Restore its original cwd/model/prompt/budget; refusing to replay or replace state.');
      }
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const eventsPath = path.join(stateDir, 'events.jsonl');
    fd = fs.openSync(eventsPath, 'a+', 0o600);
    let position = fs.fstatSync(fd).size;
    const tail = () => {
      const size = fs.fstatSync(fd).size;
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(size - position, 65536));
        const bytes = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!bytes) break;
        position += bytes;
        process.stdout.write(chunk.subarray(0, bytes));
      }
    };
    const args = existed
      ? ['durable', 'resume', '--state', stateDir, '--events-file', eventsPath]
      : ['durable', 'run', '--state', stateDir, '--cwd', cwd, '--model', model, '--request-id', requestId, '--max-turns', String(maxTurns), '--events-file', eventsPath, '--', prompt];
    child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Preserve receipt line boundaries: drain committed events before the receipt.
    let receipt = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { receipt += chunk; });
    child.stderr.pipe(process.stderr);
    timer = setInterval(tail, 100);
    const stop = signal => { if (child) child.kill(signal); };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    child.on('error', error => {
      clearInterval(timer); fs.closeSync(fd); fd = undefined;
      console.error('Cannot start ompig-slim: ' + error.message); process.exitCode = 1;
    });
    child.on('close', (code, signal) => {
      clearInterval(timer);
      if (fd !== undefined) { try { tail(); fs.closeSync(fd); } catch {} fd = undefined; }
      if (receipt) process.stdout.write(receipt.endsWith('\n') ? receipt : receipt + '\n');
      process.exitCode = code === null ? (signal ? 128 : 1) : code;
    });
  } catch (error) {
    if (timer) clearInterval(timer);
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    console.error(error.message); process.exitCode = 1;
  }
});
`;
