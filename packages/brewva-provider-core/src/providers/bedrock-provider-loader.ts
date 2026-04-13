import type {
  Model,
  SimpleStreamOptions,
  StreamOptions,
  Context,
  AssistantMessageEvent,
} from "../types.js";
import type { BedrockOptions } from "./amazon-bedrock.js";
import { createCachedModuleLoader, type LazyProviderModule } from "./provider-loader-runtime.js";

interface BedrockProviderModule {
  streamBedrock: (
    model: Model<"bedrock-converse-stream">,
    context: Context,
    options?: BedrockOptions,
  ) => AsyncIterable<AssistantMessageEvent>;
  streamSimpleBedrock: (
    model: Model<"bedrock-converse-stream">,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AsyncIterable<AssistantMessageEvent>;
}

const importNodeOnlyProvider = (specifier: string): Promise<unknown> => import(specifier);

let bedrockProviderModuleOverride:
  | LazyProviderModule<"bedrock-converse-stream", BedrockOptions, SimpleStreamOptions>
  | undefined;

export function setBedrockProviderModule(module: BedrockProviderModule): void {
  bedrockProviderModuleOverride = {
    stream: module.streamBedrock,
    streamSimple: module.streamSimpleBedrock,
  };
}

export const loadBedrockProviderModule = createCachedModuleLoader(
  (): Promise<
    LazyProviderModule<"bedrock-converse-stream", BedrockOptions, SimpleStreamOptions>
  > => {
    if (bedrockProviderModuleOverride) {
      return Promise.resolve(bedrockProviderModuleOverride);
    }
    return importNodeOnlyProvider("./amazon-bedrock.js").then((module) => {
      const provider = module as BedrockProviderModule;
      return {
        stream: provider.streamBedrock,
        streamSimple: provider.streamSimpleBedrock,
      };
    });
  },
);
