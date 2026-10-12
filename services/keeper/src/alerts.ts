import type { Logger } from '@groundgraph/svc-core';

export type Severity = 'info' | 'warn' | 'critical';

export interface Alert {
  /** stable identity used for de-duplication, e.g. "settle-failed:<market>" */
  key: string;
  severity: Severity;
  title: string;
  message: string;
  fields?: Record<string, string | number | boolean | null | undefined>;
}

export interface AlertOptions {
  webhookUrl?: string | undefined;
  webhookFormat?: 'auto' | 'discord' | 'slack' | 'json';
  telegramToken?: string | undefined;
  telegramChatId?: string | undefined;
  sentryDsn?: string | undefined;
  dedupeSecs: number;
  service?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const ICON: Record<Severity, string> = { info: '[info]', warn: '[warn]', critical: '[CRITICAL]' };

export function formatText(a: Alert, service: string): string {
  const fields = a.fields
    ? Object.entries(a.fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';
  return `${ICON[a.severity]} ${service}: ${a.title}\n${a.message}${fields ? `\n${fields}` : ''}`.slice(0, 1900);
}

/** Parse a Sentry DSN (https://<key>@<host>/<project>) into its store endpoint and key. */
export function parseSentryDsn(dsn: string): { url: string; key: string } | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+/, '');
    if (!u.username || !project) return null;
    return { url: `${u.protocol}//${u.host}/api/${project}/store/`, key: u.username };
  } catch {
    return null;
  }
}

/**
 * Sends operational alerts to a webhook (Discord, Slack or generic JSON), Telegram and optionally Sentry.
 * The same key is sent at most once per `dedupeSecs`; `resolve(key)` sends one recovery notice for an alert that fired.
 * Delivery problems are logged and never thrown: alerting must not be able to break the keeper.
 */
export class Alerter {
  private lastSent = new Map<string, number>();
  private active = new Set<string>();
  private f: typeof fetch;
  private now: () => number;
  private service: string;
  readonly sent: Alert[] = [];

  constructor(
    private o: AlertOptions,
    private log: Logger,
  ) {
    this.f = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.service = o.service ?? 'groundgraph-keeper';
  }

  get enabled(): boolean {
    return Boolean(this.o.webhookUrl || (this.o.telegramToken && this.o.telegramChatId) || this.o.sentryDsn);
  }

  async alert(a: Alert): Promise<boolean> {
    const last = this.lastSent.get(a.key);
    const t = this.now();
    this.active.add(a.key);
    if (last !== undefined && t - last < this.o.dedupeSecs * 1000) return false;
    this.lastSent.set(a.key, t);
    const level = a.severity === 'critical' ? 'error' : a.severity === 'warn' ? 'warn' : 'info';
    this.log[level]({ alert: a.key, ...a.fields }, `ALERT ${a.title}: ${a.message}`);
    this.sent.push(a);
    await this.deliver(a);
    return true;
  }

  /** Recovery notice, sent only if the alert fired and was not already resolved. */
  async resolve(key: string, title: string, message = 'recovered'): Promise<void> {
    if (!this.active.delete(key)) return;
    this.lastSent.delete(key);
    this.log.info({ alert: key }, `RESOLVED ${title}: ${message}`);
    const a: Alert = { key, severity: 'info', title: `resolved: ${title}`, message };
    this.sent.push(a);
    await this.deliver(a);
  }

  private async deliver(a: Alert): Promise<void> {
    const text = formatText(a, this.service);
    const jobs: Promise<void>[] = [];
    if (this.o.webhookUrl) jobs.push(this.webhook(this.o.webhookUrl, a, text));
    if (this.o.telegramToken && this.o.telegramChatId) jobs.push(this.telegram(text));
    if (this.o.sentryDsn && a.severity !== 'info') jobs.push(this.sentry(a));
    await Promise.all(jobs);
  }

  private async post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
    const res = await this.f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  private async webhook(url: string, a: Alert, text: string): Promise<void> {
    try {
      let fmt = this.o.webhookFormat ?? 'auto';
      if (fmt === 'auto') {
        const host = new URL(url).host;
        fmt = /discord(app)?\.com$/.test(host) ? 'discord' : /slack\.com$/.test(host) ? 'slack' : 'json';
      }
      const body =
        fmt === 'discord'
          ? { content: text, username: this.service }
          : fmt === 'slack'
            ? { text }
            : { service: this.service, severity: a.severity, key: a.key, title: a.title, message: a.message, fields: a.fields ?? {}, text, ts: new Date(this.now()).toISOString() };
      await this.post(url, body);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'alert webhook delivery failed');
    }
  }

  private async telegram(text: string): Promise<void> {
    try {
      await this.post(`https://api.telegram.org/bot${this.o.telegramToken}/sendMessage`, { chat_id: this.o.telegramChatId, text, disable_web_page_preview: true });
    } catch (err) {
      // never log the URL: it contains the bot token
      this.log.warn({ err: (err as Error).message }, 'alert telegram delivery failed');
    }
  }

  private async sentry(a: Alert): Promise<void> {
    const dsn = this.o.sentryDsn ? parseSentryDsn(this.o.sentryDsn) : null;
    if (!dsn) return;
    try {
      await this.post(
        dsn.url,
        {
          message: `${a.title}: ${a.message}`,
          level: a.severity === 'critical' ? 'fatal' : 'warning',
          platform: 'node',
          server_name: this.service,
          timestamp: this.now() / 1000,
          tags: { alert: a.key },
          extra: a.fields ?? {},
        },
        { 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=gg-keeper/1.0, sentry_key=${dsn.key}` },
      );
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'sentry delivery failed');
    }
  }
}
