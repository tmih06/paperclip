import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";
import { useLocation, useNavigate } from "@/lib/router";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useCompanyListQuery } from "../api/companies-query";
import { companiesApi } from "../api/companies";
import { agentsApi } from "../api/agents";
import { adaptersApi } from "../api/adapters";
import { approvalsApi } from "../api/approvals";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { onboardingDraftStorage, restoreOnboardingState } from "../lib/onboarding-state";
import { factoryOnboardingDefaults, FACTORY_ADAPTER_TYPE } from "../lib/factory-onboarding";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import { DEFAULT_AGENT_ROLE } from "../lib/onboarding-agent-role";
import { companyPrefixFromOnboardingPath, resolveRouteOnboardingOptions } from "../lib/onboarding-route";
import { useCloudInstance } from "../hooks/useCloudInstance";
import { OnboardingCharacter } from "./onboarding/OnboardingCharacter";

export { ONBOARDING_STORAGE_KEY } from "../lib/onboarding-state";

export function OnboardingWizard() {
  // Deliberately does not call `useCompany()`. The list it exposes is the
  // shared cache, which is what this gate must not trust - see below.

  // Parsed once (not re-parsed by the cleanup effect below) so the restored
  // value and the "should we wipe the blob" decision always agree.
  const rawBlob = useMemo(() => {
    const raw = onboardingDraftStorage.read();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null; // malformed: treated as stale below
    }
  }, []);
  // The ownership gate is closed after the initial validation succeeds, or
  // when no validation is needed. A later company-list invalidation is
  // ordinary background work. If it unmounted the inner wizard then, all of
  // its live useState values would be reconstructed from `rawBlob` above —
  // the value from page load, not the draft the customer just typed — and a
  // successful organization submission would appear to do nothing.
  //
  // A failed validation must remain retryable. A later successful fetch needs
  // to remount the wizard with the now-authorized draft, rather than keeping
  // the defaults it showed while ownership was unknown.
  const [initialDraftValidationComplete, setInitialDraftValidationComplete] = useState(
    rawBlob === undefined || rawBlob === null,
  );

  // Whether this account owns the company the draft names is an authorization
  // question, and the answer has to be about the account asking now.
  //
  // The shared company cache could not answer it at all: one entry for every
  // account, served for thirty seconds after a switch with no loading state and
  // no error, so a check that trusted "not loading, no error" handed one
  // account's draft to the next. The entry is keyed by account now, and that
  // trap is gone with it.
  //
  // What survives is smaller and still worth a request. A cached list is the
  // right account's but can be thirty seconds old, so a company created moments
  // ago in another tab is missing from it — and missing reads as "you do not own
  // this", which deletes the draft rather than withholding it. So this still
  // asks for a list fetched for this mount.
  const companiesQuery = useCompanyListQuery({
    staleTime: 0,
    // Only a *parseable* saved draft poses the question. Without one there is
    // nothing to authorize, and this must not add a request to every wizard
    // mount - nor make the cleanup of unreadable junk wait on an endpoint that
    // has no bearing on whether it is junk.
    enabled: rawBlob !== undefined && rawBlob !== null,
  });

  // Decidable only with a list that succeeded, actually arrived, and that the
  // server was willing to give us.
  //
  // Whose list it is stopped being a question here: the entry is keyed by
  // account, so the previous account's list is unreachable rather than merely
  // rejected. What the checks still answer is whether there is an answer at all,
  // and the reason that matters is the *destructive* branch below — an
  // undecidable draft is withheld and recoverable, but a draft judged
  // not-yours is deleted.
  //
  // `isSuccess`: React Query keeps the last good `data` through a failed
  // refetch, and a retained list is not evidence about now.
  //
  // `staleTime: 0` on the query, still: a cached list is the right account's but
  // can be thirty seconds old, and a company created moments ago in another tab
  // would be missing from it — which reads as "this draft belongs to a company
  // you do not own" and deletes it.
  //
  // `unauthorized`: the query folds 401 and 403 into
  // `{ companies: [], unauthorized: true }` rather than throwing, so an auth
  // blip arrives as a *successful* fetch of an empty list and would otherwise
  // read as "this account owns nothing" and delete the draft.
  const ownershipDecidable =
    companiesQuery.isSuccess &&
    companiesQuery.data !== undefined &&
    !companiesQuery.data.unauthorized;

  const { saved, staleStateDetected } = useMemo(() => {
    if (rawBlob === undefined) return { saved: null, staleStateDetected: false };
    // Unreadable, so junk regardless of who owns what. Judged before the
    // ownership check rather than after it, so clearing it does not wait on a
    // company request that cannot change the answer.
    if (rawBlob === null) return { saved: null, staleStateDetected: true };
    // Not decidable yet, or not decidable at all. Either way: restore nothing,
    // delete nothing. A draft withheld is recoverable on the next load; a
    // draft deleted, or one handed to the wrong account, is not.
    if (!ownershipDecidable) return { saved: null, staleStateDetected: false };
    const restored = restoreOnboardingState(rawBlob, companiesQuery.data!.companies);
    return { saved: restored, staleStateDetected: restored === null };
  }, [rawBlob, ownershipDecidable, companiesQuery.data]);

  // A discarded/malformed state should not sit in storage waiting to confuse
  // the next onboarding attempt (e.g. a different signed-in user).
  useEffect(() => {
    if (!staleStateDetected) return;
    onboardingDraftStorage.clear();
  }, [staleStateDetected]);

  // A saved blob exists and its *initial* verification fetch is still in
  // flight: wait, rather than mount the inner wizard with a premature and
  // unrecoverable guess at the draft. Its ~20 `useState(saved?.x ?? default)`
  // initializers only read `saved` once. After that first mount this is a
  // background refetch, which must not tear down the customer's live state.
  //
  // `isFetching`, not `isLoading`. `isLoading` is false whenever the cache
  // holds retained data, so a refetch over a warm cache would mount the wizard
  // while ownership was still undecidable - and with the wizard open, the
  // persist effect would overwrite the customer's own draft with defaults
  // before the answer arrived. `isFetching` covers the refetch too.
  //
  // While in flight, not on failure. The companies query sets `retry: false`,
  // so a failed fetch stays failed; and with no companies the dashboard offers
  // a "Get Started" button wired to onboarding, which a gate that returned null
  // here would make do nothing at all.
  //
  // Mounting does not cost the draft. The persist effect that would overwrite
  // it is itself gated on `effectiveOnboardingOpen`, so a mounted-but-closed
  // wizard writes nothing. If the wizard is open the customer is onboarding
  // right now, which supersedes the draft anyway.
  const waitForInitialDraftValidation =
    !initialDraftValidationComplete && rawBlob !== undefined && companiesQuery.isFetching;

  useEffect(() => {
    if (
      !initialDraftValidationComplete &&
      ownershipDecidable &&
      !companiesQuery.isFetching
    ) {
      setInitialDraftValidationComplete(true);
    }
  }, [initialDraftValidationComplete, ownershipDecidable, companiesQuery.isFetching]);

  if (waitForInitialDraftValidation) {
    return null;
  }

  return <OnboardingWizardInner saved={saved} />;
}

