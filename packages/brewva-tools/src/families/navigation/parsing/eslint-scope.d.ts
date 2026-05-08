// Narrow `eslint-scope` typings for strict TypeScript alongside oxc-parser.
//
// eslint-scope@9 ships its own `.d.ts`, but those types expect a pure ESTree
// `Program` and `Identifier` shapes that disagree with oxc's extensions (e.g.
// `sourceType` / span fields). This ambient module keeps the surface we use in
// `oxc-source.ts` without widening the compiler to `any` at every call site.
declare module "eslint-scope" {
  export interface AnalyzerOptions {
    readonly ecmaVersion?: number;
    readonly sourceType?: "script" | "module";
    readonly nodejsScope?: boolean;
    readonly impliedStrict?: boolean;
  }

  export interface VariableDef {
    readonly name: { readonly type: string; readonly start: number; readonly end: number };
    readonly type: string;
  }

  export interface Reference {
    readonly identifier: {
      readonly type: string;
      readonly name?: string;
      readonly start: number;
      readonly end: number;
    };
    readonly from: { readonly type: string };
    isWrite(): boolean;
    isRead(): boolean;
  }

  export interface Variable {
    readonly name: string;
    readonly defs: readonly VariableDef[];
    readonly references: readonly Reference[];
  }

  export interface Scope {
    readonly type: string;
    readonly variables: readonly Variable[];
    readonly references: readonly Reference[];
    readonly childScopes: readonly Scope[];
  }

  export interface ScopeManager {
    readonly scopes: readonly Scope[];
    readonly globalScope: Scope | null;
  }

  // eslint-scope is loosely typed at the AST input boundary; we accept any
  // ESTree-shaped Program here and rely on the runtime to validate fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function analyze(ast: any, options?: AnalyzerOptions): ScopeManager;
}
