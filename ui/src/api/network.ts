import type { NetworkSnapshot } from "@paperclipai/shared";
import { api } from "./client";

export const networkApi = {
  get: (companyId: string) =>
    api.get<NetworkSnapshot>(`/companies/${encodeURIComponent(companyId)}/network`),
};