function OnboardingWizardInner({ saved }: { saved: Record<string, unknown> | null }) {
  const { onboardingOpen, onboardingOptions, closeOnboarding,
    onboardingRouteDismissed: routeDismissed, setOnboardingRouteDismissed: setRouteDismissed } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cloudInstance = useCloudInstance();
  const companyPrefix = companyPrefixFromOnboardingPath(location.pathname);
  const routeOptions = companyPrefix && companiesLoading ? null : resolveRouteOnboardingOptions({
    pathname: location.pathname, companyPrefix, companies, cloudManaged: Boolean(cloudInstance),
  });
  const open = onboardingOpen || (routeOptions !== null && !routeDismissed);
  const requestedCompanyId = (onboardingOpen ? onboardingOptions : routeOptions)?.companyId ?? null;
  const [companyId, setCompanyId] = useState<string | null>(requestedCompanyId ?? (typeof saved?.createdCompanyId === "string" ? saved.createdCompanyId : null));
  const [companyName, setCompanyName] = useState(typeof saved?.companyName === "string" ? saved.companyName : "");
  const [agentName, setAgentName] = useState(typeof saved?.agentName === "string" ? saved.agentName : "");
  const [appearance, setAppearance] = useState(() => agentAppearanceSchema.safeParse(saved?.agentAppearance).data ?? randomAgentAppearance());
  const [setupId, setSetupId] = useState<string | null>(typeof saved?.setupAgentId === "string" ? saved.setupAgentId : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const completed = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const openRef = useRef(open);
  openRef.current = open;
  const currentCompanyId = useRef(companyId);
  currentCompanyId.current = companyId;
  const currentRequest = useRef({ open: false, companyId: requestedCompanyId });
  const routeOwnsCompany = useRef(Boolean(requestedCompanyId));

  // Only a new open/company request can replace an in-progress name. Refetching
  // companies must not reset the form, and navigation must never reuse another company's setup id.
  useEffect(() => {
    const previous = currentRequest.current;
    currentRequest.current = { open, companyId: requestedCompanyId };
    if (!open || (previous.open && previous.companyId === requestedCompanyId)) return;
    completed.current = false;
    if (requestedCompanyId && requestedCompanyId !== currentCompanyId.current) {
      currentCompanyId.current = requestedCompanyId;
      setCompanyId(requestedCompanyId);
      setAgentName(""); setSetupId(null); setError(null);
      setAppearance(randomAgentAppearance());
    } else if (!requestedCompanyId && routeOwnsCompany.current) {
      currentCompanyId.current = null;
      setCompanyId(null); setCompanyName(""); setAgentName(""); setSetupId(null); setError(null);
    }
    routeOwnsCompany.current = Boolean(requestedCompanyId);
  }, [open, requestedCompanyId]);

  useEffect(() => {
    if (!open || completed.current) return;
    onboardingDraftStorage.write(JSON.stringify({ step: companyId ? 3 : 1, companyName, agentName,
      agentAppearance: appearance, createdCompanyId: companyId, setupAgentId: setupId,
      adapterType: FACTORY_ADAPTER_TYPE }));
  }, [open, companyId, companyName, agentName, appearance, setupId]);

  function close() {
    closeOnboarding();
    setRouteDismissed(true);
  }

  async function finish() {
    if (busy.current || !(companyId ? agentName.trim() : companyName.trim())) return;
    busy.current = true; setLoading(true); setError(null);
    const companyAtStart = companyId;
    const stillCurrent = () => mounted.current && openRef.current && currentCompanyId.current === companyAtStart;
    try {
      if (!companyAtStart) {
        const company = await companiesApi.create({ name: companyName.trim() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
        // Company-list refreshes can adopt our new company before this request returns.
        if (!mounted.current || !openRef.current) return;
        if (currentCompanyId.current !== null && currentCompanyId.current !== company.id) {
          setError("Organization created, but onboarding switched to another organization.");
          return;
        }
        currentCompanyId.current = company.id;
        setCompanyId(company.id);
        setSelectedCompanyId(company.id, { source: "route_sync" });
        return;
      }
      const [environments, settings] = await Promise.all([
        environmentsApi.list(companyAtStart), instanceSettingsApi.get(),
      ]);
      const defaults = factoryOnboardingDefaults(environments, settings.defaultEnvironmentId);
      const adapters = await adaptersApi.list({ companyId: companyAtStart, environmentId: defaults.environmentId });
      if (!adapters.some(adapter => adapter.type === FACTORY_ADAPTER_TYPE && adapter.loaded && !adapter.disabled)) {
        throw new Error("Install and enable the ompig Docker Factory adapter before creating an agent.");
      }
      const probe = await environmentsApi.probe(defaults.environmentId, companyAtStart);
      if (!probe.ok) throw new Error("The default Docker Worker Pool is not ready. Check its workers and pinned image in Settings → Environments.");
      if (!stillCurrent()) return;
      const id = setupId ?? crypto.randomUUID();
      setSetupId(id);
      // Setup IDs are server-side idempotency keys. A failed hire resumes this
      // same held agent, including across reloads, rather than hiring a duplicate.
      const setup = await agentsApi.create(companyAtStart, {
        setupId: id, name: agentName.trim(), appearance, role: DEFAULT_AGENT_ROLE,
        adapterType: FACTORY_ADAPTER_TYPE, adapterConfig: defaults.adapterConfig,
        defaultEnvironmentId: defaults.environmentId, onboardingFirstAgent: true,
        runtimeConfig: buildNewAgentRuntimeConfig({ heartbeatEnabled: false }),
      });
      if (!stillCurrent()) return;
      const hire = await agentsApi.hire(companyAtStart, {
        setupAgentId: setup.id, name: setup.name, appearance: setup.appearance, role: setup.role,
        adapterType: FACTORY_ADAPTER_TYPE, adapterConfig: defaults.adapterConfig,
        defaultEnvironmentId: defaults.environmentId, onboardingFirstAgent: true,
        runtimeConfig: buildNewAgentRuntimeConfig({ heartbeatEnabled: true }),
      });
      if (!stillCurrent()) return;
      // Keep the normal governed hire path and the board's explicit approval API.
      if (hire.approval) {
        await approvalsApi.approve(hire.approval.id, "Approved during onboarding first-agent setup.");
        void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyAtStart) });
      }
      if (!stillCurrent()) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyAtStart) });
      setSelectedCompanyId(companyAtStart, { source: "route_sync" });
      completed.current = true;
      onboardingDraftStorage.clear();
      close();
      const prefix = companies.find(company => company.id === companyAtStart)?.issuePrefix;
      navigate(prefix ? `/${prefix}/dashboard` : "/dashboard");
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : "Could not finish Docker agent setup.");
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  if (!open) return null;
  return <Dialog open onOpenChange={value => { if (!value && !loading) close(); }}>
    <DialogPortal>
      <div data-testid="onboarding-wizard" className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background">
        <form className="flex w-(--sz-560px) max-w-full flex-col gap-6 px-8 py-10 sm:px-10 sm:py-11"
          onSubmit={event => { event.preventDefault(); void finish(); }}
          onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void finish(); } }}>
          {companyId && <OnboardingCharacter appearance={appearance} awake={false} />}
          <h1 className="text-center text-2xl font-semibold">{companyId ? "Create your first agent" : "What is the name of your organization?"}</h1>
          {companyId && <p className="text-sm text-muted-foreground">Name your agent. It will use your default Docker worker pool, agent image, and model. No provider sign-in or runtime selection.</p>}
          <div className="flex flex-col gap-2">
            <Label htmlFor={companyId ? "onboarding-agent-name" : "onboarding-company-name"}>{companyId ? "Agent name" : "Organization name"}</Label>
            <Input id={companyId ? "onboarding-agent-name" : "onboarding-company-name"}
              value={companyId ? agentName : companyName} autoFocus disabled={loading}
              onChange={event => companyId ? setAgentName(event.target.value) : setCompanyName(event.target.value)} />
          </div>
          {error && <div role="alert" className="text-sm text-destructive">
            <p>{error}</p>
            <a className="underline" href="/company/settings/instance/environments">Open environment settings</a>
          </div>}
          <div className="flex items-center justify-between">
            <Button type="button" variant="ghost" disabled={loading} onClick={close}>Save & exit</Button>
            <Button type="submit" disabled={loading || !(companyId ? agentName.trim() : companyName.trim())}>
              {loading ? (companyId ? "Creating agent…" : "Creating organization…") : companyId ? "Finish" : "Continue"}
            </Button>
          </div>
        </form>
      </div>
    </DialogPortal>
  </Dialog>;
}
