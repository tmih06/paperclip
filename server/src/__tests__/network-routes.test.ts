import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { networkRoutes } from "../routes/network.js";
import { HttpError } from "../errors.js";

const snapshot = vi.hoisted(() => vi.fn());
vi.mock("../services/network.js", () => ({ networkService: () => ({ snapshot }) }));

function app(actor: Express.Request["actor"]) {
  const application = express();
  application.use((req, _res, next) => { req.actor = actor; next(); });
  application.use("/api", networkRoutes({} as never));
  application.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : String(error) });
  });
  return application;
}

const admin: Express.Request["actor"] = {
  type: "board", source: "session", userId: "user-1", isInstanceAdmin: true, companyIds: ["company-a"],
};

describe("company Network inventory route", () => {
  beforeEach(() => { snapshot.mockReset(); });

  it("requires authentication before reading any inventory", async () => {
    const res = await request(app({ type: "none", source: "none" })).get("/api/companies/company-a/network");
    expect(res.status).toBe(401);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("denies agent credentials, even within their own company", async () => {
    const res = await request(app({ type: "agent", source: "agent_key", agentId: "agent-a", companyId: "company-a" })).get("/api/companies/company-a/network");
    expect(res.status).toBe(403);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("requires instance-admin privileges for shared node inventory", async () => {
    const res = await request(app({ ...admin, isInstanceAdmin: false })).get("/api/companies/company-a/network");
    expect(res.status).toBe(403);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("requires access to the requested company even for an instance admin", async () => {
    const res = await request(app(admin)).get("/api/companies/company-b/network");
    expect(res.status).toBe(403);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("returns an on-demand no-store snapshot for the requested company", async () => {
    snapshot.mockResolvedValue({ companyId: "company-a", status: "connected", nodes: [] });
    const res = await request(app(admin)).get("/api/companies/company-a/network");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(snapshot).toHaveBeenCalledExactlyOnceWith("company-a");
    expect(res.body.companyId).toBe("company-a");
  });

  it("surfaces Kubernetes failures instead of reporting a healthy empty cluster", async () => {
    snapshot.mockRejectedValue(new HttpError(503, "The Kubernetes controller cannot inspect cluster nodes. Apply the updated controller RBAC."));
    const res = await request(app(admin)).get("/api/companies/company-a/network").expect(503);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("RBAC");
  });
});
