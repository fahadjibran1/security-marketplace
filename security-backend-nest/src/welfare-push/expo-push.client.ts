import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The Expo Push Service (free; no per-message charge). Expo forwards to Firebase Cloud Messaging (Android) and Apple
 * Push Notification service (iOS) using the credentials held in the S4 EAS project, so the backend holds no Apple or
 * Google key. EXPO_ACCESS_TOKEN is optional (only needed if "enhanced push security" is turned on for the project).
 *
 * EXPO_PUSH_API_BASE exists so tests can point the client at a local fake; it defaults to Expo's public endpoint.
 *
 * Never logs a token, a message body or a provider response body.
 */
export const EXPO_PUSH_DEFAULT_BASE = 'https://exp.host';
const SEND_PATH = '/--/api/v2/push/send';
const RECEIPTS_PATH = '/--/api/v2/push/getReceipts';
/** Expo's documented maximum per request. */
export const EXPO_PUSH_BATCH_LIMIT = 100;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  /** Identifiers only. Never a token, credential or personal detail beyond the site name already in the body. */
  data: Record<string, string | number>;
  sound: 'default';
  priority: 'high';
  /** Android notification channel (created by the app). */
  channelId: string;
  /** iOS category / Android action set (registered by the app): the I'm Safe and Need Help buttons. */
  categoryId: string;
  /** Seconds the provider may keep trying; set to the end of the window so a stale reminder is dropped. */
  ttl: number;
}

export type ExpoTicket = { status: 'ok'; id: string } | { status: 'error'; error: string };
export type ExpoReceipt = { status: 'ok' } | { status: 'error'; error: string };

export class ExpoPushTransportError extends Error {}

@Injectable()
export class ExpoPushClient {
  private readonly logger = new Logger('ExpoPush');

  constructor(private readonly config: ConfigService) {}

  private get base(): string {
    return (this.config.get<string>('EXPO_PUSH_API_BASE')?.trim() || EXPO_PUSH_DEFAULT_BASE).replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const token = this.config.get<string>('EXPO_ACCESS_TOKEN')?.trim();
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /** Expo's token shape. Anything else is refused at registration and never sent. */
  static isExpoToken(value: unknown): value is string {
    return typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(value);
  }

  /**
   * One ticket per message, in order. A transport failure (network, timeout, non-2xx, malformed body) throws
   * ExpoPushTransportError so the caller records 'failed' and may retry; a per-message error is a ticket.
   */
  async send(messages: ExpoPushMessage[]): Promise<ExpoTicket[]> {
    const tickets: ExpoTicket[] = [];
    for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH_LIMIT) {
      const batch = messages.slice(i, i + EXPO_PUSH_BATCH_LIMIT);
      const body = await this.post(SEND_PATH, batch);
      const data = Array.isArray(body?.data) ? body.data : null;
      if (!data || data.length !== batch.length) throw new ExpoPushTransportError('malformed_send_response');
      for (const item of data) {
        if (item?.status === 'ok' && typeof item.id === 'string') tickets.push({ status: 'ok', id: item.id });
        else tickets.push({ status: 'error', error: String(item?.details?.error || 'provider_error').slice(0, 64) });
      }
    }
    return tickets;
  }

  /** Receipts for ticket ids; ids Expo does not know yet are simply absent. */
  async receipts(ids: string[]): Promise<Map<string, ExpoReceipt>> {
    const out = new Map<string, ExpoReceipt>();
    for (let i = 0; i < ids.length; i += 1000) {
      const body = await this.post(RECEIPTS_PATH, { ids: ids.slice(i, i + 1000) });
      const data = body?.data && typeof body.data === 'object' ? body.data : {};
      for (const [id, receipt] of Object.entries<any>(data)) {
        if (receipt?.status === 'ok') out.set(id, { status: 'ok' });
        else if (receipt?.status === 'error') {
          out.set(id, { status: 'error', error: String(receipt?.details?.error || 'provider_error').slice(0, 64) });
        }
      }
    }
    return out;
  }

  private async post(path: string, payload: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      this.logger.warn(JSON.stringify({ event: 'expo_push_transport_failed', path, reason }));
      throw new ExpoPushTransportError(reason);
    }
    if (!response.ok) {
      // Status only: a provider error body can echo the request.
      this.logger.warn(JSON.stringify({ event: 'expo_push_http_error', path, status: response.status }));
      throw new ExpoPushTransportError(`http_${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new ExpoPushTransportError('malformed_json');
    }
  }
}
