import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { networkService } from "../services/network.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

export function networkRoutes(db: Db) {
  const router = Router();
  const service = networkService(db);

  router.get("/companies/:companyId/network", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Node inventory and global resource reservations describe shared infrastructure.
    assertInstanceAdmin(req);
    res.set("Cache-Control", "no-store");
    res.json(await service.snapshot(companyId));
  });

  return router;
}
