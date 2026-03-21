import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { Job } from '../../job/entities/job.entity';
import { Shift } from '../../shift/entities/shift.entity';

@Entity('sites')
export class Site {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.sites, { eager: true })
  company!: Company;

  @Column()
  name!: string;

  @Column({ nullable: true })
  clientName?: string;

  @Column()
  address!: string;

  @Column({ nullable: true })
  contactDetails?: string;

  @Column({ default: 'active' })
  status!: string;

  @Column({ type: 'int', default: 60 })
  welfareCheckIntervalMinutes!: number;

  @OneToMany(() => Job, (job) => job.site)
  jobs?: Job[];

  @OneToMany(() => Shift, (shift) => shift.site)
  shifts?: Shift[];
}
