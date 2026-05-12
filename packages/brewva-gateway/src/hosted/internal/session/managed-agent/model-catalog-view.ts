import type { BrewvaMutableModelCatalog } from "@brewva/brewva-substrate/provider";
import type {
  BrewvaSessionModelCatalogView,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";

export class ManagedSessionModelCatalogView implements BrewvaSessionModelCatalogView {
  constructor(private readonly catalog: BrewvaMutableModelCatalog) {}

  getAvailable(): readonly BrewvaSessionModelDescriptor[] {
    return this.catalog.getAvailable() as readonly BrewvaSessionModelDescriptor[];
  }

  getAll(): readonly BrewvaSessionModelDescriptor[] {
    return this.catalog.getAll();
  }
}
