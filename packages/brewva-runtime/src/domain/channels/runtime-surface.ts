import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeChannelsSurfaceMethods {}

export const channelsSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeChannelsSurfaceMethods>;

export function createChannelsSurfaceMethods(): RuntimeChannelsSurfaceMethods {
  return {};
}

export const channelsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "channels",
  createMethods: createChannelsSurfaceMethods,
  contribution: channelsSurfaceContribution,
});
