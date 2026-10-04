import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const RESEND_API_URL = 'https://api.resend.com/emails';
export const DEFAULT_WEB_APP_URL = 'https://app.sfour.co.uk';

export type TransactionalEmailKind = 'password_reset' | 'email_verification';

export interface TransactionalEmail {
  kind: TransactionalEmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailTransport = 'resend' | 'outbox' | 'disabled';

/** What the in-memory outbox keeps. Bounded so a long-running dev server cannot grow without limit. */
const OUTBOX_LIMIT = 50;

/**
 * Sends S4's transactional authentication email (password reset, email verification) through Resend.
 *
 * Transport is chosen from configuration, never from code:
 *
 *   RESEND_API_KEY + EMAIL_FROM set   → Resend.
 *   otherwise, outside production     → an in-memory outbox that tests and local development read
 *                                       directly through this service. Nothing leaves the process.
 *   otherwise, in production          → disabled: the message is dropped and an event without any
 *                                       recipient or link is logged, so a missing configuration is
 *                                       visible without making email a boot requirement.
 *
 * The rendered message is never logged in any mode: it carries a single-use token.
 */
@Injectable()
export class TransactionalEmailService {
  private readonly logger = new Logger('TransactionalEmail');
  private readonly outbox: TransactionalEmail[] = [];

  constructor(private readonly config: ConfigService) {}

  get transport(): EmailTransport {
    if (this.apiKey && this.from) return 'resend';
    return this.config.get<string>('NODE_ENV') === 'production' ? 'disabled' : 'outbox';
  }

  /** Base URL of the S4 web app that hosts /reset-password and /verify-email. */
  get webAppUrl(): string {
    const configured = this.config.get<string>('S4_WEB_APP_URL')?.trim();
    return (configured || DEFAULT_WEB_APP_URL).replace(/\/+$/, '');
  }

  private get apiKey() {
    return this.config.get<string>('RESEND_API_KEY')?.trim() || '';
  }

  private get from() {
    return this.config.get<string>('EMAIL_FROM')?.trim() || '';
  }

  private get replyTo() {
    return this.config.get<string>('EMAIL_REPLY_TO')?.trim() || '';
  }

  /**
   * Deliver one message. Never throws: a delivery failure must not change the response of an endpoint
   * whose response is deliberately identical whether or not the account exists.
   */
  async send(message: TransactionalEmail): Promise<boolean> {
    const transport = this.transport;
    if (transport === 'outbox') {
      this.outbox.push(message);
      if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
      this.logger.log(JSON.stringify({ event: 'transactional_email_captured', kind: message.kind }));
      return true;
    }
    if (transport === 'disabled') {
      this.logger.warn(JSON.stringify({ event: 'transactional_email_not_configured', kind: message.kind }));
      return false;
    }

    try {
      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // Status only: a Resend error body can echo the request, which carries the link.
        this.logger.error(
          JSON.stringify({ event: 'transactional_email_failed', kind: message.kind, status: response.status }),
        );
        return false;
      }
      this.logger.log(JSON.stringify({ event: 'transactional_email_sent', kind: message.kind }));
      return true;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'transactional_email_failed',
          kind: message.kind,
          reason: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return false;
    }
  }

  /**
   * Development and test only: the captured messages. Returns an empty list whenever a real transport
   * is configured, so production can never read a token back out of this service.
   */
  capturedMessages(): readonly TransactionalEmail[] {
    return this.transport === 'outbox' ? [...this.outbox] : [];
  }

  clearCapturedMessages(): void {
    this.outbox.length = 0;
  }
}
