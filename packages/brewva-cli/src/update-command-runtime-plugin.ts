import { buildBrewvaUpdatePrompt } from "@brewva/brewva-gateway";
import {
  defineInternalRuntimePlugin,
  type InternalRuntimePlugin,
  type InternalRuntimePluginApi,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";

function normalizeCommandArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createUpdateCommandRuntimePlugin(runtime: BrewvaRuntime): InternalRuntimePlugin {
  return defineInternalRuntimePlugin({
    name: "cli.update_command",
    capabilities: ["tool_registration.write", "user_message.enqueue"],
    register(runtimePluginApi: InternalRuntimePluginApi) {
      runtimePluginApi.registerCommand("update", {
        description:
          "Run the Brewva upgrade workflow (review changelog, migrate Brewva-owned state, and validate before declaring success).",
        handler: async (args, ctx) => {
          const prompt = buildBrewvaUpdatePrompt({
            runtime,
            rawArgs: normalizeCommandArgs(args),
          });

          if (ctx.isIdle()) {
            runtimePluginApi.sendUserMessage([{ type: "text", text: prompt }]);
            if (ctx.hasUI) {
              ctx.ui.notify("Queued Brewva update workflow.", "info");
            }
            return;
          }

          runtimePluginApi.sendUserMessage([{ type: "text", text: prompt }], {
            deliverAs: "followUp",
          });
          if (ctx.hasUI) {
            ctx.ui.notify("Queued Brewva update workflow after the current run.", "info");
          }
        },
      });
    },
  });
}
