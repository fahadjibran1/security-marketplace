import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardScreeningWorkflow1720000000000 implements MigrationInterface {
  name = 'AddGuardScreeningWorkflow1720000000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='guard_screenings_status_enum') THEN CREATE TYPE guard_screenings_status_enum AS ENUM ('NOT_STARTED','IN_PROGRESS','READY_FOR_REVIEW','UNDER_REVIEW','VETTED','REQUIRES_ATTENTION','REJECTED','EXPIRED'); END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='screening_history_type_enum') THEN CREATE TYPE screening_history_type_enum AS ENUM ('EMPLOYMENT','SELF_EMPLOYMENT','EDUCATION','UNEMPLOYMENT','CAREER_BREAK','OVERSEAS','OTHER_EXPLAINED_PERIOD'); END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='screening_verification_state_enum') THEN CREATE TYPE screening_verification_state_enum AS ENUM ('UNVERIFIED','PENDING','VERIFIED','REJECTED'); END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='screening_reference_status_enum') THEN CREATE TYPE screening_reference_status_enum AS ENUM ('NOT_REQUESTED','REQUESTED','RECEIVED','SOURCE_VERIFICATION_REQUIRED','VERIFIED','UNABLE_TO_VERIFY','REJECTED'); END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='screening_evidence_category_enum') THEN CREATE TYPE screening_evidence_category_enum AS ENUM ('identity','address','employment','education','self_employment','unemployment','reference','right_to_work','sia','overseas','other'); END IF;
    END $$`);
    await q.query(`CREATE TABLE guard_screenings (
      id SERIAL PRIMARY KEY, "guardId" integer NOT NULL UNIQUE REFERENCES guard_profiles(id) ON DELETE CASCADE,
      status guard_screenings_status_enum NOT NULL DEFAULT 'NOT_STARTED', "screeningPeriodYears" integer NOT NULL DEFAULT 5,
      "legalFullName" varchar, "previousNames" text, "dateOfBirth" date, nationality varchar, "currentAddress" text,
      "identityVerification" screening_verification_state_enum NOT NULL DEFAULT 'UNVERIFIED', "identityVerificationMethod" varchar, "identityVerifiedByUserId" integer, "identityVerifiedAt" timestamp,
      "siaLicenceType" varchar, "siaRegisterVerification" screening_verification_state_enum NOT NULL DEFAULT 'UNVERIFIED', "siaVerifiedByUserId" integer, "siaVerifiedAt" timestamp,
      "rightToWorkCheckMethod" varchar, "rightToWorkCheckDate" date, "rightToWorkFollowUpDate" date, "rightToWorkVerification" screening_verification_state_enum NOT NULL DEFAULT 'UNVERIFIED', "rightToWorkVerifiedByUserId" integer, "rightToWorkVerifiedAt" timestamp,
      "reviewNotes" text, "submittedAt" timestamp, "reviewedByUserId" integer, "reviewedAt" timestamp, "vettedAt" timestamp, "retentionReviewAt" timestamp,
      "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(), CHECK ("screeningPeriodYears" BETWEEN 1 AND 10)
    )`);
    await q.query(`CREATE TABLE screening_history (id SERIAL PRIMARY KEY, "screeningId" integer NOT NULL REFERENCES guard_screenings(id) ON DELETE CASCADE, type screening_history_type_enum NOT NULL, "startDate" date NOT NULL, "endDate" date, "isCurrent" boolean NOT NULL DEFAULT false, organisation varchar, address text, "contactDetails" varchar, description text NOT NULL, "verificationState" screening_verification_state_enum NOT NULL DEFAULT 'UNVERIFIED', "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(), CHECK (("isCurrent"=true AND "endDate" IS NULL) OR ("isCurrent"=false AND "endDate" IS NOT NULL)), CHECK ("endDate" IS NULL OR "endDate">="startDate"))`);
    await q.query(`CREATE TABLE screening_addresses (id SERIAL PRIMARY KEY, "screeningId" integer NOT NULL REFERENCES guard_screenings(id) ON DELETE CASCADE, address text NOT NULL, "startDate" date NOT NULL, "endDate" date, "isCurrent" boolean NOT NULL DEFAULT false, "verificationState" screening_verification_state_enum NOT NULL DEFAULT 'UNVERIFIED', "createdAt" timestamp NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE screening_references (id SERIAL PRIMARY KEY, "screeningId" integer NOT NULL REFERENCES guard_screenings(id) ON DELETE CASCADE, "historyId" integer NOT NULL REFERENCES screening_history(id) ON DELETE CASCADE, organisation varchar NOT NULL, "contactPerson" varchar NOT NULL, relationship varchar NOT NULL, "businessEmail" varchar NOT NULL, phone varchar, "postalDetails" text, status screening_reference_status_enum NOT NULL DEFAULT 'NOT_REQUESTED', "requestedAt" timestamp, "receivedAt" timestamp, "verificationMethod" varchar, "sourceVerified" boolean NOT NULL DEFAULT false, "verifiedByUserId" integer, "verifiedAt" timestamp, "outcomeNotes" text, "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE screening_evidence (id SERIAL PRIMARY KEY, "screeningId" integer NOT NULL REFERENCES guard_screenings(id) ON DELETE CASCADE, category screening_evidence_category_enum NOT NULL, "storageProvider" varchar NOT NULL, "storageKey" varchar NOT NULL UNIQUE, "originalFileName" varchar NOT NULL, "mimeType" varchar NOT NULL, "sizeBytes" bigint NOT NULL, "uploadCompletedAt" timestamp, "verificationState" screening_verification_state_enum NOT NULL DEFAULT 'UNVERIFIED', "uploadedByUserId" integer NOT NULL, "verifiedByUserId" integer, "verifiedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE screening_consents (id SERIAL PRIMARY KEY, "screeningId" integer NOT NULL REFERENCES guard_screenings(id) ON DELETE CASCADE, "consentVersion" varchar NOT NULL, "candidateUserId" integer NOT NULL, "acceptedAt" timestamp NOT NULL, "withdrawnAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE screening_exceptions (id SERIAL PRIMARY KEY, "screeningId" integer NOT NULL REFERENCES guard_screenings(id) ON DELETE CASCADE, code varchar NOT NULL, description text NOT NULL, resolved boolean NOT NULL DEFAULT false, "resolvedByUserId" integer, "resolvedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now())`);
    await q.query(`CREATE INDEX "IDX_screening_history_screening_dates" ON screening_history("screeningId","startDate","endDate"); CREATE INDEX "IDX_screening_reference_screening" ON screening_references("screeningId"); CREATE INDEX "IDX_screening_evidence_screening" ON screening_evidence("screeningId");`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS screening_exceptions, screening_consents, screening_evidence, screening_references, screening_addresses, screening_history, guard_screenings CASCADE`);
    await q.query(`DROP TYPE IF EXISTS screening_evidence_category_enum, screening_reference_status_enum, screening_verification_state_enum, screening_history_type_enum, guard_screenings_status_enum`);
  }
}
