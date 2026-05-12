import type {
  BrewvaDiffPreferences,
  BrewvaManagedSessionSettingsView,
  BrewvaModelPreferences,
  BrewvaShellViewPreferences,
} from "@brewva/brewva-substrate/session";

export interface ManagedSessionPreferencesPort {
  getQuietStartup(): boolean;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
}

export class ManagedSessionSettingsView implements BrewvaManagedSessionSettingsView {
  constructor(private readonly settings: ManagedSessionPreferencesPort) {}

  getQuietStartup(): boolean {
    return this.settings.getQuietStartup();
  }

  getModelPreferences(): BrewvaModelPreferences {
    return this.settings.getModelPreferences();
  }

  setModelPreferences(preferences: BrewvaModelPreferences): void {
    this.settings.setModelPreferences(preferences);
  }

  getDiffPreferences(): BrewvaDiffPreferences {
    return this.settings.getDiffPreferences();
  }

  setDiffPreferences(preferences: BrewvaDiffPreferences): void {
    this.settings.setDiffPreferences(preferences);
  }

  getShellViewPreferences(): BrewvaShellViewPreferences {
    return this.settings.getShellViewPreferences();
  }

  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void {
    this.settings.setShellViewPreferences(preferences);
  }
}
