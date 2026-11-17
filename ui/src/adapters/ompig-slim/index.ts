import type { UIAdapterModule } from "../types";
import { buildOmpigSlimConfig, parseOmpigSlimStdoutLine } from "@paperclipai/adapter-ompig-slim/ui";
import { SchemaConfigFields } from "../schema-config-fields";
export const ompigSlimUIAdapter: UIAdapterModule = {
  type: "ompig_slim", label: "ompig-slim (durable)", parseStdoutLine: parseOmpigSlimStdoutLine,
  ConfigFields: SchemaConfigFields, buildAdapterConfig: buildOmpigSlimConfig,
};
