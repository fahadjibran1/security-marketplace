/**
 * What a company user is shown about a guard, decided per membership role and per the company's relationship with
 * that guard (see toCompanyDto in guard-profile-response.mappers.ts). Only id and fullName are always present.
 *
 * approvalStatus is deliberately absent. It is platform-global legacy state that no longer affects
 * anything a Company can do, and a Company reading "approved" here would take it for an S4
 * endorsement of a Guard S4 may never have looked at. Screening state is served separately and
 * honestly by GET /screening/company/outcomes.
 *
 * The guard's user account, availability, location-sharing setting, notes and approval flags are never part of it.
 */
export class GuardProfileCompanyResponseDto {
  id!: number;
  fullName!: string;
  /** ACTIVE relationship, and a role with an operational need to contact the guard. */
  phone?: string;
  /** Every role except Finance and Viewer; kept for a former guard as a record-matching identifier. */
  siaLicenseNumber?: string;
  /** ACTIVE relationship only. */
  siaExpiryDate?: string | null;
}
