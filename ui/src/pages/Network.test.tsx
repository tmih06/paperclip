// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkPod, NetworkSnapshot } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { Network } from "./Network";

const mocks = vi.hoisted(() => ({ companyId: "company-1" as string | null, get: vi.fn(), setBreadcrumbs: vi.fn() }));
vi.mock("@/api/network", () => ({ networkApi: { get: mocks.get } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.companyId }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }));

const resources = { cpuMillicores: 250, memoryBytes: 512 * 1024 ** 2 };
const limits = { cpuMillicores: 2000, memoryBytes: 4 * 1024 ** 3 };
const pod: NetworkPod = {
  name: "agent-pod", namespace: "paperclip-company-1", nodeName: "worker-1", phase: "Running", ready: true,
  terminating: false, taskPod: true, requests: resources, limits,
  agent: { id: "agent-1", name: "Developer" }, runId: "run-1", runStatus: "running",
};
function snapshot(): NetworkSnapshot {
  return {
    companyId: "company-1", status: "connected", message: null, observedAt: "2026-11-16T08:00:00Z", namespace: "paperclip-company-1",
    taskResources: { requests: resources, limits },
    capacity: { runningTaskPods: 1, pendingTaskPods: 1, nodeFreeTaskSlots: 12, quotaFreeTaskSlots: 9, freeTaskSlots: 9 },
    nodes: [{ name: "worker-1", ready: true, schedulable: true, architecture: "arm64", kubeletVersion: "v1.34.0",
      allocatable: { cpuMillicores: 4000, memoryBytes: 24 * 1024 ** 3, pods: 110 },
      requested: { ...resources, pods: 2 }, freeTaskSlots: 12,
      pods: [pod, { ...pod, name: "coredns", namespace: "kube-system", taskPod: false, agent: null, runId: null, runStatus: null }],
    }],
    pendingPods: [{ ...pod, name: "waiting-pod", nodeName: null, phase: "Pending", ready: false, agent: null }],
  };
}
let root: Root, container: HTMLDivElement, client: QueryClient;
async function flush() {
  await act(async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><Network /></QueryClientProvider>));
  await flush();
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.companyId = "company-1"; mocks.get.mockResolvedValue(snapshot());
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

describe("Network", () => {
  it("shows nodes, system pods, quota-constrained free slots, and linked agent assignments", async () => {
    await render();
    expect(mocks.get).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("worker-1");
    expect(container.textContent).toContain("agent-pod");
    expect(container.textContent).toContain("coredns");
    expect(container.textContent).toContain("System / infrastructure");
    expect(container.querySelector('a[href="/agents/agent-1"]')?.textContent).toBe("Developer");
    expect(container.textContent).toContain("9Free task slots");
    expect(container.textContent).toContain("12 free node slots");
    expect(container.querySelector('[aria-label="Unscheduled pods"]')?.textContent).toContain("waiting-pod");
    expect(container.textContent).toContain("Unassigned");
  });

  it("refreshes the snapshot on demand", async () => {
    await render();
    const next = snapshot(); next.nodes[0].name = "worker-refreshed";
    mocks.get.mockResolvedValue(next);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("worker-refreshed");
  });

  it("does not fetch without a selected company", async () => {
    mocks.companyId = null;
    await render();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Select a company");
  });

  it("shows loading until the first snapshot arrives", async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.querySelector('[aria-label="Loading cluster network"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No nodes found");
  });

  it("shows an actionable request failure", async () => {
    mocks.get.mockRejectedValue(new ApiError("Cluster inspection failed", 500, null));
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true);
  });

  it("explains when no cluster is configured", async () => {
    mocks.get.mockResolvedValue({ ...snapshot(), status: "not_configured", message: "Configure a Kubernetes environment.", nodes: [] });
    await render();
    expect(container.textContent).toContain("No Kubernetes cluster configured");
    expect(container.textContent).toContain("Configure a Kubernetes environment.");
  });

  it("shows a connected cluster without nodes as empty, not a failure", async () => {
    mocks.get.mockResolvedValue({ ...snapshot(), nodes: [] });
    await render();
    expect(container.textContent).toContain("No nodes found in the connected cluster");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not retain the previous company's pods during a company switch", async () => {
    await render();
    mocks.companyId = "company-2";
    mocks.get.mockReturnValue(new Promise(() => {}));
    await render();
    expect(mocks.get).toHaveBeenLastCalledWith("company-2");
    expect(container.textContent).not.toContain("agent-pod");
    expect(container.textContent).not.toContain("Developer");
  });
});
