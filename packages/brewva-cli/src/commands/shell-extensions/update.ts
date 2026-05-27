import { buildBrewvaUpdatePrompt } from "@brewva/brewva-gateway";
import {
  ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
  defineHostedExtensionPlugin,
  type HostedExtensionPlugin,
  type HostedExtensionApi,
} from "@brewva/brewva-gateway/extensions";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";

function normalizeCommandArgs(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createUpdateCommandExtension(
  runtime: HostedRuntimeAdapterPort,
): HostedExtensionPlugin {
  return defineHostedExtensionPlugin({
    name: "cli.update_command",
    capabilities: ["tool_registration.write", "user_message.enqueue"],
    advisoryManifest: {
      apiVersion: ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1,
      slot: "surface.command",
      name: "cli.update_command",
      ambientCapabilityClass: "read_tape",
      inputs: ["shell.command:update", "runtime.state"],
      outputs: ["queued_user_message"],
    },
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
