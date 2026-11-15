import type { Environment } from "@paperclipai/shared";

export const FACTORY_ADAPTER_TYPE = "ompig_factory";

/** A fork-wide default, never a fallback to the control-plane host. */
export function factoryOnboardingDefaults(environments: Environment[], defaultEnvironmentId: string | null) {
  const pools = environments.filter(environment => environment.status === "active"
    && environment.driver === "sandbox" && environment.config.provider === FACTORY_ADAPTER_TYPE);
  const environment = pools.find(pool => pool.id === defaultEnvironmentId)
    ?? (pools.length === 1 ? pools[0] : undefined);
  if (!environment) throw new Error("Configure a Docker Worker Pool in Settings → Environments and set it as the instance default before creating an agent.");
  const { image, model } = environment.config;
  if (typeof image !== "string" || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error("Set an immutable agent image digest on the default Docker Worker Pool before creating an agent.");
  }
  if (typeof model !== "string" || !model.trim().includes("/")) {
    throw new Error("Set the default model (provider/model) on the Docker Worker Pool before creating an agent.");
  }
  return { environmentId: environment.id, adapterConfig: { image, model: model.trim() } };
}
