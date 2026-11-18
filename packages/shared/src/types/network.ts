export interface NetworkResources {
  cpuMillicores: number;
  memoryBytes: number;
}

export interface NetworkPod {
  name: string;
  namespace: string;
  nodeName: string | null;
  phase: string;
  ready: boolean;
  terminating: boolean;
  taskPod: boolean;
  requests: NetworkResources;
  limits: NetworkResources;
  agent: { id: string; name: string } | null;
  runId: string | null;
  runStatus: string | null;
}

export interface NetworkNode {
  name: string;
  ready: boolean;
  schedulable: boolean;
  architecture: string | null;
  kubeletVersion: string | null;
  allocatable: NetworkResources & { pods: number };
  requested: NetworkResources & { pods: number };
  /** Resource-request-based estimate, not a scheduling guarantee. */
  freeTaskSlots: number;
  pods: NetworkPod[];
}

export interface NetworkSnapshot {
  companyId: string;
  status: "connected" | "not_configured";
  message: string | null;
  observedAt: string;
  namespace: string | null;
  nodes: NetworkNode[];
  pendingPods: NetworkPod[];
  taskResources: { requests: NetworkResources; limits: NetworkResources };
  capacity: {
    runningTaskPods: number;
    pendingTaskPods: number;
    nodeFreeTaskSlots: number;
    /** Null until this company's namespace has a ResourceQuota. */
    quotaFreeTaskSlots: number | null;
    freeTaskSlots: number;
  };
}
