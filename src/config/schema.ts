import { z } from 'zod';

export const grafanaInstanceConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    url: z.string().url(),
    allowBackgroundAccess: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();

export const grafanaInstanceConfigListSchema = z.array(grafanaInstanceConfigSchema);

export type GrafanaInstanceConfig = z.infer<typeof grafanaInstanceConfigSchema>;

export function parseGrafanaInstanceConfig(value: unknown): GrafanaInstanceConfig {
  return grafanaInstanceConfigSchema.parse(value);
}

export function parseGrafanaInstanceConfigList(value: unknown): GrafanaInstanceConfig[] {
  return grafanaInstanceConfigListSchema.parse(value);
}
