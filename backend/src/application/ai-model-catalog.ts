export interface ModelProfileSource {
  profileName: string;
  configuredModel: string;
  assignedCapabilities: string[];
  listAvailableModels(): Promise<string[]>;
}

export type ModelAvailability = 'AVAILABLE' | 'CONFIGURED_MODEL_MISSING' | 'UNREACHABLE';

export interface ProviderModelInventory {
  profileName: string;
  configuredModel: string;
  assignedCapabilities: string[];
  availableModels: string[];
  availability: ModelAvailability;
  checkedAt: string;
}

export interface RoutedModelView {
  capability: string;
  model: string;
  available: boolean;
}

/** Read-only model control-plane view; it never returns provider URLs or credentials. */
export class AiModelCatalog {
  private cache: { expiresAt: number; inventories: ProviderModelInventory[] } | null = null;

  constructor(private readonly profiles: ModelProfileSource[], private readonly cacheMs = 10_000) {
    if (!Number.isInteger(cacheMs) || cacheMs < 0 || cacheMs > 60_000) throw new Error('Model catalog cache must be between 0 and 60000 milliseconds.');
    const names = profiles.map((profile) => profile.profileName);
    if (new Set(names).size !== names.length) throw new Error('Model catalog contains duplicate profile names.');
  }

  async listProviderInventories(): Promise<ProviderModelInventory[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.inventories;
    const checkedAt = new Date().toISOString();
    const inventories = await Promise.all(this.profiles.map(async (profile): Promise<ProviderModelInventory> => {
      try {
        const allModels = [...new Set((await profile.listAvailableModels())
          .filter((model) => typeof model === 'string' && model.length > 0 && model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model)))].sort();
        const availableModels = allModels.slice(0, 100);
        if (allModels.includes(profile.configuredModel) && !availableModels.includes(profile.configuredModel)) availableModels[99] = profile.configuredModel;
        availableModels.sort();
        return {
          profileName: profile.profileName,
          configuredModel: profile.configuredModel,
          assignedCapabilities: [...profile.assignedCapabilities].sort(),
          availableModels,
          availability: availableModels.includes(profile.configuredModel) ? 'AVAILABLE' : 'CONFIGURED_MODEL_MISSING',
          checkedAt,
        };
      } catch {
        return {
          profileName: profile.profileName,
          configuredModel: profile.configuredModel,
          assignedCapabilities: [...profile.assignedCapabilities].sort(),
          availableModels: [],
          availability: 'UNREACHABLE',
          checkedAt,
        };
      }
    }));
    this.cache = { inventories, expiresAt: Date.now() + this.cacheMs };
    return inventories;
  }

  async listRoutedModels(): Promise<RoutedModelView[]> {
    const inventories = await this.listProviderInventories();
    return inventories.flatMap((profile) => profile.assignedCapabilities
      .filter((capability) => capability !== 'TASK_PLANNER')
      .map((capability) => ({
        capability,
        model: profile.configuredModel,
        available: profile.availability === 'AVAILABLE',
      })))
      .sort((left, right) => left.capability.localeCompare(right.capability));
  }
}
