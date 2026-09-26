import axios from 'axios';
import getLogger from '../configs/logger';

const logger = getLogger();
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS) || 60_000;

/**
 * Generic incoming-webhook alerter. The payload carries both `text` (Slack, Mattermost,
 * Rocket.Chat, Google Chat) and `content` (Discord), so one URL works for any of them.
 *   ALERT_WEBHOOK_URL   webhook URL (DISCORD_WEBHOOK_URL still accepted)
 *   ALERT_COOLDOWN_MS   minimum gap between alerts sharing the same key (default 60000)
 */
class AlertService {
  private static instance: AlertService;
  private readonly lastSent = new Map<string, number>();

  constructor(private readonly webhookUrl = process.env.ALERT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '') {}

  static getInstance(): AlertService {
    if (!AlertService.instance) AlertService.instance = new AlertService();
    return AlertService.instance;
  }

  get enabled(): boolean {
    return this.webhookUrl.length > 0;
  }

  /** Fire-and-forget. `key` dedupes alerts within the cooldown window. */
  alert(key: string, heading: string, message: string): void {
    if (!this.enabled) return;
    const now = Date.now();
    const last = this.lastSent.get(key);
    if (last && now - last < COOLDOWN_MS) return;
    if (this.lastSent.size > 1000) this.lastSent.clear(); // ponytail: bounded, per-pod
    this.lastSent.set(key, now);

    const text = `*${heading}*\n${message}`.slice(0, 1900);
    axios
      .post(this.webhookUrl, { text, content: text }, { timeout: 5000 })
      .catch((e) => logger.warn({ err: (e as Error).message }, 'alert webhook failed'));
  }
}

export default AlertService;
