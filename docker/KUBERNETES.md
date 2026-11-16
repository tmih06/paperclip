# Paperclip with Kubernetes task isolation

Runs a published Paperclip image on Docker Compose and executes every agent
task in its own Kubernetes pod. Nothing is built locally.

## Prerequisites

- Docker with Compose v2.24+ (needs the `!reset`/`!override` tags)
- `kind`, `kubectl`, `gh`
- A Paperclip release that publishes a `-cloud` image. Defaults to
  `ghcr.io/tmih06/paperclip:2026.1114.1-cloud`; override with
  `PAPERCLIP_IMAGE`.

Run every command below from the repository root.

## 1. Create the cluster

```sh
kind create cluster --name paperclip
```

The cluster must expose its API on a Docker network the Paperclip container
joins, because that container plays the role of an in-cluster controller.

### Cluster add-ons

Agent pods are `Sandbox` resources, so the sandbox controller and its CRD are
required. Pin the controller version the release's plugin supports — as of
`0.1.0-alpha.1` that is `v1alpha1`:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.6/manifest.yaml
```

Network policies need an enforcing CNI; kind's default does not enforce them:

```sh
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.30.5/manifests/calico-policy-only.yaml
```

Two Calico fixes are needed on kind. Calico 3.30 writes the service VIP as
`https://[10.96.0.1]:443`, which its client rejects; and its CNI service
account is not bound to the node role.

```sh
kubectl -n kube-system set env daemonset/calico-node \
  KUBERNETES_SERVICE_HOST=10.96.0.1 KUBERNETES_SERVICE_PORT=443
kubectl create clusterrolebinding calico-cni \
  --clusterrole=calico-node \
  --serviceaccount=kube-system:calico-cni-plugin
```

The bracketed-VIP fix must survive restarts, so add it as an init container:

```sh
cat > /tmp/calico-fix.json <<'JSON'
[{"op":"add","path":"/spec/template/spec/initContainers/-","value":{
  "name":"fix-ipv4-kubeconfig","image":"busybox:1.37",
  "command":["sh","-c","sed -i 's/https:\\/\\/[10.96.0.1]:443/https:\\/\\/10.96.0.1:443/g' /host/etc/cni/net.d/calico-kubeconfig"],
  "securityContext":{"runAsUser":0},
  "volumeMounts":[{"name":"cni-net-dir","mountPath":"/host/etc/cni/net.d"}]}}]
JSON
kubectl -n kube-system patch daemonset calico-node \
  --type=json --patch-file=/tmp/calico-fix.json
kubectl rollout status daemonset/calico-node -n kube-system
```

## 2. Give the controller credentials

Paperclip calls the Kubernetes API from inside a container, using a
service-account token mounted the way an in-cluster pod would see it.

```sh
kubectl create namespace paperclip-system
kubectl -n paperclip-system create serviceaccount paperclip-controller
sed 's/^  name: paperclip-controller-local$/  name: paperclip-controller-local/' \
  docker/kubernetes-controller-rbac.yml | kubectl apply -f -

kubectl -n paperclip-system apply -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: paperclip-controller-token
  annotations:
    kubernetes.io/service-account.name: paperclip-controller
type: kubernetes.io/service-account-token
YAML

mkdir -p docker/kubernetes-local/serviceaccount
kubectl -n paperclip-system get secret paperclip-controller-token \
  -o jsonpath='{.data.ca\.crt}' | base64 -d \
  > docker/kubernetes-local/serviceaccount/ca.crt
kubectl -n paperclip-system get secret paperclip-controller-token \
  -o jsonpath='{.data.token}' | base64 -d \
  > docker/kubernetes-local/serviceaccount/token
printf 'paperclip-system' > docker/kubernetes-local/serviceaccount/namespace
chmod 700 docker/kubernetes-local
chmod 644 docker/kubernetes-local/serviceaccount/*
```

