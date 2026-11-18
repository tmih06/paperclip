import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { HttpError } from "../../errors.js";

interface Metadata {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  deletionTimestamp?: string;
  ownerReferences?: Array<{ name?: string; kind?: string }>;
}
export type Quantities = Record<string, string>;
interface Container {
  resources?: { requests?: Quantities; limits?: Quantities };
  restartPolicy?: string;
}
export interface KubernetesPod {
  metadata?: Metadata;
  spec?: {
    nodeName?: string;
    containers?: Container[];
    initContainers?: Container[];
    overhead?: Quantities;
  };
  status?: { phase?: string; conditions?: Array<{ type: string; status: string }> };
}
export interface KubernetesNode {
  metadata?: Metadata;
  spec?: { unschedulable?: boolean; taints?: Array<{ effect?: string }> };
  status?: {
    allocatable?: Quantities;
    conditions?: Array<{ type: string; status: string }>;
    nodeInfo?: { architecture?: string; kubeletVersion?: string };
  };
}
export interface KubernetesQuota {
  spec?: { scopes?: string[]; scopeSelector?: unknown };
  status?: { hard?: Quantities; used?: Quantities };
}
interface KubernetesList<T> { items: T[]; metadata?: { continue?: string } }

/** Read-only inventory for the same service-account credentials used by the provider. */
export async function readKubernetesInventory(namespace: string) {
  const serviceAccountPath = "/var/run/secrets/kubernetes.io/serviceaccount";
  let token: string;
  let ca: Buffer;
  try {
    [token, ca] = await Promise.all([
      readFile(`${serviceAccountPath}/token`, "utf8"),
      readFile(`${serviceAccountPath}/ca.crt`),
    ]);
  } catch {
    throw new HttpError(503, "Kubernetes controller credentials are unavailable. Mount the controller service-account token and CA certificate.");
  }
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new HttpError(503, "KUBERNETES_SERVICE_HOST is not configured.");
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  async function get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, `https://${authority}:${port}`), {
        ca,
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          // A namespace may not exist until this company's first task runs.
          if (res.statusCode === 404 && path.startsWith("/api/v1/namespaces/")) {
            resolve({ items: [] } as T);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new HttpError(503, res.statusCode === 403
              ? "The Kubernetes controller cannot inspect cluster nodes, pods, and quotas. Apply the updated controller RBAC."
              : "The Kubernetes API could not provide the cluster inventory. Try again."));
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
          catch { reject(new HttpError(503, "The Kubernetes API returned an invalid inventory response.")); }
        });
      });
      req.on("error", () => reject(new HttpError(503, "Cannot reach the Kubernetes API. Check the controller network and credentials, then try again.")));
      req.end();
    });
  }

  async function list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let continuation = "";
    do {
      const params = new URLSearchParams({ limit: "500" });
      if (continuation) params.set("continue", continuation);
      const page = await get<KubernetesList<T>>(`${path}?${params}`);
      items.push(...page.items);
      continuation = page.metadata?.continue ?? "";
    } while (continuation);
    return items;
  }

  const [nodes, pods, quotas] = await Promise.all([
    list<KubernetesNode>("/api/v1/nodes"),
    list<KubernetesPod>("/api/v1/pods"),
    list<KubernetesQuota>(`/api/v1/namespaces/${encodeURIComponent(namespace)}/resourcequotas`),
  ]);
  return { nodes, pods, quotas };
}
