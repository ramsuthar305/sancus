import net from 'net';
import type { PolicyDefinition } from '../services/policyRegistry';
import { getClientIp } from '../utils/clientIp';

/**
 * Built-in `ip-restriction` policy. YAML:
 *   policies:
 *     ip-restriction: { allow: [10.0.0.0/8, 203.0.113.7], deny: [] }
 * deny wins; a non-empty allow list rejects everything not on it. Uses Node's native net.BlockList.
 */
function blockList(entries: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const e of entries) {
    const [addr, prefix] = e.split('/');
    const family = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (prefix) list.addSubnet(addr, Number(prefix), family);
    else list.addAddress(addr, family);
  }
  return list;
}

const ipRestriction: PolicyDefinition = {
  name: 'ip-restriction',
  priority: 1000,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      allow: { type: 'array', items: { type: 'string' } },
      deny: { type: 'array', items: { type: 'string' } },
    },
  },
  create(config) {
    const { allow = [], deny = [] } = (config ?? {}) as { allow?: string[]; deny?: string[] };
    const allowList = blockList(allow);
    const denyList = blockList(deny);
    return (req, res, next) => {
      const ip = getClientIp(req).replace(/^::ffff:/, '');
      const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
      const denied = denyList.check(ip, family) || (allow.length > 0 && !allowList.check(ip, family));
      if (denied) return res.status(403).json({ message: 'Forbidden', response_code: 'SE0403' });
      next();
    };
  },
};

export default ipRestriction;
