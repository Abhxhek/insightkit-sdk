import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';

describe('keeping credentials out of anything we surface', () => {
  it('scrubs an Anthropic key', () => {
    expect(redact('bad key sk-ant-api03-AbCdEf0123456789 here')).toBe('bad key [redacted] here');
  });

  it('scrubs the shapes other providers use', () => {
    for (const key of [
      'sk-proj-abcdefghijklmnop',
      'api_key-abcdefghijklmnop',
      'token-abcdefghijklmnopqr',
      'Bearer-abcdefghijklmnopqr',
    ]) {
      expect(redact(`prefix ${key} suffix`), key).toBe('prefix [redacted] suffix');
    }
  });

  it('scrubs every occurrence, not just the first', () => {
    const twice = redact('sk-ant-aaaaaaaaaaaaaa and sk-ant-bbbbbbbbbbbbbb');
    expect(twice).toBe('[redacted] and [redacted]');
  });

  it('leaves ordinary text alone, including short hyphenated words', () => {
    const plain = 'relation "sk-users" does not exist at character 15';
    expect(redact(plain)).toBe(plain);
  });

  it('runs in linear time on adversarial input', () => {
    const hostile = `sk-${'-'.repeat(50_000)}`;
    const started = Date.now();
    redact(hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
