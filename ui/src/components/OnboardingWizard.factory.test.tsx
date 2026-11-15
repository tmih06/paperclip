// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard, ONBOARDING_STORAGE_KEY } from "./OnboardingWizard";

const mocks = vi.hoisted(() => ({
  options: { companyId: "company", initialStep: 3 } as { companyId?: string; initialStep?: number },
  navigate: vi.fn(), close: vi.fn(), select: vi.fn(), dismissed: vi.fn(),
  environments: vi.fn(), settings: vi.fn(), adapters: vi.fn(), probe: vi.fn(),
  create: vi.fn(), hire: vi.fn(), approve: vi.fn(), createCompany: vi.fn(),
}));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: "/" }), useNavigate: () => mocks.navigate }));
vi.mock("../context/DialogContext", () => ({ useDialog: () => ({ onboardingOpen: true, onboardingOptions: mocks.options,
  closeOnboarding: mocks.close, onboardingRouteDismissed: false, setOnboardingRouteDismissed: mocks.dismissed }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ companies: [{ id: "company", issuePrefix: "CO" }, { id: "other", issuePrefix: "OT" }],
  loading: false, setSelectedCompanyId: mocks.select }) }));
vi.mock("../api/companies-query", () => ({ useCompanyListQuery: () => ({ isSuccess: true, isFetching: false,
  data: { companies: [{ id: "company" }, { id: "other" }], unauthorized: false } }) }));
