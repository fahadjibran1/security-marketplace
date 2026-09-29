import { ValidationOptions, registerDecorator } from 'class-validator';
import { hasExplicitUtcOffset } from '../site-time';

/**
 * Validates that a scheduled-time field is a real INSTANT, not a bare wall clock. (Phase 1.)
 *
 * `@IsDateString()` accepts "2026-09-29T11:30:00", which carries no offset and therefore has no single
 * meaning. The server then resolved it with `new Date(...)` against its own clock, so an 11:30 BST shift
 * was stored as 11:30 UTC — an hour later than the operator meant. Every downstream comparison inherited
 * that hour: Book On reported a guard an hour early, and welfare windows opened an hour late.
 *
 * Rejecting the ambiguous form at the edge is what makes the fix hold. A client that has not been updated
 * gets a clear 400 naming the problem, instead of silently writing a wrong time.
 *
 * Deliberately NOT applied to attendance `occurredAt`: those events are recorded by the device at the
 * moment they happen and their semantics are unchanged by this phase.
 */
export function IsInstantString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isInstantString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const trimmed = value.trim();
          if (!hasExplicitUtcOffset(trimmed)) return false;
          return Number.isFinite(new Date(trimmed).getTime());
        },
        defaultMessage() {
          return (
            `${propertyName} must be an instant with an explicit UTC offset, ` +
            'for example 2026-09-29T11:30:00+01:00 or 2026-09-29T10:30:00Z. ' +
            'A date-time without an offset is a wall clock, not a point in time, ' +
            'and would be interpreted against the server clock rather than the site timezone.'
          );
        },
      },
    });
  };
}
