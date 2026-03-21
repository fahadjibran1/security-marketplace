import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Shift } from './entities/shift.entity';
import { CreateShiftDto } from './dto/create-shift.dto';
import { AssignmentService } from '../assignment/assignment.service';
import { TimesheetService } from '../timesheet/timesheet.service';
import { SiteService } from '../site/site.service';

@Injectable()
export class ShiftService {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepo: Repository<Shift>,
    private readonly assignmentService: AssignmentService,
    private readonly timesheetService: TimesheetService,
    private readonly siteService: SiteService,
  ) {}

  async findAll(): Promise<Shift[]> {
    return this.shiftRepo.find({
      relations: ['assignment', 'company', 'guard'],
    });
  }

  async findOne(id: number): Promise<Shift> {
    const shift = await this.shiftRepo.findOne({
      where: { id },
      relations: ['assignment', 'company', 'guard'],
    });

    if (!shift) {
      throw new NotFoundException(`Shift with id ${id} not found`);
    }

    return shift;
  }

  async create(dto: CreateShiftDto) {
    const assignment = await this.assignmentService.findOne(dto.assignmentId);
    const site = dto.siteId ? await this.siteService.findOne(dto.siteId) : null;

    const shift = this.shiftRepo.create({
      assignment,
      company: assignment.company,
      guard: assignment.guard,
      site,
      siteName: site?.name || dto.siteName || 'Unassigned Site',
      start: new Date(dto.start),
      end: new Date(dto.end),
      status: dto.status ?? 'scheduled',
    });

    const savedShift = await this.shiftRepo.save(shift);
    const timesheet = await this.timesheetService.createForShift(savedShift);

    return { shift: savedShift, timesheet };
  }

  save(shift: Shift): Promise<Shift> {
    return this.shiftRepo.save(shift);
  }
}
