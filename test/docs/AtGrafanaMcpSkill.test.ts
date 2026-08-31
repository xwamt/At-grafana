import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AT Grafana MCP skill', () => {
  it('keeps YAML description free of Hub workflow shortcut', () => {
    const skill = readFileSync('skills/at-grafana-mcp/SKILL.md', 'utf8');
    const match = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/discover\s*→\s*select/i);
    expect(match![1]).not.toMatch(/first-class call/i);
    expect(match![1]).not.toMatch(/Prefer grafana_query_prometheus/);
  });

  it('points typed Prom/Loki queries at SuperOps discovery', () => {
    const skill = readFileSync('skills/at-grafana-mcp/SKILL.md', 'utf8');
    expect(skill).toContain('super-ops');
    expect(skill).toContain('grafana_query_prometheus');
    expect(skill).toContain('grafana_query_loki');
    expect(skill).toMatch(/never mid-investigation/i);
  });
});
