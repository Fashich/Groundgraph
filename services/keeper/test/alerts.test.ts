import { describe, expect, it } from 'vitest';
import { Alerter, formatText, parseSentryDsn } from '../src/alerts';
import { silentLog } from './helpers';

interface Req {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recorder(status = 200) {
  const reqs: Req[] = [];
  const f = (async (url: string, init: RequestInit) => {
    reqs.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response('ok', { status });
  }) as unknown as typeof fetch;
  return { reqs, f };
}

const A = { key: 'k1', severity: 'critical' as const, title: 'settlement is failing', message: 'boom', fields: { market: 'M1', n: 3, skip: undefined } };

describe('Alerter', () => {
  it('sends Discord style JSON to a discord webhook', async () => {
    const r = recorder();
    const a = new Alerter({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', dedupeSecs: 60, fetchImpl: r.f }, silentLog);
    await a.alert(A);
    expect(r.reqs).toHaveLength(1);
    expect(r.reqs[0]!.body).toMatchObject({ content: expect.stringContaining('settlement is failing') });
    expect(String(r.reqs[0]!.body['content'])).toContain('market: M1');
    expect(String(r.reqs[0]!.body['content'])).not.toContain('skip');
  });

  it('sends Slack style JSON to a slack webhook and generic JSON elsewhere', async () => {
    const s = recorder();
    await new Alerter({ webhookUrl: 'https://hooks.slack.com/services/T/B/X', dedupeSecs: 60, fetchImpl: s.f }, silentLog).alert(A);
    expect(Object.keys(s.reqs[0]!.body)).toEqual(['text']);
    const g = recorder();
    await new Alerter({ webhookUrl: 'https://alerts.example.org/hook', dedupeSecs: 60, fetchImpl: g.f }, silentLog).alert(A);
    expect(g.reqs[0]!.body).toMatchObject({ severity: 'critical', key: 'k1', title: 'settlement is failing', fields: { market: 'M1', n: 3 } });
  });

  it('honours an explicit format', async () => {
    const r = recorder();
    await new Alerter({ webhookUrl: 'https://alerts.example.org/hook', webhookFormat: 'slack', dedupeSecs: 60, fetchImpl: r.f }, silentLog).alert(A);
    expect(Object.keys(r.reqs[0]!.body)).toEqual(['text']);
  });

  it('delivers to Telegram', async () => {
    const r = recorder();
    await new Alerter({ telegramToken: '123:abc', telegramChatId: '-100', dedupeSecs: 60, fetchImpl: r.f }, silentLog).alert(A);
    expect(r.reqs[0]!.url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(r.reqs[0]!.body).toMatchObject({ chat_id: '-100', text: expect.stringContaining('boom') });
  });

  it('reports to Sentry for warnings and errors only', async () => {
    const r = recorder();
    const a = new Alerter({ sentryDsn: 'https://pubkey@o1.ingest.sentry.io/42', dedupeSecs: 0, fetchImpl: r.f }, silentLog);
    await a.alert(A);
    await a.alert({ ...A, key: 'k2', severity: 'info' });
    expect(r.reqs).toHaveLength(1);
    expect(r.reqs[0]!.url).toBe('https://o1.ingest.sentry.io/api/42/store/');
    expect(r.reqs[0]!.headers['x-sentry-auth']).toContain('sentry_key=pubkey');
    expect(r.reqs[0]!.body).toMatchObject({ level: 'fatal' });
  });

  it('suppresses duplicates inside the dedupe window and re-sends after it', async () => {
    const r = recorder();
    let t = 1_000_000;
    const a = new Alerter({ webhookUrl: 'https://alerts.example.org/hook', dedupeSecs: 60, fetchImpl: r.f, now: () => t }, silentLog);
    expect(await a.alert(A)).toBe(true);
    t += 30_000;
    expect(await a.alert(A)).toBe(false);
    expect(await a.alert({ ...A, key: 'other' })).toBe(true);
    t += 31_000;
    expect(await a.alert(A)).toBe(true);
    expect(r.reqs).toHaveLength(3);
  });

  it('sends one recovery notice, only for alerts that fired', async () => {
    const r = recorder();
    const a = new Alerter({ webhookUrl: 'https://alerts.example.org/hook', dedupeSecs: 60, fetchImpl: r.f }, silentLog);
    await a.resolve('k1', 'thing');
    expect(r.reqs).toHaveLength(0);
    await a.alert(A);
    await a.resolve('k1', 'thing', 'fixed');
    await a.resolve('k1', 'thing', 'fixed');
    expect(r.reqs).toHaveLength(2);
    expect(r.reqs[1]!.body['title']).toBe('resolved: thing');
  });

  it('never throws when delivery fails and never leaks the Telegram token into logs', async () => {
    const lines: string[] = [];
    const log = { info() {}, warn: (o: unknown, m: string) => lines.push(JSON.stringify(o) + m), error() {}, debug() {} } as never;
    const bad = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const a = new Alerter({ webhookUrl: 'https://alerts.example.org/hook', telegramToken: 'SECRET-TOKEN', telegramChatId: '1', dedupeSecs: 0, fetchImpl: bad }, log);
    await expect(a.alert(A)).resolves.toBe(true);
    expect(lines.join('\n')).toContain('network down');
    expect(lines.join('\n')).not.toContain('SECRET-TOKEN');
    const http500 = recorder(500);
    await expect(new Alerter({ webhookUrl: 'https://alerts.example.org/hook', dedupeSecs: 0, fetchImpl: http500.f }, silentLog).alert(A)).resolves.toBe(true);
  });

  it('reports whether any destination is configured', () => {
    expect(new Alerter({ dedupeSecs: 1 }, silentLog).enabled).toBe(false);
    expect(new Alerter({ webhookUrl: 'https://x.example', dedupeSecs: 1 }, silentLog).enabled).toBe(true);
  });
});

describe('helpers', () => {
  it('formats text with a severity marker and trims to a safe length', () => {
    expect(formatText(A, 'svc')).toMatch(/^\[CRITICAL\] svc: settlement is failing\nboom/);
    expect(formatText({ ...A, message: 'x'.repeat(5000) }, 'svc').length).toBeLessThanOrEqual(1900);
  });
  it('parses Sentry DSNs', () => {
    expect(parseSentryDsn('https://k@host.example/7')).toEqual({ url: 'https://host.example/api/7/store/', key: 'k' });
    expect(parseSentryDsn('not a dsn')).toBeNull();
    expect(parseSentryDsn('https://host.example/7')).toBeNull();
  });
});
