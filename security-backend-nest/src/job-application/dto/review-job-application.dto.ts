import { IsIn } from 'class-validator';

export class ReviewJobApplicationDto {
  @IsIn(['under_review', 'accepted', 'rejected'])
  status!: 'under_review' | 'accepted' | 'rejected';
}
