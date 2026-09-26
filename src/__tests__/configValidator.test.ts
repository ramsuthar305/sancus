import { interpolateEnv } from '../utils/configValidator';

describe('config env interpolation', () => {
  it('substitutes ${VAR} and ${VAR:-default}', () => {
    process.env.SANCUS_T_A = 'http://a:80';
    delete process.env.SANCUS_T_B;
    expect(interpolateEnv('nodes: ["${SANCUS_T_A}", "${SANCUS_T_B:-http://b:80}", "${SANCUS_T_B}"]')).toBe('nodes: ["http://a:80", "http://b:80", ""]');
  });
});
