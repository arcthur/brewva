import { Context, Layer } from "effect";

export interface BrewvaRuntimeScopeShape {
  readonly runtimeId?: string;
  readonly agentId?: string;
  readonly workspaceRoot?: string;
}

export class BrewvaRuntimeScope extends Context.Service<
  BrewvaRuntimeScope,
  BrewvaRuntimeScopeShape
>()("@brewva/Scope/Runtime") {
  static layer(input: BrewvaRuntimeScopeShape) {
    return Layer.succeed(this, this.of(input));
  }
}

export interface BrewvaGatewayScopeShape {
  readonly gatewayId?: string;
  readonly stateDir?: string;
}

export class BrewvaGatewayScope extends Context.Service<
  BrewvaGatewayScope,
  BrewvaGatewayScopeShape
>()("@brewva/Scope/Gateway") {
  static layer(input: BrewvaGatewayScopeShape) {
    return Layer.succeed(this, this.of(input));
  }
}

export interface BrewvaSessionScopeShape {
  readonly sessionId: string;
  readonly agentSessionId?: string;
}

export class BrewvaSessionScope extends Context.Service<
  BrewvaSessionScope,
  BrewvaSessionScopeShape
>()("@brewva/Scope/Session") {
  static layer(input: BrewvaSessionScopeShape) {
    return Layer.succeed(this, this.of(input));
  }
}

export interface BrewvaWorkerScopeShape {
  readonly sessionId: string;
  readonly pid?: number;
}

export class BrewvaWorkerScope extends Context.Service<BrewvaWorkerScope, BrewvaWorkerScopeShape>()(
  "@brewva/Scope/Worker",
) {
  static layer(input: BrewvaWorkerScopeShape) {
    return Layer.succeed(this, this.of(input));
  }
}

export interface BrewvaProviderRequestScopeShape {
  readonly provider: string;
  readonly model: string;
  readonly sessionId?: string;
}

export class BrewvaProviderRequestScope extends Context.Service<
  BrewvaProviderRequestScope,
  BrewvaProviderRequestScopeShape
>()("@brewva/Scope/ProviderRequest") {
  static layer(input: BrewvaProviderRequestScopeShape) {
    return Layer.succeed(this, this.of(input));
  }
}

export interface BrewvaBoxScopeShape {
  readonly ownerSessionId: string;
  readonly boxId?: string;
  readonly executionId?: string;
}

export class BrewvaBoxScope extends Context.Service<BrewvaBoxScope, BrewvaBoxScopeShape>()(
  "@brewva/Scope/Box",
) {
  static layer(input: BrewvaBoxScopeShape) {
    return Layer.succeed(this, this.of(input));
  }
}
