import { agents, environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import type { NetworkNode, NetworkPod, NetworkResources, NetworkSnapshot } from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError } from "../errors.js";
import { environmentService } from "./environments.js";
import {
  readKubernetesInventory,
  type KubernetesNode,
  type KubernetesPod,
  type KubernetesQuota,
  type Quantities,
} from "./network/kubernetes.js";

const SYSTEM_NAMESPACES = new Set([
  "kube-system", "kube-public", "kube-node-lease", "agent-sandbox-system", "local-path-storage",
]);
const ZERO = (): NetworkResources => ({ cpuMillicores: 0, memoryBytes: 0 });

export function kubernetesQuantity(value: string | undefined): number {
  if (!value) return 0;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(value);
  if (!match) throw new Error("Invalid Kubernetes resource quantity");
  const factors: Record<string, number> = {
    "": 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
  };
  const factor = factors[match[2]!];
  if (factor === undefined) throw new Error("Invalid Kubernetes resource quantity suffix");
  return Number(match[1]) * factor;
}

function resources(quantities?: Quantities): NetworkResources {
  return {
    cpuMillicores: Math.ceil(kubernetesQuantity(quantities?.cpu) * 1000),
    memoryBytes: Math.ceil(kubernetesQuantity(quantities?.memory)),
  };
}
function add(a: NetworkResources, b: NetworkResources): NetworkResources {
  return { cpuMillicores: a.cpuMillicores + b.cpuMillicores, memoryBytes: a.memoryBytes + b.memoryBytes };
}
function max(a: NetworkResources, b: NetworkResources): NetworkResources {
  return { cpuMillicores: Math.max(a.cpuMillicores, b.cpuMillicores), memoryBytes: Math.max(a.memoryBytes, b.memoryBytes) };
}

export function podResources(pod: KubernetesPod, kind: "requests" | "limits"): NetworkResources {
  const containers = pod.spec?.containers ?? [];
  const regular = containers.reduce((total, container) => add(total, resources(container.resources?.[kind])), ZERO());
  let sidecars = ZERO();
  let initPeak = ZERO();
  for (const init of pod.spec?.initContainers ?? []) {
    const current = resources(init.resources?.[kind]);
    if (init.restartPolicy === "Always") sidecars = add(sidecars, current);
    initPeak = max(initPeak, init.restartPolicy === "Always" ? sidecars : add(sidecars, current));
  }
  return add(max(add(regular, sidecars), initPeak), resources(pod.spec?.overhead));
}
function active(pod: KubernetesPod): boolean {
  return pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed";
}
function slots(available: number, required: number): number {
  return required > 0 ? Math.max(0, Math.floor((available + 1e-6) / required)) : Infinity;
}

export interface NetworkAssignment {
  providerLeaseId: string | null;
  metadata: Record<string, unknown> | null;
  runId: string | null;
  runStatus: string | null;
  agentId: string | null;
  agentName: string | null;
}

