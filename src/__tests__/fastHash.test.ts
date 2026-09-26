/**
 * Tests for the DJB2 fastHash function used for token cache keys.
 * This replicates the exact implementation from commonRequest.controller.ts
 * to verify its properties without importing the controller (which has side effects).
 */

function fastHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

describe('fastHash (DJB2)', () => {
  it('should return a non-empty string', () => {
    expect(fastHash('hello')).toBeTruthy();
    expect(typeof fastHash('hello')).toBe('string');
  });

  it('should be deterministic — same input produces same output', () => {
    const input = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-token';
    expect(fastHash(input)).toBe(fastHash(input));
  });

  it('should produce different hashes for different inputs', () => {
    expect(fastHash('token-a')).not.toBe(fastHash('token-b'));
  });

  it('should produce different hashes for similar inputs', () => {
    expect(fastHash('abc')).not.toBe(fastHash('abd'));
    expect(fastHash('abc')).not.toBe(fastHash('abcd'));
  });

  it('should handle empty string', () => {
    const result = fastHash('');
    expect(result).toBeTruthy();
    // DJB2 of empty string = 5381 in base36
    expect(result).toBe((5381).toString(36));
  });

  it('should handle long JWT-like strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const hash = fastHash(jwt);
    expect(hash).toBeTruthy();
    expect(hash.length).toBeGreaterThan(0);
    expect(hash.length).toBeLessThan(10); // base36 of u32 is at most 7 chars
  });

  it('should produce a base36 encoded string (only [0-9a-z])', () => {
    const hash = fastHash('test-input-12345');
    expect(hash).toMatch(/^[0-9a-z]+$/);
  });

  it('should be much shorter than SHA-256 output', () => {
    const hash = fastHash('some-token-value');
    // SHA-256 sliced to 16 chars was the old approach
    // DJB2 base36 should be at most 7 chars (max u32 = 4294967295 -> "1z141z3" in base36)
    expect(hash.length).toBeLessThanOrEqual(7);
  });

  it('should handle special characters', () => {
    const result = fastHash('Bearer eyJ+/=_-.token');
    expect(result).toBeTruthy();
    expect(result).toMatch(/^[0-9a-z]+$/);
  });
});
