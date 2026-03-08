import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Shift } from './entities/shift.entity';
import { CreateShiftDto } from './dto/create-shift.dto';
import { AssignmentService } from '../assignment/assignment.service';
import { TimesheetService } from '../timesheet/timesheet.service';

@Injectable()
export class ShiftService {
  constructor(
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    private readonly assignmentService: AssignmentService,
    private readonly timesheetService: TimesheetService
  ) {}

  findAll(): Promise<Shift[]> {
    return this.shiftRepo.find();
  }

  async findOne(id: number): Promise<Shift> {
    const shift = await this.shiftRepo.findOne({ where: { id } });
    if (!shift) throw new NotFoundException('Shift not found');
    return shift;
  }

  async create(dto: CreateShiftDto) {
    const assignment = await this.assignmentService.findOne(dto.assignmentId);

    const shift = this.shiftRepo.create({
      assignment,
      company: assignment.company,
      guard: assignment.guard,
      siteName: dto.siteName,
      start: new Date(dto.start),
      end: new Date(dto.end),
      status: dto.status ?? 'scheduled'
    });

    const savedShift = await this.shiftRepo.save(shift);
    const timesheet = await this.timesheetService.createForShift(savedShift);

    return { shift: savedShift, timesheet };
  }
}
