import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { COMPANY_VIEW_ROLES, UserRole } from '../user/entities/user.entity';
import { AddAddressDto, AddHistoryDto, AddReferenceDto, ConsentDto, CreateEvidenceDto, ReviewActionDto, ReviewReferenceDto, StartScreeningDto, UpdateScreeningProfileDto, VerifyCheckDto } from './dto/screening.dto';
import { ScreeningService } from './screening.service';

@Controller('screening') @UseGuards(JwtAuthGuard, RolesGuard)
export class ScreeningController {
  constructor(private readonly service: ScreeningService) {}
  @Post('mine/start') @Roles(UserRole.GUARD) start(@CurrentUser() u:JwtPayload,@Body() d:StartScreeningDto){return this.service.start(u.sub,d);}
  @Get('mine') @Roles(UserRole.GUARD) mine(@CurrentUser() u:JwtPayload){return this.service.mine(u.sub);}
  @Put('mine/profile') @Roles(UserRole.GUARD) profile(@CurrentUser() u:JwtPayload,@Body() d:UpdateScreeningProfileDto){return this.service.updateProfile(u.sub,d);}
  @Post('mine/history') @Roles(UserRole.GUARD) history(@CurrentUser() u:JwtPayload,@Body() d:AddHistoryDto){return this.service.addHistory(u.sub,d);}
  @Post('mine/addresses') @Roles(UserRole.GUARD) address(@CurrentUser() u:JwtPayload,@Body() d:AddAddressDto){return this.service.addAddress(u.sub,d);}
  @Post('mine/references') @Roles(UserRole.GUARD) reference(@CurrentUser() u:JwtPayload,@Body() d:AddReferenceDto){return this.service.addReference(u.sub,d);}
  @Post('mine/consent') @Roles(UserRole.GUARD) consent(@CurrentUser() u:JwtPayload,@Body() d:ConsentDto){return this.service.consent(u.sub,d);}
  @Post('mine/evidence') @Roles(UserRole.GUARD) evidence(@CurrentUser() u:JwtPayload,@Body() d:CreateEvidenceDto){return this.service.createEvidence(u.sub,d);}
  @Post('evidence/:id/complete-upload') @Roles(UserRole.GUARD,UserRole.ADMIN) completeEvidence(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number){return this.service.completeEvidence(u,id);}
  @Get('evidence/:id/access') @Roles(UserRole.GUARD,UserRole.ADMIN) accessEvidence(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number){return this.service.accessEvidence(u,id);}
  @Post('mine/submit') @Roles(UserRole.GUARD) submit(@CurrentUser() u:JwtPayload){return this.service.submit(u.sub);}
  @Get('company/guards/:guardId/outcome') @Roles(...COMPANY_VIEW_ROLES) outcome(@CurrentUser() u:JwtPayload,@Param('guardId',ParseIntPipe) id:number){return this.service.companyOutcome(u.sub,id);}
  @Get() @Roles(UserRole.ADMIN) list(){return this.service.listAdmin();}
  @Get(':id') @Roles(UserRole.ADMIN) get(@Param('id',ParseIntPipe) id:number){return this.service.adminGet(id);}
  @Post(':id/start-review') @Roles(UserRole.ADMIN) review(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number){return this.service.startReview(u.sub,id);}
  @Patch(':id/checks/:check') @Roles(UserRole.ADMIN) check(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number,@Param('check') check:string,@Body() d:VerifyCheckDto){if(!['identity','address','sia','rtw'].includes(check))throw new BadRequestException('Unsupported screening check.');return this.service.verifyCheck(u.sub,id,check as 'identity'|'address'|'sia'|'rtw',d);}
  @Post('references/:id/request') @Roles(UserRole.ADMIN) requestReference(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number){return this.service.requestReference(u.sub,id);}
  @Patch('references/:id/review') @Roles(UserRole.ADMIN) reviewReference(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number,@Body() d:ReviewReferenceDto){return this.service.reviewReference(u.sub,id,d);}
  @Post(':id/request-information') @Roles(UserRole.ADMIN) request(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number,@Body() d:ReviewActionDto){return this.service.requestInfo(u.sub,id,d);}
  @Post(':id/complete') @Roles(UserRole.ADMIN) complete(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number,@Body() d:ReviewActionDto){return this.service.complete(u.sub,id,d);}
  @Post(':id/reject') @Roles(UserRole.ADMIN) reject(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number,@Body() d:ReviewActionDto){return this.service.reject(u.sub,id,d);}
  @Post(':id/expire') @Roles(UserRole.ADMIN) expire(@CurrentUser() u:JwtPayload,@Param('id',ParseIntPipe) id:number,@Body() d:ReviewActionDto){return this.service.expire(u.sub,id,d);}
}