vi.mock("../api/companies", () => ({ companiesApi: { create: mocks.createCompany } }));
vi.mock("../api/agents", () => ({ agentsApi: { create: mocks.create, hire: mocks.hire } }));
vi.mock("../api/adapters", () => ({ adaptersApi: { list: mocks.adapters } }));
vi.mock("../api/approvals", () => ({ approvalsApi: { approve: mocks.approve } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: mocks.environments, probe: mocks.probe } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { get: mocks.settings } }));
vi.mock("../hooks/useCloudInstance", () => ({ useCloudInstance: () => null }));
vi.mock("./onboarding/OnboardingCharacter", () => ({ OnboardingCharacter: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const image = `ghcr.io/tmih06/developer@sha256:${"a".repeat(64)}`;
const pool = { id: "pool", driver: "sandbox", status: "active", config: { provider: "ompig_factory", image, model: "openai/example" } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let root: Root | null;
let container: HTMLDivElement;
let client: QueryClient;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render() {
  root ??= createRoot(container);
  await act(async () => { root!.render(<QueryClientProvider client={client}><OnboardingWizard /></QueryClientProvider>); });
  await settle();
}
async function name(value = "Developer") {
  const input = document.querySelector<HTMLInputElement>("#onboarding-agent-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function finish() {
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); root = null;
  mocks.options = { companyId: "company", initialStep: 3 };
  mocks.environments.mockResolvedValue([pool]); mocks.settings.mockResolvedValue({ defaultEnvironmentId: "pool" });
  mocks.adapters.mockResolvedValue([{ type: "ompig_factory", loaded: true, disabled: false }]);
  mocks.probe.mockResolvedValue({ ok: true });
  mocks.create.mockImplementation(async (companyId, payload) => ({ ...payload, companyId, id: payload.setupId }));
  mocks.hire.mockImplementation(async (_companyId, payload) => ({ agent: { ...payload, id: payload.setupAgentId }, approval: null }));
  mocks.approve.mockResolvedValue({});
  container = document.createElement("div"); document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; client.clear(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("name-only Docker agent onboarding", () => {
  it("shows only the agent name and Finish, with no provider, model, login or review picker", async () => {
    await render();
    expect(document.querySelectorAll("input")).toHaveLength(1);
    expect(document.querySelectorAll("[role=radio],select")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Claude|Codex|Connect a model|API key/);
    const finish = [...document.querySelectorAll("button")].find(button => button.textContent === "Finish")!;
    expect(finish.disabled).toBe(true);
    await name(); expect(finish.disabled).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.hire).not.toHaveBeenCalled();
  });
  it("finishes one governed factory hire directly from the name and lands on the dashboard", async () => {
    await render(); await name(); await finish();
    expect(mocks.probe).toHaveBeenCalledWith("pool", "company");
    expect(mocks.adapters).toHaveBeenCalledWith({ companyId: "company", environmentId: "pool" });
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.hire).toHaveBeenCalledTimes(1);
    expect(mocks.hire).toHaveBeenCalledWith("company", expect.objectContaining({
      name: "Developer", role: "general", adapterType: "ompig_factory", defaultEnvironmentId: "pool",
      adapterConfig: { image, model: "openai/example" }, setupAgentId: mocks.create.mock.calls[0][1].setupId,
      onboardingFirstAgent: true, runtimeConfig: expect.objectContaining({ heartbeat: expect.objectContaining({ enabled: true }) }),
    }));
    expect(mocks.navigate).toHaveBeenCalledWith("/CO/dashboard");
    expect(mocks.close).toHaveBeenCalledTimes(1); expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });
  it("preserves the board approval gate before finishing", async () => {
    mocks.hire.mockResolvedValue({ agent: { id: "agent" }, approval: { id: "approval" } });
    await render(); await name(); await finish();
    expect(mocks.approve).toHaveBeenCalledWith("approval", expect.any(String));
    expect(mocks.approve.mock.invocationCallOrder[0]).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]);
  });
  it.each(["environments", "settings", "adapters", "probe", "create", "hire", "approve"] as const)("surfaces %s failures and never reports completion", async stage => {
    if (stage === "approve") mocks.hire.mockResolvedValue({ agent: { id: "agent" }, approval: { id: "approval" } });
    mocks[stage].mockRejectedValue(new Error(`${stage} unavailable`));
    await render(); await name(); await finish();
    expect(document.querySelector("[role=alert]")?.textContent).toContain(`${stage} unavailable`);
    expect(mocks.navigate).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each(["missing pool", "unready pool", "disabled adapter", "unloaded adapter"])("fails closed with %s rather than using Local", async failure => {
    if (failure === "missing pool") mocks.environments.mockResolvedValue([{ ...pool, driver: "local" }]);
    if (failure === "unready pool") mocks.probe.mockResolvedValue({ ok: false });
    if (failure === "disabled adapter") mocks.adapters.mockResolvedValue([{ type: "ompig_factory", loaded: true, disabled: true }]);
    if (failure === "unloaded adapter") mocks.adapters.mockResolvedValue([{ type: "ompig_factory", loaded: false, disabled: false }]);
    await render(); await name(); await finish();
    expect(document.querySelector("[role=alert]")).not.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.hire).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("suppresses simultaneous submissions while a worker probe is in flight", async () => {
    const probe = deferred<{ ok: boolean }>(); mocks.probe.mockReturnValue(probe.promise);
    await render(); await name(); await finish(); await finish();
    expect(mocks.probe).toHaveBeenCalledTimes(1); expect(mocks.hire).not.toHaveBeenCalled();
    await act(async () => { probe.resolve({ ok: true }); }); await settle();
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.hire).toHaveBeenCalledTimes(1);
  });
  it("retries a failed hire using the same persisted setup id", async () => {
    mocks.hire.mockRejectedValueOnce(new Error("Retry me"));
    await render(); await name(); await finish();
    const setupId = mocks.create.mock.calls[0][1].setupId;
    expect(JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY)!).setupAgentId).toBe(setupId);
    await finish();
    expect(mocks.create.mock.calls[1][1].setupId).toBe(setupId);
    expect(mocks.hire.mock.calls[1][1].setupAgentId).toBe(setupId);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
  it.each(["claude_local", "codex_local", "paperclip_runner", "ompig_factory"])("converts a saved %s draft into the name-only factory path", async adapterType => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ step: 4, createdCompanyId: "company", adapterType, agentName: "Recovered", setupAgentId: "held-agent" }));
    await render(); await finish();
    expect(mocks.create.mock.calls[0][1].setupId).toBe("held-agent");
    expect(mocks.hire.mock.calls[0][1]).toMatchObject({ adapterType: "ompig_factory", name: "Recovered" });
    expect(mocks.navigate).toHaveBeenCalledWith("/CO/dashboard");
  });
  it.each(["company change", "unmount"])("does not create or hire after %s during a worker probe", async change => {
    const probe = deferred<{ ok: boolean }>(); mocks.probe.mockReturnValue(probe.promise);
    await render(); await name(); await finish();
    if (change === "unmount") { await act(async () => root!.unmount()); root = null; }
    else { mocks.options = { companyId: "other", initialStep: 3 }; await render(); }
    await act(async () => { probe.resolve({ ok: true }); }); await settle();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.hire).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
