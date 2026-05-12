import { buildBrewvaUpdatePrompt } from "@brewva/brewva-gateway";
import {
  defineHostedExtensionPlugin,
  type HostedExtensionPlugin,
  type HostedExtensionApi,
} from "@brewva/brewva-gateway/extensions";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";

function normalizeCommandArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createUpdateCommandExtension(runtime: BrewvaRuntime): HostedExtensionPlugin {
  return defineHostedExtensionPlugin({
    name: "cli.update_command",
    capabilities: ["tool_registration.write", "user_message.enqueue"],
    register(extensionApi: HostedExtensionApi) {
      extensionApi.registerCommand("update", {
        description:
          "Run the Brewva upgrade workflow (review changelog, migrate Brewva-owned state, and validate before declaring success).",
        handler: async (args, ctx) => {
          const prompt = buildBrewvaUpdatePrompt({
            runtime,
            rawArgs: normalizeCommandArgs(args),
          });

          if (ctx.isIdle()) {
            extensionApi.sendUserMessage([{ type: "text", text: prompt }]);
            if (ctx.hasUI) {
              ctx.ui.notify("Queued Brewva update workflow.", "info");
            }
            return;
          }

          extensionApi.sendUserMessage([{ type: "text", text: prompt }], {
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
