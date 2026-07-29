import { describe, expect, it } from 'vitest';
import {
  GrafanaInstanceConfigManager,
  type ExtensionMemento,
  type SecretStore
} from '../../src/config/GrafanaInstanceConfigManager';

class MemoryMemento implements ExtensionMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

class MemorySecretStore implements SecretStore {
  data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe('GrafanaInstanceConfigManager', () => {
  it('creates an instance with allowBackgroundAccess defaulting to false and stores the token only in SecretStorage', async () => {
    const secrets = new MemorySecretStore();
    const manager = new GrafanaInstanceConfigManager(new MemoryMemento(), secrets);

    const instance = await manager.createInstance({
      label: 'Production',
      url: 'https://grafana.example.com',
      token: 'glsa_super_secret'
    });

    expect(instance.allowBackgroundAccess).toBe(false);
    expect(instance).not.toHaveProperty('token');
    expect(await manager.getToken(instance.id)).toBe('glsa_super_secret');

    const listed = await manager.listInstances();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed[0])).not.toContain('glsa_super_secret');
  });

  it('allows explicitly enabling allowBackgroundAccess on create', async () => {
    const manager = new GrafanaInstanceConfigManager(new MemoryMemento(), new MemorySecretStore());

    const instance = await manager.createInstance({
      label: 'Staging',
      url: 'https://staging.example.com',
      allowBackgroundAccess: true
    });

    expect(instance.allowBackgroundAccess).toBe(true);
  });

  it('updates an existing instance by id, optionally rotating the token', async () => {
    const secrets = new MemorySecretStore();
    const manager = new GrafanaInstanceConfigManager(new MemoryMemento(), secrets);
    const instance = await manager.createInstance({
      label: 'Production',
      url: 'https://grafana.example.com',
      token: 'old-token'
    });

    const updated = await manager.updateInstance(instance.id, { label: 'Renamed' }, 'new-token');

    expect(updated.label).toBe('Renamed');
    expect(await manager.getToken(instance.id)).toBe('new-token');
  });

  it('updateInstance without a token argument leaves the stored token untouched', async () => {
    const manager = new GrafanaInstanceConfigManager(new MemoryMemento(), new MemorySecretStore());
    const instance = await manager.createInstance({
      label: 'Production',
      url: 'https://grafana.example.com',
      token: 'keep-me'
    });

    await manager.updateInstance(instance.id, { allowBackgroundAccess: true });

    expect(await manager.getToken(instance.id)).toBe('keep-me');
  });

  it('throws when updating an unknown instance', async () => {
    const manager = new GrafanaInstanceConfigManager(new MemoryMemento(), new MemorySecretStore());
    await expect(manager.updateInstance('missing', { label: 'X' })).rejects.toThrow();
  });

  it('deletes an instance and its SecretStorage token entry', async () => {
    const secrets = new MemorySecretStore();
    const manager = new GrafanaInstanceConfigManager(new MemoryMemento(), secrets);
    const instance = await manager.createInstance({
      label: 'Production',
      url: 'https://grafana.example.com',
      token: 'super-secret'
    });

    await manager.deleteInstance(instance.id);

    expect(await manager.listInstances()).toEqual([]);
    expect(await manager.getToken(instance.id)).toBeUndefined();
  });
});