`docker/kubernetes-controller-rbac.yml` grants the controller the namespaces,
pods, exec, secrets, jobs, network policies and `Sandbox` access it needs. Task
pods get none of it.

## 3. Unpack the Kubernetes plugin from the same release

The cloud image does not ship the Kubernetes provider, so install the published
plugin package next to it. It depends on the matching `plugin-sdk` and `shared`
packages from the same release.

```sh
mkdir -p docker/kubernetes-local/package
gh release download v2026.1114.1 \
  --pattern 'tmih06-plugin-kubernetes-*.tgz' \
  --pattern 'tmih06-plugin-sdk-*.tgz' \
  --pattern 'tmih06-shared-*.tgz' \
  --dir docker/kubernetes-local
tar -xzf docker/kubernetes-local/tmih06-plugin-kubernetes-*.tgz \
  --strip-components=1 -C docker/kubernetes-local/package
mkdir -p docker/kubernetes-local/package/vendor/sdk docker/kubernetes-local/package/vendor/shared
tar -xzf docker/kubernetes-local/tmih06-plugin-sdk-*.tgz \
  --strip-components=1 -C docker/kubernetes-local/package/vendor/sdk
tar -xzf docker/kubernetes-local/tmih06-shared-*.tgz \
  --strip-components=1 -C docker/kubernetes-local/package/vendor/shared
```

The published manifest points dependencies at the fork's npm registry. Point
them at the unpacked copies instead, and install the public runtime deps:

```sh
docker run --rm -v "$PWD/docker/kubernetes-local/package:/plugin" \
  --entrypoint sh "$PAPERCLIP_IMAGE" -c '
    set -e
    cd /plugin
    node -e "
      const fs = require(\"fs\");
      const j = JSON.parse(fs.readFileSync(\"package.json\"));
      delete j.dependencies[\"@paperclipai/plugin-sdk\"];
      fs.writeFileSync(\"package.json\", JSON.stringify(j, null, 2));
    "
    npm install --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
    mkdir -p node_modules/@paperclipai
    ln -sf ../../vendor/sdk node_modules/@paperclipai/plugin-sdk
    ln -sf ../../vendor/shared node_modules/@paperclipai/shared
    mkdir -p vendor/sdk/node_modules/@paperclipai vendor/shared/node_modules
    ln -sf ../../../node_modules/zod vendor/sdk/node_modules/zod
    ln -sf ../../../node_modules/zod vendor/shared/node_modules/zod
    ln -sf ../../../node_modules/three vendor/shared/node_modules/three
    ln -sf ../../../../vendor/shared vendor/sdk/node_modules/@paperclipai/shared
  '
```

### Drop the native sync hooks

This plugin release transfers files natively, but native sync requires a
workspace root that Paperclip's setup probe has not created yet, so probing
fails. Disabling the two optional hooks leaves Core's supported exec-based
transfer, which works for setup and for tasks:

```sh
cat > docker/kubernetes-local/package/compatibility-worker.js <<'JS'
import { runWorker } from "@paperclipai/plugin-sdk";
import plugin from "./dist/plugin.js";

delete plugin.definition.onEnvironmentSyncIn;
delete plugin.definition.onEnvironmentSyncOut;

export default plugin;
runWorker(plugin, import.meta.url);
JS

cat > docker/kubernetes-local/package/compatibility-manifest.js <<'JS'
import manifest from "./dist/manifest.js";
export default {
  ...manifest,
  entrypoints: { ...manifest.entrypoints, worker: "./compatibility-worker.js" },
};
JS

docker run --rm -v "$PWD/docker/kubernetes-local/package:/plugin" \
  --entrypoint node "$PAPERCLIP_IMAGE" -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync("/plugin/package.json"));
    j.paperclipPlugin = {
      manifest: "./compatibility-manifest.js",
      worker: "./compatibility-worker.js",
    };
    fs.writeFileSync("/plugin/package.json", JSON.stringify(j, null, 2));
  '
```

## 4. Point harnesses at a real image

