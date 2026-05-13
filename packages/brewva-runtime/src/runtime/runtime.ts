import type {
  BrewvaHostedRuntimePort,
  BrewvaOperatorRuntimePort,
  BrewvaRuntimeInstance,
  BrewvaRuntimeOptions,
  BrewvaRuntimeRoot,
  BrewvaToolRuntimePort,
} from "./runtime-api.js";
import {
  createRuntimeFacadeController,
  type RuntimeFacadeControllerHandle,
} from "./runtime-facade-state.js";

export type {
  BrewvaAuthorityPort,
  BrewvaHostedRuntimePort,
  BrewvaInspectionPort,
  BrewvaOperatorRuntimePort,
  BrewvaRuntimeIdentity,
  BrewvaRuntimeInstance,
  BrewvaRuntimeOptions,
  BrewvaRuntimeRoot,
  BrewvaToolRuntimePort,
  RuntimeOperatorPort,
  VerifyCompletionOptions,
} from "./runtime-api.js";

export interface InternalBrewvaRuntimeAssembly {
  readonly instance: BrewvaRuntimeInstance;
  readonly controller: RuntimeFacadeControllerHandle;
}

function freezePort<TPort extends object>(port: TPort): Readonly<TPort> {
  return Object.freeze(port);
}

function createBrewvaRuntimeInstanceFromController(
  controller: RuntimeFacadeControllerHandle,
): BrewvaRuntimeInstance {
  const root = freezePort<BrewvaRuntimeRoot>({
    identity: controller.identity,
    config: controller.config,
    authority: controller.authority,
    inspect: controller.inspect,
  }) as BrewvaRuntimeRoot;

  const hosted = freezePort<BrewvaHostedRuntimePort>({
    identity: root.identity,
    config: root.config,
    authority: root.authority,
    inspect: root.inspect,
    operator: controller.operator,
    extensions: controller.extensions,
  }) as BrewvaHostedRuntimePort;

  const toolExtensions = freezePort<BrewvaToolRuntimePort["extensions"]>({
    tools: controller.extensions.tools,
  }) as BrewvaToolRuntimePort["extensions"];

  const tool = freezePort<BrewvaToolRuntimePort>({
    identity: root.identity,
    config: root.config,
    authority: root.authority,
    inspect: root.inspect,
    extensions: toolExtensions,
  }) as BrewvaToolRuntimePort;

  const operator = freezePort<BrewvaOperatorRuntimePort>({
    identity: root.identity,
    config: root.config,
    inspect: root.inspect,
    operator: controller.operator,
  }) as BrewvaOperatorRuntimePort;

  const instance = Object.freeze({
    root,
    hosted,
    tool,
    operator,
  }) satisfies BrewvaRuntimeInstance;
  return instance;
}

export function createBrewvaRuntimeAssemblyForInternalUse(
  options: BrewvaRuntimeOptions = {},
): InternalBrewvaRuntimeAssembly {
  const controller = createRuntimeFacadeController(options);
  return Object.freeze({
    controller,
    instance: createBrewvaRuntimeInstanceFromController(controller),
  });
}

export function createBrewvaRuntime(options: BrewvaRuntimeOptions = {}): BrewvaRuntimeInstance {
  return createBrewvaRuntimeAssemblyForInternalUse(options).instance;
}

export function selectOperatorRuntimePort(
  instance: BrewvaRuntimeInstance,
): BrewvaOperatorRuntimePort {
  return instance.operator;
}
