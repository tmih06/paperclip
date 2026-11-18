import { describe, expect, it, vi } from "vitest";
import { buildNetworkSnapshot, kubernetesQuantity, podResources } from "../services/network.js";
import type { KubernetesNode, KubernetesPod, KubernetesQuota } from "../services/network/kubernetes.js";

vi.mock("../services/environments.js", () => ({ environmentService: vi.fn() }));

const namespace = "paperclip-company-a";
function node(name = "worker-1", overrides: Partial<KubernetesNode> = {}): KubernetesNode {
  return {
    metadata: { name },
    status: {
      allocatable: { cpu: "4", memory: "24Gi", pods: "110" },
      conditions: [{ type: "Ready", status: "True" }],
      nodeInfo: { architecture: "arm64", kubeletVersion: "v1.35.0" },
    },
    ...overrides,
  };
}
function pod(name: string, overrides: Partial<KubernetesPod> = {}): KubernetesPod {
  return {
    metadata: { name, namespace, labels: { "paperclip.io/company-id": "company-a" } },
    spec: { nodeName: "worker-1", containers: [{ resources: {
      requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "2", memory: "4Gi" },
    } }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    ...overrides,
  };
}
function snapshot(overrides: Partial<Parameters<typeof buildNetworkSnapshot>[0]> = {}) {
  return buildNetworkSnapshot({ companyId: "company-a", namespace, config: {}, nodes: [node()], pods: [], quotas: [], assignments: [], ...overrides });
}

const quota: KubernetesQuota = { status: {
  hard: { pods: "20", "requests.cpu": "10", "requests.memory": "20Gi", "limits.cpu": "20", "limits.memory": "40Gi" },
  used: { pods: "0", "requests.cpu": "0", "requests.memory": "0", "limits.cpu": "0", "limits.memory": "0" },
} };

describe("Kubernetes network capacity", () => {
  it("parses CPU and memory quantities, including binary, decimal and exponent forms", () => {
    expect(kubernetesQuantity("250m")).toBe(0.25);
    expect(kubernetesQuantity("512Mi")).toBe(536870912);
    expect(kubernetesQuantity("2G")).toBe(2_000_000_000);
    expect(kubernetesQuantity("1e3")).toBe(1000);
    expect(kubernetesQuantity("100n")).toBeCloseTo(1e-7);
    expect(() => kubernetesQuantity("invalid")).toThrow();
  });

  it("uses the tightest quota, not the pod count, for free task slots", () => {
    const result = snapshot({ quotas: [quota] });
    expect(result.capacity).toMatchObject({ nodeFreeTaskSlots: 16, quotaFreeTaskSlots: 10, freeTaskSlots: 10 });
    expect(result.taskResources).toEqual({
      requests: { cpuMillicores: 250, memoryBytes: 512 * 2 ** 20 },
      limits: { cpuMillicores: 2000, memoryBytes: 4 * 2 ** 30 },
    });
    const full = snapshot({ quotas: [{ status: { ...quota.status, used: { "limits.cpu": "20", "limits.memory": "40Gi" } } }] });
    expect(full.capacity.freeTaskSlots).toBe(0);
  });

  it("accounts for every workload's reservation without exposing other-company pod details", () => {
    const result = snapshot({ pods: [pod("private-other-company", {
      metadata: { name: "private-other-company", namespace: "paperclip-company-b", labels: { "paperclip.io/company-id": "company-b" } },
      spec: { nodeName: "worker-1", containers: [{ resources: { requests: { cpu: "3", memory: "1Gi" } } }] },
    }), pod("coredns", { metadata: { name: "coredns", namespace: "kube-system" } })] });
    expect(result.nodes[0]?.requested.cpuMillicores).toBe(3250);
    expect(result.nodes[0]?.freeTaskSlots).toBe(3);
    expect(result.nodes[0]?.pods.map(item => item.name)).toEqual(["coredns"]);
    expect(JSON.stringify(result)).not.toContain("company-b");
    expect(JSON.stringify(result)).not.toContain("private-other-company");
  });

  it("excludes terminal requests and subtracts unscheduled task reservations from available slots", () => {
    const pending = pod("waiting", { spec: { containers: [] }, status: { phase: "Pending" } });
    const result = snapshot({ pods: [pod("complete", { status: { phase: "Succeeded" } }), pending] });
    expect(result.nodes[0]?.requested.pods).toBe(0);
    expect(result.nodes[0]?.freeTaskSlots).toBe(16);
    expect(result.pendingPods.map(item => item.name)).toEqual(["waiting"]);
    expect(result.capacity).toMatchObject({ runningTaskPods: 0, pendingTaskPods: 1, nodeFreeTaskSlots: 15, freeTaskSlots: 15 });
  });

  it("does not count capacity on cordoned, unready or untolerated nodes", () => {
    const result = snapshot({ nodes: [
      node("cordoned", { spec: { unschedulable: true } }),
      node("unready", { status: { allocatable: { cpu: "4", memory: "24Gi", pods: "110" } } }),
      node("tainted", { spec: { taints: [{ effect: "NoSchedule" }] } }),
    ] });
    expect(result.nodes.every(item => !item.schedulable && item.freeTaskSlots === 0)).toBe(true);
    expect(result.capacity.freeTaskSlots).toBe(0);
  });

  it("counts pod density, memory requests and config overrides", () => {
    expect(snapshot({ nodes: [node("worker-1", { status: {
      allocatable: { cpu: "4", memory: "1Gi", pods: "110" }, conditions: [{ type: "Ready", status: "True" }],
    } })] }).capacity.freeTaskSlots).toBe(2);
    expect(snapshot({ nodes: [node("worker-1", { status: {
      allocatable: { cpu: "4", memory: "24Gi", pods: "1" }, conditions: [{ type: "Ready", status: "True" }],
    } })] }).capacity.freeTaskSlots).toBe(1);
    expect(snapshot({ config: { defaultResources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "1", memory: "2Gi" } } }, quotas: [quota] }).capacity.freeTaskSlots).toBe(4);
  });

  it("joins the current reusable lease by namespace and owner instead of trusting an old run label", () => {
    const result = snapshot({ pods: [pod("sandbox-pod", { metadata: {
      name: "sandbox-pod", namespace,
      labels: { "paperclip.io/company-id": "company-a", "paperclip.io/run-id": "old-run", "paperclip.io/agent-id": "not-an-agent-id" },
      ownerReferences: [{ name: "sandbox-1", kind: "Sandbox" }],
    } })], assignments: [{
      providerLeaseId: "sandbox-1", metadata: { namespace }, runId: "new-run", runStatus: "running", agentId: "agent-1", agentName: "Builder",
    }] });
    expect(result.nodes[0]?.pods[0]).toMatchObject({ agent: { id: "agent-1", name: "Builder" }, runId: "new-run", runStatus: "running" });
  });

  it("resolves initial task pods by company-scoped run assignment and leaves unknown agents unassigned", () => {
    const result = snapshot({ pods: [pod("first-pod", { metadata: {
      name: "first-pod", namespace, labels: { "paperclip.io/run-id": "run-1" },
    } }), pod("untracked")], assignments: [{
      providerLeaseId: "sandbox-not-yet-resolved", metadata: {}, runId: "run-1", runStatus: "running", agentId: "agent-1", agentName: "Builder",
    }] });
    expect(result.nodes[0]?.pods[0]?.agent?.name).toBe("Builder");
    expect(result.nodes[0]?.pods[1]?.agent).toBeNull();
  });

  it("uses init-container peaks, restartable sidecars and pod overhead", () => {
    const example = pod("init", { spec: {
      containers: [{ resources: { requests: { cpu: "1", memory: "1Gi" } } }],
      initContainers: [
        { restartPolicy: "Always", resources: { requests: { cpu: "500m", memory: "128Mi" } } },
        { resources: { requests: { cpu: "2", memory: "2Gi" } } },
      ],
      overhead: { cpu: "100m", memory: "64Mi" },
    } });
    expect(podResources(example, "requests")).toEqual({ cpuMillicores: 2600, memoryBytes: 2 * 2 ** 30 + 192 * 2 ** 20 });
  });
});
