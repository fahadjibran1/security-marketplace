import { EmergencyContactRelationship } from '../entities/guard-emergency-contact.entity';

export class EmergencyContactAdminResponseDto {
  guardId!: number;
  contactName!: string;
  relationship!: EmergencyContactRelationship;
  customRelationship!: string | null;
  primaryPhone!: string;
  alternatePhone!: string | null;
  updatedAt!: string;
}
