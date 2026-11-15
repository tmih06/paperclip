import { DatabaseSync } from "node:sqlite";
import { requireValue } from "./protocol.mjs";

/** One daemon owns each local ledger. SQLite retains its exclusive lock until close. */
export class LeaseStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
      this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (version INTEGER NOT NULL);
        INSERT INTO metadata SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM metadata);
        CREATE TABLE IF NOT EXISTS leases (
          id TEXT PRIMARY KEY, companyId TEXT NOT NULL, environmentId TEXT NOT NULL,
          runId TEXT NOT NULL, agentId TEXT NOT NULL, image TEXT NOT NULL,
          expiresAt INTEGER NOT NULL, state TEXT NOT NULL
        );`);
      requireValue(this.db.prepare("SELECT version FROM metadata").get().version === 1, "factory_ledger_schema_unsupported", 409);
    } catch (error) { this.db.close(); throw error; }
  }

  get(id) { return this.db.prepare("SELECT * FROM leases WHERE id = ?").get(id); }
  all() { return this.db.prepare("SELECT * FROM leases").all(); }
  occupied() { return this.db.prepare("SELECT count(*) AS count FROM leases WHERE state NOT IN ('stopped', 'destroyed')").get().count; }

  /** No await occurs between checking capacity and persisting a physical reservation. */
  reserve(row, slots) {
    requireValue(this.occupied() < slots, "factory_slots_full", 409);
    this.db.prepare("INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.companyId, row.environmentId, row.runId, row.agentId, row.image, row.expiresAt, "creating");
    return this.get(row.id);
  }

  /** A negative acknowledgement is durable: a delayed admission cannot resurrect this ID. */
  tombstone(id, companyId, environmentId) {
    this.db.prepare("INSERT INTO leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, companyId, environmentId, "", "", "", 0, "destroyed");
    return this.get(id);
  }

  update(id, state, expiresAt = this.get(id).expiresAt) {
    this.db.prepare("UPDATE leases SET state = ?, expiresAt = ? WHERE id = ?").run(state, expiresAt, id);
    return this.get(id);
  }

  close() { this.db.close(); }
}
