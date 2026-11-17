import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Cpu, Layers, Network as NetworkIcon, RefreshCw, Server } from "lucide-react";
import type { NetworkPod } from "@paperclipai/shared";
import { networkApi } from "@/api/network";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { QueryErrorState, QueryPlaceholder, useQueryView } from "@/components/QueryView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { formatBytes } from "@/lib/issue-output";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { formatDateTime, formatNumber } from "@/lib/utils";

function PodList({ pods }: { pods: NetworkPod[] }) {
  if (pods.length === 0) return <p className="px-4 py-4 text-sm text-muted-foreground">No visible pods on this node.</p>;
  return <div className="overflow-x-auto">
    <table className="w-full text-left text-sm">
      <thead className="border-b border-border text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="px-4 py-3 font-medium">Pod / namespace</th>
          <th scope="col" className="px-4 py-3 font-medium">Status</th>
          <th scope="col" className="px-4 py-3 font-medium">Agent</th>
          <th scope="col" className="px-4 py-3 font-medium">CPU request</th>
          <th scope="col" className="px-4 py-3 font-medium">Memory request</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {pods.map(pod => <tr key={`${pod.namespace}/${pod.name}`}>
          <td className="px-4 py-3">
            <div className="flex flex-col gap-1">
              <span className="break-all font-mono text-xs">{pod.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{pod.namespace}</span>
            </div>
          </td>
          <td className="px-4 py-3">
            <div className="flex flex-col items-start gap-1">
              <Badge variant={pod.phase === "Failed" ? "destructive" : "outline"}>
                {pod.terminating ? "Terminating" : pod.phase === "Running" && !pod.ready ? "Starting" : pod.phase}
              </Badge>
              {pod.runStatus && <span className="text-xs text-muted-foreground">Run: {pod.runStatus}</span>}
            </div>
          </td>
          <td className="px-4 py-3">
            {pod.agent
              ? <Link to={`/agents/${encodeURIComponent(pod.agent.id)}`} className="font-medium text-foreground hover:underline">{pod.agent.name}</Link>
              : <span className="text-muted-foreground">{pod.taskPod ? "Unassigned" : "System / infrastructure"}</span>}
          </td>
          <td className="px-4 py-3 font-mono text-xs tabular-nums">{formatNumber(pod.requests.cpuMillicores)}m</td>
          <td className="px-4 py-3 font-mono text-xs tabular-nums">{formatBytes(pod.requests.memoryBytes)}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

export function Network() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Servers" }]); }, [setBreadcrumbs]);
  const query = useQuery({
    queryKey: queryKeys.network(selectedCompanyId ?? ""),
    queryFn: () => networkApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const view = useQueryView(query);
  const snapshot = view.data;

  if (!selectedCompanyId) return <EmptyState icon={NetworkIcon} message="Select a company to inspect its cluster." />;

  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Servers</h1>
        <p className="text-sm text-muted-foreground">Cluster nodes, pod capacity, and this company’s agent assignments.</p>
        {snapshot && <p className="text-xs text-muted-foreground">Observed <span className="font-mono">{formatDateTime(snapshot.observedAt, { includeSeconds: true })}</span></p>}
      </div>
      <Button variant="outline" size="sm" onClick={() => view.retry()} disabled={query.isFetching}>
        <RefreshCw aria-hidden className={query.isFetching ? "animate-spin" : undefined} />
        {query.isFetching ? "Refreshing…" : "Refresh"}
      </Button>
    </div>

    {view.kind === "error" && <QueryErrorState error={view.error} action="load the cluster network" onRetry={view.retry} retrying={query.isFetching} />}
    {!snapshot && view.kind !== "error" && <QueryPlaceholder label="Loading cluster network" />}
    {snapshot?.status === "not_configured" && <EmptyState icon={NetworkIcon} message="No Kubernetes cluster configured." description={snapshot.message ?? "Configure a Kubernetes environment to inspect nodes and agent pods."} />}
    {snapshot?.status === "connected" && <>
      {view.kind === "stale" && <p role="status" className="text-xs text-muted-foreground">Updating paused. Showing the last cluster snapshot.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard icon={Server} label="Connected nodes" value={formatNumber(snapshot.nodes.length)} />
        <MetricCard icon={Boxes} label="Running task pods" value={formatNumber(snapshot.capacity.runningTaskPods)} />
        <MetricCard icon={Layers} label="Pending task pods" value={formatNumber(snapshot.capacity.pendingTaskPods)} />
        <MetricCard icon={Cpu} label="Free task slots" value={formatNumber(snapshot.capacity.freeTaskSlots)} />
      </div>
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>Free slots are an estimate based on resource requests and company quota, not a scheduling guarantee. Node slots share the same company quota.</p>
        <p>Per task: <span className="font-mono">{formatNumber(snapshot.taskResources.requests.cpuMillicores)}m CPU / {formatBytes(snapshot.taskResources.requests.memoryBytes)}</span> requested; <span className="font-mono">{formatNumber(snapshot.taskResources.limits.cpuMillicores)}m CPU / {formatBytes(snapshot.taskResources.limits.memoryBytes)}</span> limit.</p>
        <p>Node capacity: <span className="font-mono">{formatNumber(snapshot.capacity.nodeFreeTaskSlots)}</span> slots. Company quota: <span className="font-mono">{snapshot.capacity.quotaFreeTaskSlots === null ? "Not set" : `${formatNumber(snapshot.capacity.quotaFreeTaskSlots)} slots`}</span>. System pods are shown; other companies’ pod details are hidden.</p>
      </div>
      {snapshot.nodes.length === 0 && <EmptyState icon={Server} message="No nodes found in the connected cluster." description="Check that cluster nodes are registered, then refresh." />}
      <div className="flex flex-col gap-4">
        {snapshot.nodes.map(node => <details key={node.name} open className="overflow-hidden rounded-lg border border-border">
          <summary className="cursor-pointer px-4 py-4">
            <span className="inline-flex flex-wrap items-center gap-3 align-middle">
              <span className="font-mono text-sm font-medium">{node.name}</span>
              <Badge variant={node.ready ? "secondary" : "destructive"}>{node.ready ? "Ready" : "Not ready"}</Badge>
              {!node.schedulable && <Badge variant="outline">Unschedulable</Badge>}
              <span className="text-sm text-muted-foreground"><span className="font-mono">{formatNumber(node.freeTaskSlots)}</span> free node slots</span>
            </span>
          </summary>
          <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-4 pb-4 text-xs text-muted-foreground">
            <span>CPU requested: <span className="font-mono">{formatNumber(node.requested.cpuMillicores)} / {formatNumber(node.allocatable.cpuMillicores)}m</span></span>
            <span>Memory requested: <span className="font-mono">{formatBytes(node.requested.memoryBytes)} / {formatBytes(node.allocatable.memoryBytes)}</span></span>
            <span>Pod slots used: <span className="font-mono">{formatNumber(node.requested.pods)} / {formatNumber(node.allocatable.pods)}</span></span>
            {node.architecture && <span className="font-mono">{node.architecture}</span>}
            {node.kubeletVersion && <span className="font-mono">{node.kubeletVersion}</span>}
          </div>
          <PodList pods={node.pods} />
        </details>)}
      </div>
      {snapshot.pendingPods.length > 0 && <section className="overflow-hidden rounded-lg border border-border" aria-label="Unscheduled pods">
        <h2 className="px-4 py-4 text-sm font-semibold">Unscheduled pods</h2>
        <PodList pods={snapshot.pendingPods} />
      </section>}
    </>}
  </div>;
}