`docker/kubernetes-adapters.json` is the adapter registry the sandbox uses. The
default upstream images (`ghcr.io/paperclipai/agent-runtime-*:v1`) are not
published, so this file reuses the app image, which already contains the
harnesses. Change the image or add entries for the harnesses you run.

The image has to be present on the cluster nodes. For kind:

```sh
docker pull "$PAPERCLIP_IMAGE"
docker save --platform linux/arm64 "$PAPERCLIP_IMAGE" \
  | docker exec -i paperclip-control-plane \
      ctr --namespace=k8s.io images import --platform linux/arm64 \
      --snapshotter=overlayfs -
```

Use `linux/amd64` on x86 hosts.

## 5. Configure and start

```sh
cat >> docker/.env <<EOF
PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -hex 32)
PAPERCLIP_K8S_EGRESS_ALLOW_CIDRS=<comma-separated IPv4 CIDRs>
EOF
chmod 600 docker/.env

docker compose --env-file docker/.env \
  -f docker/docker-compose.yml -f docker/docker-compose.kubernetes.yml \
  up -d --no-build --wait
```

Open <http://localhost:3100>, sign up, claim the instance, and configure an AI
account.

### Egress

Agent pods are default-deny. `PAPERCLIP_K8S_EGRESS_ALLOW_CIDRS` must reach the
controller and whatever the harness talks to. Standard `NetworkPolicy` cannot
match hostnames, so provider hostnames have to be expressed as CIDRs, and those
CIDRs are allowed on every port. For public providers, allow public IPv4 while
excluding private, loopback and link-local ranges, then add the controller's
address on the cluster network.

The values for this repository's default layout, where the container is
`172.18.0.3`:

```sh
python3 - <<'PY' > /tmp/egress.txt
import ipaddress
nets = [ipaddress.ip_network("0.0.0.0/0")]
for cidr in ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
             "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3"]:
    excluded = ipaddress.ip_network(cidr)
    nets = [part for net in nets
            for part in (net.address_exclude(excluded) if excluded.subnet_of(net) else [net])]
print(",".join(map(str, nets)) + ",172.18.0.3/32")
PY
```

That is broad: it permits public Internet on all ports. Use `egressMode:
"cilium"` in the environment config for exact FQDN allow-listing.

### Overridable values

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_IMAGE` | `ghcr.io/tmih06/paperclip:2026.1114.1-cloud` | App and task image |
| `PAPERCLIP_K8S_NETWORK` | `kind` | Docker network shared with the cluster |
| `PAPERCLIP_K8S_API_HOST` | `paperclip-control-plane` | Cluster API address |
| `PAPERCLIP_SERVER_IP` | `172.18.0.3` | Container's fixed address |

If your Docker network uses a different subnet, change `PAPERCLIP_SERVER_IP`
and the `172.18.0.3/32` egress entry together, and pass that address in
`PAPERCLIP_ALLOWED_HOSTNAMES` (the overlay already does).

## Verifying

```sh
docker compose --env-file docker/.env \
  -f docker/docker-compose.yml -f docker/docker-compose.kubernetes.yml ps
kubectl get pods -A
```

Then assign a task to an agent and confirm a pod appears for the run:

```sh
kubectl get pods -A -l paperclip.io/role=agent -w
```

A passing run shows the marker file the agent was asked to write, with pod
identity `uid=1000`. No task executes on the host.

## Security notes

- Task pods: UID 1000, read-only root filesystem, all capabilities dropped, no
  Kubernetes service-account token, own ephemeral workspace, home and tmp.
- One namespace, quota, and network-policy set per company; one Sandbox, pod,
  and secret per leased run. A lease can serve continuations, so a pod is per
  run, not necessarily per message.
- Pods share the host kernel. This is container isolation, not a VM boundary.
- Do not publish the cluster API port or PostgreSQL. The compose overlay keeps
  the database private.
- The controller token in `docker/kubernetes-local` is cluster-admin equivalent
  under the provided RBAC. Treat it as a secret.
