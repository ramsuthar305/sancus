import { defineScript, installScripts, runScript } from '../utils/redisScript';

const fakeClient = () => {
  const c: any = {
    defineCommand: jest.fn((name: string) => { c[name] = jest.fn().mockResolvedValue('via-sha'); }),
    eval: jest.fn().mockResolvedValue('via-eval'),
  };
  return c;
};

describe('redisScript', () => {
  const s = defineScript('testScriptA', 1, 'return 1');

  it('installScripts defines every declared script on a new client', () => {
    const c = fakeClient();
    installScripts(c);
    expect(c.defineCommand).toHaveBeenCalledWith('testScriptA', { numberOfKeys: 1, lua: 'return 1' });
  });

  it('runs an installed script through its command (EVALSHA)', async () => {
    const c = fakeClient();
    installScripts(c);
    await expect(runScript(c, s, 'k', 1)).resolves.toBe('via-sha');
    expect(c.testScriptA).toHaveBeenCalledWith('k', 1);
    expect(c.eval).not.toHaveBeenCalled();
  });

  it('never defines a script on a live client mid-flight: falls back to plain EVAL', async () => {
    const c = fakeClient();
    const late = defineScript('testScriptLate', 2, 'return 2');
    await expect(runScript(c, late, 'a', 'b', 3)).resolves.toBe('via-eval');
    expect(c.eval).toHaveBeenCalledWith('return 2', 2, 'a', 'b', 3);
    expect(c.defineCommand).not.toHaveBeenCalled();
  });
});
