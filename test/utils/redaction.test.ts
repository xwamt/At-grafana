import { describe, expect, it } from 'vitest';
import { redactSensitiveText, toUserMessage } from '../../src/utils/redaction';

describe('redaction utilities', () => {
  it('redacts passwords and private key blocks from text', () => {
    const input = 'password=secret -----BEGIN OPENSSH PRIVATE KEY----- abc';
    expect(redactSensitiveText(input)).toBe('password=[REDACTED] [REDACTED_PRIVATE_KEY]');
  });

  it('formats unknown errors without leaking raw objects', () => {
    expect(toUserMessage(new Error('connect failed'))).toBe('connect failed');
    expect(toUserMessage({ message: 'custom failure' })).toBe('custom failure');
    expect(toUserMessage(42)).toBe('Unexpected error');
  });

  it('redacts a Grafana service account token wherever it appears', () => {
    const redacted = redactSensitiveText('upstream rejected glsa_H1o2Ck9dQvXzZ4bN7pLmR3sT8uW0yA6e_1f2a3b4c');
    expect(redacted).not.toContain('H1o2Ck9dQvXzZ4bN7pLmR3sT8uW0yA6e');
    expect(redacted).toBe('upstream rejected glsa_[REDACTED]');
  });

  it('redacts a Grafana Cloud access policy token', () => {
    const redacted = redactSensitiveText('token glc_eyJvIjoiMTIzIiwibiI6ImEifQ==');
    expect(redacted).not.toContain('eyJvIjoiMTIz');
    expect(redacted).toBe('token glc_[REDACTED]');
  });

  it('redacts a Bearer credential while keeping the scheme readable', () => {
    expect(redactSensitiveText('authorization: Bearer glsa_abcdefghijklmnop')).toBe('authorization: Bearer [REDACTED]');
    expect(redactSensitiveText('sent bearer eyJrIjoiYWJjIn0')).toBe('sent bearer [REDACTED]');
  });

  it('redacts a legacy Grafana API key even without a Bearer prefix', () => {
    const redacted = redactSensitiveText('key eyJrIjoidGVzdC1rZXktZm9yLXJlZGFjdGlvbi1zYWZldHktcGFzcyIsIm4iOiJ0ZXN0IiwiaWQiOjF9');
    expect(redacted).not.toContain('dGVzdC1rZXktZm9yLXJlZGFjdGlvbg');
    expect(redacted).toBe('key [REDACTED_GRAFANA_API_KEY]');
  });

  it('redacts the per-run embed token out of a proxy path', () => {
    const redacted = redactSensitiveText(
      'GET /e/2f6c9a1b3d5e7f80112233445566778899aabbccddeeff00112233445566778/instances/abc/d/uid failed'
    );
    expect(redacted).not.toContain('2f6c9a1b3d5e7f80');
    expect(redacted).toBe('GET /e/[REDACTED]/instances/abc/d/uid failed');
  });

  it('redacts a token carried as a query parameter or JSON field', () => {
    expect(redactSensitiveText('https://grafana.example.com/render?token=abc123&width=10')).toBe(
      'https://grafana.example.com/render?token=[REDACTED]&width=10'
    );
    expect(redactSensitiveText('registry entry {"token":"9f8e7d6c","port":1234}')).toBe(
      'registry entry {"token":"[REDACTED]","port":1234}'
    );
  });

  it('drops a whole cookie header, since a session cookie has no telltale prefix', () => {
    expect(redactSensitiveText('Cookie: grafana_session=deadbeefcafe; theme=dark')).toBe(
      'Cookie: [REDACTED]'
    );
    expect(
      redactSensitiveText('upstream sent Set-Cookie: grafana_session=abc; Path=/; HttpOnly')
    ).toBe('upstream sent Set-Cookie: [REDACTED]');
  });

  it('leaves ordinary diagnostic text untouched', () => {
    const message = 'Grafana returned HTTP 502 for /api/search (attempt 2 of 3, retrying in 600ms)';
    expect(redactSensitiveText(message)).toBe(message);
  });
});
