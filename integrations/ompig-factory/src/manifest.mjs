export default {
  id: "paperclip.ompig-factory",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "ompig Docker Factory",
  description: "Image-backed ompig-slim clones scheduled onto remote Docker worker slots.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./src/plugin-worker.mjs" },
  environmentDrivers: [{
    driverKey: "ompig_factory", kind: "sandbox_provider", displayName: "Docker Worker Pool",
    description: "Pins an immutable agent image and acquires an independent container on a worker with capacity.",
    defaultAcquireTimeoutMs: 3_600_000,
    sandboxCapabilities: {
      reusableLeases: true, independentControlCommands: true,
      persistentProcessSessions: false, incrementalSessionOutput: false,
      nativeSyncIn: false, nativeSyncOut: false,
    },
    configSchema: {
      type: "object", required: ["workers", "workerToken", "image"], additionalProperties: false,
      properties: {
        workers: { type: "array", minItems: 1, items: { type: "string" }, description: "Worker HTTPS origins or Tailscale IPv4 HTTP origins." },
        workerToken: { type: "string", format: "secret-ref", description: "Company-bound worker token, shared by this company's workers." },
        image: { type: "string", description: "Immutable agent image: registry/repository@sha256:digest. Never a mutable tag." },
        model: { type: "string", description: "Default ompig model (provider/model) for name-only onboarding. Credentials belong in environment variables." },
        reuseLease: { type: "boolean", default: false, description: "Stop and retain this task's files between runs instead of destroying the sandbox after verified copyback." },
        timeoutMs: { type: "number", default: 3600000, description: "Default command timeout in milliseconds." },
      },
    },
  }],
};
