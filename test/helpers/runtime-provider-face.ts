import type {
  RuntimeProviderFace,
  RuntimeProviderModelCatalog,
} from "../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-session.js";

type RuntimeProviderModelCatalogFixture = Omit<RuntimeProviderModelCatalog, "getAll"> & {
  getAll?(): ReturnType<RuntimeProviderModelCatalog["getAll"]>;
};

type RuntimeProviderFaceFixtureInput = Omit<
  Partial<RuntimeProviderFace>,
  "model" | "getModelCatalog"
> & {
  readonly getModelCatalog: () => RuntimeProviderModelCatalogFixture;
  readonly model?: RuntimeProviderFace["model"];
  readonly getModel?: () => RuntimeProviderFace["model"];
};

export function createRuntimeProviderFaceFixture(
  input: RuntimeProviderFaceFixtureInput,
): RuntimeProviderFace {
  const { getModel, getModelCatalog, model, ...overrides } = input;
  const defaults: RuntimeProviderFace = {
    getModelCatalog() {
      const catalog = getModelCatalog();
      return {
        ...catalog,
        getAll() {
          const currentModel = getModel?.() ?? model;
          return catalog.getAll?.() ?? (currentModel ? [currentModel] : []);
        },
      };
    },
    getModelPresetState() {
      return {
        activeName: "default",
        defaultName: "default",
        presets: [{ name: "default", roles: {} }],
      };
    },
    getActiveModelRole() {
      return "default";
    },
    getModelRoutingSettings() {
      return undefined;
    },
    recordProviderCredentialRotated() {},
    recordProviderFallbackSelection() {},
    getVerificationGateManifests() {
      return [];
    },
    getVerificationGateEvidence() {
      return [];
    },
    getProviderCachePolicy() {
      return {
        retention: "short",
        writeMode: "readWrite",
        scope: "session",
        reason: "default",
      };
    },
    getProviderTransport() {
      return undefined;
    },
    async prepareProviderPayload({ payload }) {
      return payload;
    },
    observeCacheRender() {},
    observeAssistantMessage() {},
  };

  return {
    ...defaults,
    ...overrides,
    get model() {
      return getModel?.() ?? model;
    },
  };
}
