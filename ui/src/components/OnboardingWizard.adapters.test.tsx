import type { Environment } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { factoryOnboardingDefaults } from "../lib/factory-onboarding";

const image = `ghcr.io/tmih06/agent@sha256:${"a".repeat(64)}`;
const pool = (id = "pool", config = {}): Environment => ({
  id, name: id, description: null, driver: "sandbox", status: "active",
  config: { provider: "ompig_factory", image, model: "openai/example", ...config },
  envVars: {}, metadata: null, createdAt: new Date(0), updatedAt: new Date(0),
});

describe("Docker-only onboarding defaults", () => {
  it("uses the configured worker pool, image and model without choosing a provider", () => {
    expect(factoryOnboardingDefaults([pool()], "pool")).toEqual({ environmentId: "pool", adapterConfig: { image, model: "openai/example" } });
  });
  it("uses the sole factory pool when the instance still defaults to Local", () => {
    expect(factoryOnboardingDefaults([pool(), { ...pool("local"), driver: "local" }], "local").environmentId).toBe("pool");
  });
  it("honors an explicit factory default among several pools", () => {
    expect(factoryOnboardingDefaults([pool("one"), pool("two")], "two").environmentId).toBe("two");
  });
  it("refuses to choose an arbitrary worker pool", () => {
    expect(() => factoryOnboardingDefaults([pool("one"), pool("two")], null)).toThrow("set it as the instance default");
  });
  it.each([[], [{ ...pool(), driver: "local" }], [{ ...pool(), status: "disabled" }], [pool("other", { provider: "daytona" })]].map(environments => [environments]))(
    "never falls back to an incompatible or missing environment (%j)", environments => {
      expect(() => factoryOnboardingDefaults(environments as Environment[], null)).toThrow("Configure a Docker Worker Pool");
    },
  );
  it.each(["repo:latest", "repo@sha256:short", ""]) ("rejects a mutable/missing image: %s", image => {
    expect(() => factoryOnboardingDefaults([pool("pool", { image })], "pool")).toThrow("immutable agent image");
  });
  it.each([undefined, "", "model-without-provider"]) ("requires an admin-configured model: %s", model => {
    expect(() => factoryOnboardingDefaults([pool("pool", { model })], "pool")).toThrow("default model");
  });
});
