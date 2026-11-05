import { BadRequestException } from '@nestjs/common';
import { SafetyAlertStatus, SafetyAlertType } from './entities/safety-alert.entity';
import { HISTORY_MAX_PAGE_SIZE, OPERATIONAL_MAX_WINDOW_MS, SafetyAlertScopeQuery } from './safety-alert.service';

/** The raw query string values of GET /alerts/company (each read on its own: unknown keys keep being ignored). */
export type RawAlertScopeQuery = {
  scope?: string;
  since?: string;
  until?: string;
  page?: string;
  pageSize?: string;
  from?: string;
  to?: string;
  type?: string;
  status?: string;
  shiftId?: string;
};

const ALERT_TYPES = new Set<string>(Object.values(SafetyAlertType));
const ALERT_STATUSES = new Set<string>(Object.values(SafetyAlertStatus));

function instant(value: string | undefined, name: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const at = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(at.getTime())) throw new BadRequestException(`"${name}" must be an ISO 8601 date-time.`);
  return at;
}

function positiveInt(value: string | undefined, name: string, max?: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new BadRequestException(`"${name}" must be a positive whole number.`);
  const n = Number(value);
  if (max != null && n > max) throw new BadRequestException(`"${name}" must be at most ${max}.`);
  return n;
}

/**
 * GET /alerts/company's opt-in scope (Stage A). Null — the unchanged, unscoped list — when `scope` is absent or empty;
 * otherwise a validated query, or 400 naming what is wrong. Parameters belonging to another scope are refused, so a
 * caller never believes a filter applied that did not.
 */
export function parseAlertScopeQuery(raw: RawAlertScopeQuery): SafetyAlertScopeQuery | null {
  const scope = raw.scope?.trim();
  if (!scope) return null;
  const present = (keys: Array<keyof RawAlertScopeQuery>) => keys.filter((k) => raw[k] !== undefined && raw[k] !== '');
  const refuse = (allowed: Array<keyof RawAlertScopeQuery>) => {
    const others = present(['since', 'until', 'page', 'pageSize', 'from', 'to', 'type', 'status', 'shiftId']).filter((k) => !allowed.includes(k));
    if (others.length) throw new BadRequestException(`${others.map((k) => `"${k}"`).join(', ')} ${others.length === 1 ? 'does' : 'do'} not apply to scope=${scope}.`);
  };

  if (scope === 'operational') {
    refuse(['since', 'until']);
    const since = instant(raw.since, 'since');
    const until = instant(raw.until, 'until');
    if (since && until) {
      if (until.getTime() <= since.getTime()) throw new BadRequestException('"until" must be after "since".');
      if (until.getTime() - since.getTime() > OPERATIONAL_MAX_WINDOW_MS) throw new BadRequestException('The operational window is at most 7 days; use scope=history for older alerts.');
    }
    return { scope, since, until };
  }
  if (scope === 'history') {
    refuse(['page', 'pageSize', 'from', 'to', 'type', 'status']);
    const from = instant(raw.from, 'from');
    const to = instant(raw.to, 'to');
    if (from && to && to.getTime() <= from.getTime()) throw new BadRequestException('"to" must be after "from".');
    const type = raw.type?.trim() || undefined;
    if (type && !ALERT_TYPES.has(type)) throw new BadRequestException(`"${type}" is not an alert type.`);
    const status = raw.status?.trim() || undefined;
    if (status && !ALERT_STATUSES.has(status)) throw new BadRequestException(`"${status}" is not an alert status.`);
    return {
      scope,
      page: positiveInt(raw.page, 'page', 100_000),
      pageSize: positiveInt(raw.pageSize, 'pageSize', HISTORY_MAX_PAGE_SIZE),
      from,
      to,
      type,
      status,
    };
  }
  if (scope === 'shift') {
    refuse(['shiftId']);
    const shiftId = positiveInt(raw.shiftId, 'shiftId');
    if (!shiftId) throw new BadRequestException('"shiftId" is required for scope=shift.');
    return { scope, shiftId };
  }
  throw new BadRequestException(`"${scope}" is not an alert scope (operational, history or shift).`);
}
