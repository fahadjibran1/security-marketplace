import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const forwardedFor = req.headers?.['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      const renderClientIp = forwardedFor.split(',')[0]?.trim();
      if (renderClientIp) return renderClientIp;
    }

    return req.ip;
  }
}
