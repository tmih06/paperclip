import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createProvider } from "./provider.mjs";

const plugin = definePlugin({
  async setup(ctx) { ctx.logger.info("ompig Docker worker-pool provider ready"); },
  ...createProvider(),
});
export default plugin;
runWorker(plugin, import.meta.url);
