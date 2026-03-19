import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Incident } from './entities/incident.entity';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { ShiftService } from '../shift/shift.service';
import { CompanyService } from '../company/company.service';

@Injectable()
export class IncidentService {
  constructor(
    @InjectRepository(Incident)
    private readonly incidentRepo: Repository<Incident>,
    private readonly guardProfileService: GuardProfileService,
    private readonly shiftService: ShiftService,
    private readonly companyService: CompanyService,
  ) {}

  async createForGuard(userId: number, dto: CreateIncidentDto): Promise<Incident> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    let shift = null;
    if (dto.shiftId) {
      shift = await this.shiftService.findOne(dto.shiftId);
      if (shift.guard.id !== guard.id) {
        throw new BadRequestException('This shift is not assigned to the current guard');
      }
    }

    const company = shift?.company;
    if (!company) {
      throw new BadRequestException('Incident reports must be linked to an assigned shift');
    }

    const incident = this.incidentRepo.create({
      company,
      guard,
      shift,
      title: dto.title,
      notes: dto.notes,
      severity: dto.severity,
      locationText: dto.locationText || null,
      status: 'open',
    });

    return this.incidentRepo.save(incident);
  }

  async findMine(userId: number): Promise<Incident[]> {
    const guard = await this.guardProfileService.findByUserId(userId);
    if (!guard) throw new NotFoundException('Guard profile not found');

    return this.incidentRepo.find({
      where: { guard: { id: guard.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async findForCompany(userId: number): Promise<Incident[]> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    return this.incidentRepo.find({
      where: { company: { id: company.id } },
      order: { createdAt: 'DESC' },
    });
  }

  async updateStatusForCompany(userId: number, incidentId: number, status: string): Promise<Incident> {
    const company = await this.companyService.findByUserId(userId);
    if (!company) throw new NotFoundException('Company not found');

    const incident = await this.incidentRepo.findOne({ where: { id: incidentId } });
    if (!incident) throw new NotFoundException('Incident not found');
    if (incident.company.id !== company.id) {
      throw new BadRequestException('This incident does not belong to the current company');
    }

    incident.status = status;
    return this.incidentRepo.save(incident);
  }
}
