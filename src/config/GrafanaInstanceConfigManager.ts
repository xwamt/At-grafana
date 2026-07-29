import { randomUUID } from 'node:crypto';
import { parseGrafanaInstanceConfig, parseGrafanaInstanceConfigList, type GrafanaInstanceConfig } from './schema';

const INSTANCES_KEY = 'atGrafana.instances';
const TOKEN_PREFIX = 'atGrafana.token.';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface CreateGrafanaInstanceInput {
  label: string;
  url: string;
  token?: string;
  allowBackgroundAccess?: boolean;
}

export type UpdateGrafanaInstanceInput = Partial<Pick<CreateGrafanaInstanceInput, 'label' | 'url' | 'allowBackgroundAccess'>>;

export class GrafanaInstanceConfigManager {
  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore
  ) {}

  async listInstances(): Promise<GrafanaInstanceConfig[]> {
    return parseGrafanaInstanceConfigList(this.globalState.get<unknown[]>(INSTANCES_KEY, []));
  }

  async getInstance(id: string): Promise<GrafanaInstanceConfig | undefined> {
    return (await this.listInstances()).find((instance) => instance.id === id);
  }

  async createInstance(input: CreateGrafanaInstanceInput): Promise<GrafanaInstanceConfig> {
    const now = Date.now();
    const instance = parseGrafanaInstanceConfig({
      id: randomUUID(),
      label: input.label.trim(),
      url: input.url.trim(),
      // Background (unattended) agent access is opt-in per instance; see ADR-004.
      allowBackgroundAccess: input.allowBackgroundAccess ?? false,
      createdAt: now,
      updatedAt: now
    });
    await this.persist(instance, input.token);
    return instance;
  }

  async updateInstance(id: string, patch: UpdateGrafanaInstanceInput, token?: string): Promise<GrafanaInstanceConfig> {
    const existing = await this.getInstance(id);
    if (!existing) {
      throw new Error(`Unknown Grafana instance: ${id}`);
    }
    const updated = parseGrafanaInstanceConfig({
      ...existing,
      ...patch,
      label: (patch.label ?? existing.label).trim(),
      url: (patch.url ?? existing.url).trim(),
      updatedAt: Date.now()
    });
    await this.persist(updated, token);
    return updated;
  }

  async deleteInstance(id: string): Promise<void> {
    const instances = await this.listInstances();
    await this.globalState.update(
      INSTANCES_KEY,
      instances.filter((instance) => instance.id !== id)
    );
    await this.secrets.delete(this.tokenKey(id));
  }

  async getToken(id: string): Promise<string | undefined> {
    return this.secrets.get(this.tokenKey(id));
  }

  tokenKey(id: string): string {
    return `${TOKEN_PREFIX}${id}`;
  }

  private async persist(instance: GrafanaInstanceConfig, token?: string): Promise<void> {
    const instances = await this.listInstances();
    const next = [...instances.filter((entry) => entry.id !== instance.id), instance].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(INSTANCES_KEY, next);
    if (token !== undefined) {
      await this.secrets.store(this.tokenKey(instance.id), token);
    }
  }
}
