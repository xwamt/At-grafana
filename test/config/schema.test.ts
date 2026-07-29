import { describe, expect, it } from 'vitest';
import { parseGrafanaInstanceConfig, grafanaInstanceConfigSchema } from '../../src/config/schema';

describe('grafana instance config schema', () => {
  it('accepts a well-formed instance config', () => {
    const parsed = parseGrafanaInstanceConfig({
      id: 'instance-1',
      label: 'Production',
      url: 'https://grafana.example.com',
      allowBackgroundAccess: false,
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.url).toBe('https://grafana.example.com');
  });

  it('rejects an invalid url', () => {
    expect(() =>
      parseGrafanaInstanceConfig({
        id: 'instance-2',
        label: 'Bad URL',
        url: 'not-a-url',
        allowBackgroundAccess: false,
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('rejects an empty label', () => {
    expect(() =>
      grafanaInstanceConfigSchema.parse({
        id: 'instance-3',
        label: '',
        url: 'https://grafana.example.com',
        allowBackgroundAccess: false,
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('requires allowBackgroundAccess to be explicit', () => {
    expect(() =>
      grafanaInstanceConfigSchema.parse({
        id: 'instance-4',
        label: 'Missing Toggle',
        url: 'https://grafana.example.com',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() =>
      grafanaInstanceConfigSchema.parse({
        id: 'instance-5',
        label: 'Unknown Field',
        url: 'https://grafana.example.com',
        allowBackgroundAccess: false,
        createdAt: 1,
        updatedAt: 2,
        token: 'should-not-be-here'
      })
    ).toThrow();
  });
});