export function buildNetworkSnapshot(input: {
  companyId: string;
  namespace: string;
  config: Record<string, unknown>;
  nodes: KubernetesNode[];
  pods: KubernetesPod[];
  quotas: KubernetesQuota[];
  assignments: NetworkAssignment[];
}): NetworkSnapshot {
  const configured = input.config.defaultResources as { requests?: Quantities; limits?: Quantities } | undefined;
  // Keep the provider's Sandbox/Job defaults; partial overrides also receive the tenant LimitRange defaults.
  const taskResources = {
    requests: resources({ cpu: "250m", memory: "512Mi", ...configured?.requests }),
    limits: resources(configured?.limits ? { cpu: "1", memory: "2Gi", ...configured.limits } : { cpu: "2", memory: "4Gi" }),
  };
  const assignmentsByPod = new Map<string, NetworkAssignment>();
  const assignmentsByRun = new Map<string, NetworkAssignment>();
  for (const assignment of input.assignments) {
    const metadata = assignment.metadata ?? {};
    if (assignment.runId) assignmentsByRun.set(assignment.runId, assignment);
    if (metadata.namespace !== input.namespace) continue;
    for (const key of [metadata.podName, metadata.jobName, assignment.providerLeaseId]) {
      if (typeof key === "string") assignmentsByPod.set(key, assignment);
    }
  }
  const nodePods = new Map<string, KubernetesPod[]>();
  const visiblePods: NetworkPod[] = [];
  let pendingTaskPods = 0;
  let runningTaskPods = 0;
  for (const pod of input.pods) {
    const namespace = pod.metadata?.namespace ?? "default";
    const labels = pod.metadata?.labels ?? {};
    if (pod.spec?.nodeName && active(pod)) {
      const pods = nodePods.get(pod.spec.nodeName) ?? [];
      pods.push(pod);
      nodePods.set(pod.spec.nodeName, pods);
    }
    // Global requests affect capacity, but another company's pod identity never leaves this service.
    if (labels["paperclip.io/company-id"] && labels["paperclip.io/company-id"] !== input.companyId) continue;
    if (namespace !== input.namespace && !SYSTEM_NAMESPACES.has(namespace)) continue;
    const name = pod.metadata?.name ?? "unknown";
    const taskPod = namespace === input.namespace;
    const ownerNames = (pod.metadata?.ownerReferences ?? []).map(owner => owner.name);
    const assignment = taskPod
      ? assignmentsByPod.get(name) ?? ownerNames.map(owner => owner ? assignmentsByPod.get(owner) : undefined).find(Boolean)
        ?? assignmentsByRun.get(labels["paperclip.io/run-id"] ?? "")
      : undefined;
    const phase = pod.status?.phase ?? "Unknown";
    if (taskPod && active(pod)) {
      if (phase === "Running") runningTaskPods++;
      else pendingTaskPods++;
    }
    visiblePods.push({
      name, namespace, nodeName: pod.spec?.nodeName ?? null, phase,
      ready: pod.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True") ?? false,
      terminating: Boolean(pod.metadata?.deletionTimestamp), taskPod,
      requests: podResources(pod, "requests"), limits: podResources(pod, "limits"),
      agent: assignment?.agentId && assignment.agentName ? { id: assignment.agentId, name: assignment.agentName } : null,
      runId: assignment?.runId ?? null, runStatus: assignment?.runStatus ?? null,
    });
  }
  const visibleByNode = new Map<string, NetworkPod[]>();
  const pendingPods: NetworkPod[] = [];
  for (const pod of visiblePods) {
    if (!pod.nodeName) pendingPods.push(pod);
    else {
      const pods = visibleByNode.get(pod.nodeName) ?? [];
      pods.push(pod);
      visibleByNode.set(pod.nodeName, pods);
    }
  }
  const nodes: NetworkNode[] = input.nodes.map(node => {
    const name = node.metadata?.name ?? "unknown";
    const pods = nodePods.get(name) ?? [];
    const requestedResources = pods.reduce((total, pod) => add(total, podResources(pod, "requests")), ZERO());
    const allocatable = { ...resources(node.status?.allocatable), pods: kubernetesQuantity(node.status?.allocatable?.pods) };
    const requested = { ...requestedResources, pods: pods.length };
    const ready = node.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True") ?? false;
    // Provider task pods have no tolerations; NoSchedule and NoExecute taints block new task pods.
    const schedulable = ready && !node.spec?.unschedulable
      && !node.spec?.taints?.some(taint => taint.effect === "NoSchedule" || taint.effect === "NoExecute");
    return {
      name, ready, schedulable,
      architecture: node.status?.nodeInfo?.architecture ?? null,
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? null,
      allocatable, requested,
      freeTaskSlots: schedulable ? Math.min(
        Math.max(0, allocatable.pods - requested.pods),
        slots(allocatable.cpuMillicores - requested.cpuMillicores, taskResources.requests.cpuMillicores),
        slots(allocatable.memoryBytes - requested.memoryBytes, taskResources.requests.memoryBytes),
      ) : 0,
      pods: (visibleByNode.get(name) ?? []).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const quotaSlots: number[] = [];
  for (const quota of input.quotas) {
    // Scoped quotas may not apply to this task class; the standard tenant quota is unscoped.
    if (quota.spec?.scopes?.length || quota.spec?.scopeSelector) continue;
    const hard = quota.status?.hard ?? {};
    const used = quota.status?.used ?? {};
    for (const [key, required] of [
      ["pods", 1], ["count/pods", 1],
      ["requests.cpu", taskResources.requests.cpuMillicores / 1000],
      ["requests.memory", taskResources.requests.memoryBytes],
      ["limits.cpu", taskResources.limits.cpuMillicores / 1000],
      ["limits.memory", taskResources.limits.memoryBytes],
    ] as const) {
      if (hard[key] !== undefined) quotaSlots.push(slots(kubernetesQuantity(hard[key]) - kubernetesQuantity(used[key]), required));
    }
  }
  const quotaFreeTaskSlots = quotaSlots.length ? Math.min(...quotaSlots) : null;
  const unscheduledTaskPods = pendingPods.filter(pod => pod.taskPod && pod.phase !== "Succeeded" && pod.phase !== "Failed").length;
  const nodeFreeTaskSlots = Math.max(0, nodes.reduce((total, node) => total + node.freeTaskSlots, 0) - unscheduledTaskPods);
  return {
    companyId: input.companyId, status: "connected", message: null, observedAt: new Date().toISOString(), namespace: input.namespace,
    nodes, pendingPods, taskResources,
    capacity: {
      runningTaskPods, pendingTaskPods, nodeFreeTaskSlots, quotaFreeTaskSlots,
      freeTaskSlots: Math.min(nodeFreeTaskSlots, quotaFreeTaskSlots ?? Infinity),
    },
  };
}

export function networkService(db: Db) {
  return {
    snapshot: async (companyId: string): Promise<NetworkSnapshot> => {
      const environment = await environmentService(db).findKubernetesEnvironment(companyId);
      if (!environment) return {
        companyId, status: "not_configured", message: "No active Kubernetes environment is configured. Configure Kubernetes execution to inspect its nodes and pods.",
        observedAt: new Date().toISOString(), namespace: null, nodes: [], pendingPods: [],
        taskResources: { requests: ZERO(), limits: ZERO() },
        capacity: { runningTaskPods: 0, pendingTaskPods: 0, nodeFreeTaskSlots: 0, quotaFreeTaskSlots: null, freeTaskSlots: 0 },
      };
      const config = environment.config;
      if (config.inCluster !== true) throw new HttpError(503, "Network inspection currently requires the Kubernetes environment's in-cluster controller credentials.");
      const namespace = `${typeof config.namespacePrefix === "string" ? config.namespacePrefix : "paperclip-"}${typeof config.companySlug === "string" ? config.companySlug : companyId.toLowerCase()}`;
      const [inventory, assignments] = await Promise.all([
        readKubernetesInventory(namespace),
        db.select({
          providerLeaseId: environmentLeases.providerLeaseId, metadata: environmentLeases.metadata,
          runId: heartbeatRuns.id, runStatus: heartbeatRuns.status, agentId: agents.id, agentName: agents.name,
        }).from(environmentLeases)
          .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, companyId)))
          .leftJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
          .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.environmentId, environment.id),
            eq(environmentLeases.provider, "kubernetes"), isNull(environmentLeases.releasedAt))),
      ]);
      return buildNetworkSnapshot({ companyId, namespace, config, ...inventory, assignments });
    },
  };
}
