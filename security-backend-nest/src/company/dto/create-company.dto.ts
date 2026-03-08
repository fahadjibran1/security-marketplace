import { IsInt, IsString } from 'class-validator';

export class CreateCompanyDto {
  @IsInt()
  userId!: number;

  @IsString()
  name!: string;

  @IsString()
  companyNumber!: string;

  @IsString()
  address!: string;

  @IsString()
  contactDetails!: string;
}
