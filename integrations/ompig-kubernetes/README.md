# Ompig on Paperclip Kubernetes sandboxes

This integration uses only Paperclip's existing `pi_local` adapter and its
first-party Kubernetes sandbox provider. It does not add a Paperclip adapter,
server code, UI code, scheduler, or Docker worker pool.

The image is a compatibility runtime: it exposes `ompig-paperclip` as the
command used by the existing Pi adapter, while the Kubernetes provider creates
one Sandbox CR and one pod per Paperclip run. The pod is deleted when the lease
is released.

## Image

Build the runtime from the already-pinned Ompig image:

```sh
docker build -f integrations/ompig-kubernetes/Dockerfile.agent \
  --build-arg BASE_IMAGE=paperclip-ompig-factory:local \
  -t ghcr.io/tmih06/agent-runtime-pi:v1 integrations/ompig-kubernetes
```

Push it to the registry used by the Paperclip Kubernetes provider. Keep the
published image immutable and configure a digest-pinned registry mirror in the
provider's `adapters.pi_local.runtimeImage`.

## Kubernetes provider configuration

Install Paperclip's existing provider and the `agent-sandbox` controller, then
configure one sandbox environment with the shape below. The provider's
`adapters` registry is a configuration extension; `adapterType` remains the
existing `pi_local` adapter.

```json
{
  "driver": "sandbox",
  "config": {
    "inCluster": true,
    "backend": "sandbox-cr",
    "namespacePrefix": "paperclip-",
    "adapterType": "pi_local",
    "adapters": [
      {
        "adapterType": "pi_local",
        "runtimeImage": "ghcr.io/tmih06/agent-runtime-pi@sha256:<digest>",
        "envKeys": ["OMPIG_BROKER_TOKEN"],
        "allowFqdns": ["api-sf1.deploy.com"],
        "probeCommand": ["ompig-paperclip", "--version"],
        "defaultEnv": {
          "OMPIG_BROKER_URL": "https://broker.example.internal"
        }
      }
    ],
    "egressMode": "standard"
  }
}
```

`OMPIG_BROKER_TOKEN` must be present in the Paperclip provider worker's secret
environment. The Kubernetes provider copies only the declared key into the
per-run Secret; it is not put in the image or lease metadata. Configure the
agent's existing `pi_local` command as `ompig-paperclip` and its model as
`deploy/deepseek-ai/deepseek-v4.1-flash-1017`.

The cluster must allow Paperclip-server to create and delete tenant resources.
Use a deny-all baseline plus the provider's per-run egress policy. Do not put a
Docker socket in the pod.
