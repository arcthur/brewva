import { Config, Context, Effect, Layer } from "effect";

type ConfigMap = Record<string, Config.Config<unknown>>;

export type BrewvaConfigServiceShape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>;
};

export type BrewvaConfigServiceClass<Self, Id extends string, Service> = Context.ServiceClass<
  Self,
  Id,
  Service
> & {
  readonly layer: (input: Service) => Layer.Layer<Self>;
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>;
};

export const BrewvaConfigService = {
  Service:
    <Self>() =>
    <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
      class ConfigTag extends Context.Service<Self, BrewvaConfigServiceShape<Fields>>()(id) {
        static layer(input: BrewvaConfigServiceShape<Fields>) {
          return Layer.succeed(this, this.of(input));
        }

        static get defaultLayer() {
          return Layer.effect(
            this,
            Config.all(fields)
              .asEffect()
              .pipe(Effect.map((config) => this.of(config as BrewvaConfigServiceShape<Fields>))),
          );
        }
      }

      return ConfigTag as BrewvaConfigServiceClass<Self, Id, BrewvaConfigServiceShape<Fields>>;
    },
};
