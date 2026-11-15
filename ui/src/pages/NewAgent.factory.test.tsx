// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { api, envApi, settings, state, container, settle, click, render } from "./NewAgent.test-support";

const image = `paperclip-agent@sha256:${"a".repeat(64)}`;
const model = "deploy/deepseek-ai/deepseek-v4.1-flash-1017";
const pool = (id = "pool", pinnedImage = image, defaultModel = model) => ({
  id, name: id, status: "active", driver: "sandbox", config: { provider: "ompig_factory", image: pinnedImage, model: defaultModel },
});
function configure() {
  state.adapters.push({ type: "ompig_factory", loaded: true, disabled: false });
  settings.get.mockResolvedValue({ defaultEnvironmentId: "pool" });
  envApi.list.mockResolvedValue([pool()]);
}

describe("new factory agent inherits its selected pool", () => {
  it("probes and hires with the same pinned image, model, and environment without model entry", async () => {
    configure(); await render("ompig_factory"); await settle();
    await click("Run test");
    expect(api.testEnvironment).toHaveBeenCalledWith("company-1", "ompig_factory", expect.objectContaining({
      adapterConfig: expect.objectContaining({ image, model }), environmentId: "pool",
    }));
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(container.textContent).toContain(model);
    expect(container.textContent).toContain(image);
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterConfig: expect.objectContaining({ image, model }), defaultEnvironmentId: "pool",
    }));
  });

  it("saves the inherited configuration and explicit pool on Save & exit", async () => {
    configure(); await render("ompig_factory"); await settle();
    await click("Save & exit");
    expect(api.update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      adapterConfig: expect.objectContaining({ image, model }), defaultEnvironmentId: "pool",
    }), "company-1");
  });

  it("switches image and model together when a different worker pool is selected", async () => {
    configure(); const nextImage = `paperclip-agent@sha256:${"b".repeat(64)}`;
    envApi.list.mockResolvedValue([pool(), pool("other-pool", nextImage, "other/model")]);
    await render("ompig_factory"); await settle();
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Environment"]')!;
    await act(async () => { select.value = "other-pool"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(); await settle();
    expect(api.update).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      defaultEnvironmentId: "other-pool", adapterConfig: expect.objectContaining({ image: nextImage, model: "other/model" }),
    }), "company-1");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      defaultEnvironmentId: "other-pool", adapterConfig: expect.objectContaining({ image: nextImage, model: "other/model" }),
    }));
  });

  it.each(["local", "wrong provider", "mutable image", "missing model"])("refuses %s before sending a probe or hire", async failure => {
    configure(); const invalid = pool();
    if (failure === "local") invalid.driver = "local";
    if (failure === "wrong provider") invalid.config.provider = "daytona";
    if (failure === "mutable image") invalid.config.image = "agent:latest";
    if (failure === "missing model") invalid.config.model = "";
    envApi.list.mockResolvedValue([invalid]);
    await render("ompig_factory"); await settle();
    await click("Run test");
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Docker Worker Pool|immutable agent image|default model/);
  });
});
