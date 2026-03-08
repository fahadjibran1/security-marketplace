# security-backend full file export

This document contains full contents for every file under `security-backend/`.

## File tree

```text
.env.example
README.md
nest-cli.json
package.json
src/app.module.ts
src/assignment/assignment.controller.ts
src/assignment/assignment.module.ts
src/assignment/assignment.service.ts
src/assignment/entities/assignment.entity.ts
src/auth/auth.controller.ts
src/auth/auth.module.ts
src/auth/auth.service.ts
src/auth/dto/login.dto.ts
src/auth/dto/register.dto.ts
src/auth/jwt.strategy.ts
src/auth/types/jwt-payload.type.ts
src/common/decorators/current-user.decorator.ts
src/common/decorators/roles.decorator.ts
src/common/guards/jwt-auth.guard.ts
src/common/guards/roles.guard.ts
src/company/company.controller.ts
src/company/company.module.ts
src/company/company.service.ts
src/company/dto/create-company.dto.ts
src/company/entities/company.entity.ts
src/guard-profile/dto/create-guard-profile.dto.ts
src/guard-profile/entities/guard-profile.entity.ts
src/guard-profile/guard-profile.controller.ts
src/guard-profile/guard-profile.module.ts
src/guard-profile/guard-profile.service.ts
src/job/dto/create-job.dto.ts
src/job/entities/job.entity.ts
src/job/job.controller.ts
src/job/job.module.ts
src/job/job.service.ts
src/job-application/dto/create-job-application.dto.ts
src/job-application/dto/hire-application.dto.ts
src/job-application/entities/job-application.entity.ts
src/job-application/job-application.controller.ts
src/job-application/job-application.module.ts
src/job-application/job-application.service.ts
src/main.ts
src/shift/dto/create-shift.dto.ts
src/shift/entities/shift.entity.ts
src/shift/shift.controller.ts
src/shift/shift.module.ts
src/shift/shift.service.ts
src/timesheet/dto/update-timesheet.dto.ts
src/timesheet/entities/timesheet.entity.ts
src/timesheet/timesheet.controller.ts
src/timesheet/timesheet.module.ts
src/timesheet/timesheet.service.ts
src/user/dto/create-user.dto.ts
src/user/entities/user.entity.ts
src/user/user.module.ts
src/user/user.service.ts
tsconfig.json
```

## .env.example

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=security_mvp
DATABASE_SSL=false
JWT_SECRET=super-secret-change-me
JWT_EXPIRES_IN=1d
```

## README.md

```text
# Security Backend (NestJS + PostgreSQL)

Standalone backend-first MVP for the security companies/guards platform.

## Stack
- NestJS
- TypeORM
- PostgreSQL
- JWT authentication + role-based authorization

## Included modules
- Auth
- CompanyProfile
- GuardProfile
- Job
- JobApplication
- Assignment
- Shift
- Timesheet

## Domain guarantees
- `Job` is a requirement with `guardsRequired`.
- A `Job` can have multiple hired guards.
- Hiring a `JobApplication` creates an `Assignment`.
- `Shift` is separate from `Job` and linked to `Assignment`.
- `Timesheet` is separate from `Shift` and auto-created for each new shift.

## Setup
```bash
cd security-backend
cp .env.example .env
npm install
npm run build
npm run start:dev
```

## Production start
```bash
npm run build
npm run start:prod
```

## MVP flow
1. Register and login (`/auth/register`, `/auth/login`)
2. Company creates job (`POST /jobs`)
3. Guard applies (`POST /job-applications`)
4. Company hires application (`POST /job-applications/:id/hire`) => Assignment
5. Company creates shift (`POST /shifts`) => Timesheet auto-created
```

## nest-cli.json

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

## package.json

```json
{
  "name": "security-backend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "nest start",
    "start:dev": "nest start --watch",
    "build": "nest build",
    "lint": "eslint \"src/**/*.ts\"",
    "typeorm": "ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli.js",
    "start:prod": "node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.2",
    "@nestjs/config": "^3.2.3",
    "@nestjs/core": "^10.4.2",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/passport": "^10.0.3",
    "@nestjs/platform-express": "^10.4.2",
    "@nestjs/typeorm": "^10.0.2",
    "bcrypt": "^5.1.1",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.1",
    "pg": "^8.13.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typeorm": "^0.3.20"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.5",
    "@nestjs/schematics": "^10.1.4",
    "@nestjs/testing": "^10.4.2",
    "@types/bcrypt": "^5.0.2",
    "@types/express": "^4.17.21",
    "@types/node": "^20.16.9",
    "@types/passport-jwt": "^4.0.1",
    "eslint": "^8.57.1",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-prettier": "^5.2.1",
    "prettier": "^3.3.3",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.6.2"
  }
}
```

## src/app.module.ts

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { CompanyModule } from './company/company.module';
import { GuardProfileModule } from './guard-profile/guard-profile.module';
import { JobModule } from './job/job.module';
import { JobApplicationModule } from './job-application/job-application.module';
import { AssignmentModule } from './assignment/assignment.module';
import { ShiftModule } from './shift/shift.module';
import { TimesheetModule } from './timesheet/timesheet.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DATABASE_HOST', 'localhost'),
        port: config.get<number>('DATABASE_PORT', 5432),
        username: config.get<string>('DATABASE_USER', 'postgres'),
        password: config.get<string>('DATABASE_PASSWORD', 'postgres'),
        database: config.get<string>('DATABASE_NAME', 'security_mvp'),
        autoLoadEntities: true,
        synchronize: true,
        ssl: config.get<string>('DATABASE_SSL', 'false') === 'true' ? { rejectUnauthorized: false } : false
      })
    }),
    UserModule,
    AuthModule,
    CompanyModule,
    GuardProfileModule,
    JobModule,
    JobApplicationModule,
    AssignmentModule,
    ShiftModule,
    TimesheetModule
  ]
})
export class AppModule {}
```

## src/assignment/assignment.controller.ts

```ts
import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.assignmentService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.assignmentService.findOne(id);
  }
}
```

## src/assignment/assignment.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Assignment } from './entities/assignment.entity';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';

@Module({
  imports: [TypeOrmModule.forFeature([Assignment])],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService, TypeOrmModule]
})
export class AssignmentModule {}
```

## src/assignment/assignment.service.ts

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Assignment } from './entities/assignment.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';

@Injectable()
export class AssignmentService {
  constructor(@InjectRepository(Assignment) private readonly assignmentRepo: Repository<Assignment>) {}

  findAll(): Promise<Assignment[]> {
    return this.assignmentRepo.find();
  }

  async findOne(id: number): Promise<Assignment> {
    const assignment = await this.assignmentRepo.findOne({ where: { id } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    return assignment;
  }

  async countActiveByJob(jobId: number): Promise<number> {
    return this.assignmentRepo.count({ where: { job: { id: jobId }, status: 'active' } });
  }

  async createFromHire(application: JobApplication): Promise<Assignment> {
    const assignment = this.assignmentRepo.create({
      job: application.job,
      company: application.job.company,
      guard: application.guard,
      application,
      status: 'active'
    });

    return this.assignmentRepo.save(assignment);
  }
}
```

## src/assignment/entities/assignment.entity.ts

```ts
import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Job } from '../../job/entities/job.entity';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Shift } from '../../shift/entities/shift.entity';

@Entity('assignments')
export class Assignment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.assignments, { eager: true })
  job!: Job;

  @ManyToOne(() => Company, (company) => company.assignments, { eager: true })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.assignments, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => JobApplication, (application) => application.assignments, { eager: true })
  application!: JobApplication;

  @Column({ default: 'active' })
  status!: string;

  @CreateDateColumn()
  hiredAt!: Date;

  @OneToMany(() => Shift, (shift) => shift.assignment)
  shifts?: Shift[];
}
```

## src/auth/auth.controller.ts

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
```

## src/auth/auth.module.ts

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserModule } from '../user/user.module';
import { JwtStrategy } from './jwt.strategy';
import { CompanyModule } from '../company/company.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';

@Module({
  imports: [
    ConfigModule,
    UserModule,
    CompanyModule,
    GuardProfileModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'super-secret-change-me'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1d') }
      })
    })
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService]
})
export class AuthModule {}
```

## src/auth/auth.service.ts

```ts
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserRole } from '../user/entities/user.entity';
import { CompanyService } from '../company/company.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UserService,
    private readonly jwtService: JwtService,
    private readonly companyService: CompanyService,
    private readonly guardProfileService: GuardProfileService
  ) {}

  async register(dto: RegisterDto) {
    const user = await this.usersService.create({
      email: dto.email,
      password: dto.password,
      role: dto.role
    });

    if (dto.role === UserRole.COMPANY) {
      if (!dto.companyName || !dto.companyNumber || !dto.address || !dto.contactDetails) {
        throw new BadRequestException('Company fields are required for company role');
      }

      await this.companyService.create({
        userId: user.id,
        name: dto.companyName,
        companyNumber: dto.companyNumber,
        address: dto.address,
        contactDetails: dto.contactDetails
      });
    }

    if (dto.role === UserRole.GUARD) {
      if (!dto.fullName || !dto.siaLicenseNumber || !dto.phone) {
        throw new BadRequestException('Guard fields are required for guard role');
      }

      await this.guardProfileService.create({
        userId: user.id,
        fullName: dto.fullName,
        siaLicenseNumber: dto.siaLicenseNumber,
        phone: dto.phone,
        locationSharingEnabled: false,
        status: 'pending'
      });
    }

    return this.signToken(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.signToken(user.id, user.email, user.role);
  }

  private signToken(userId: number, email: string, role: UserRole) {
    const payload = { sub: userId, email, role };
    return {
      accessToken: this.jwtService.sign(payload),
      user: { id: userId, email, role }
    };
  }
}
```

## src/auth/dto/login.dto.ts

```ts
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
```

## src/auth/dto/register.dto.ts

```ts
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '../../user/entities/user.entity';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  siaLicenseNumber?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  companyNumber?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  contactDetails?: string;
}
```

## src/auth/jwt.strategy.ts

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './types/jwt-payload.type';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'super-secret-change-me')
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
```

## src/auth/types/jwt-payload.type.ts

```ts
import { UserRole } from '../../user/entities/user.entity';

export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
}
```

## src/common/decorators/current-user.decorator.ts

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from '../../auth/types/jwt-payload.type';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
    return request.user;
  }
);
```

## src/common/decorators/roles.decorator.ts

```ts
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../user/entities/user.entity';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
```

## src/common/guards/jwt-auth.guard.ts

```ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

## src/common/guards/roles.guard.ts

```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { JwtPayload } from '../../auth/types/jwt-payload.type';
import { UserRole } from '../../user/entities/user.entity';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();
    const role = request.user?.role;
    return !!role && requiredRoles.includes(role);
  }
}
```

## src/company/company.controller.ts

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findAll() {
    return this.companyService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.companyService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateCompanyDto) {
    return this.companyService.create(dto);
  }
}
```

## src/company/company.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from './entities/company.entity';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';
import { UserModule } from '../user/user.module';

@Module({
  imports: [TypeOrmModule.forFeature([Company]), UserModule],
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService, TypeOrmModule]
})
export class CompanyModule {}
```

## src/company/company.service.ts

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Company } from './entities/company.entity';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UserService } from '../user/user.service';

@Injectable()
export class CompanyService {
  constructor(
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
    private readonly userService: UserService
  ) {}

  async create(dto: CreateCompanyDto): Promise<Company> {
    const user = await this.userService.findById(dto.userId);
    const company = this.companyRepo.create({ ...dto, user });
    return this.companyRepo.save(company);
  }

  findAll(): Promise<Company[]> {
    return this.companyRepo.find();
  }

  async findOne(id: number): Promise<Company> {
    const company = await this.companyRepo.findOne({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }
}
```

## src/company/dto/create-company.dto.ts

```ts
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
```

## src/company/entities/company.entity.ts

```ts
import { Column, Entity, JoinColumn, OneToMany, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { Job } from '../../job/entities/job.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  name!: string;

  @Column()
  companyNumber!: string;

  @Column()
  address!: string;

  @Column()
  contactDetails!: string;

  @OneToMany(() => Job, (job) => job.company)
  jobs?: Job[];

  @OneToMany(() => Assignment, (assignment) => assignment.company)
  assignments?: Assignment[];

  @OneToMany(() => Shift, (shift) => shift.company)
  shifts?: Shift[];

  @OneToMany(() => Timesheet, (timesheet) => timesheet.company)
  timesheets?: Timesheet[];
}
```

## src/guard-profile/dto/create-guard-profile.dto.ts

```ts
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateGuardProfileDto {
  @IsInt()
  userId!: number;

  @IsString()
  fullName!: string;

  @IsString()
  siaLicenseNumber!: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsBoolean()
  locationSharingEnabled?: boolean;

  @IsOptional()
  @IsString()
  status?: string;
}
```

## src/guard-profile/entities/guard-profile.entity.ts

```ts
import { Column, Entity, JoinColumn, OneToMany, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Shift } from '../../shift/entities/shift.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('guard_profiles')
export class GuardProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { eager: true })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  fullName!: string;

  @Column({ unique: true })
  siaLicenseNumber!: string;

  @Column()
  phone!: string;

  @Column({ default: false })
  locationSharingEnabled!: boolean;

  @Column({ default: 'pending' })
  status!: string;

  @OneToMany(() => JobApplication, (application) => application.guard)
  applications?: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.guard)
  assignments?: Assignment[];

  @OneToMany(() => Shift, (shift) => shift.guard)
  shifts?: Shift[];

  @OneToMany(() => Timesheet, (timesheet) => timesheet.guard)
  timesheets?: Timesheet[];
}
```

## src/guard-profile/guard-profile.controller.ts

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { GuardProfileService } from './guard-profile.service';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('guards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GuardProfileController {
  constructor(private readonly guardService: GuardProfileService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  findAll() {
    return this.guardService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.guardService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateGuardProfileDto) {
    return this.guardService.create(dto);
  }
}
```

## src/guard-profile/guard-profile.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GuardProfile } from './entities/guard-profile.entity';
import { GuardProfileController } from './guard-profile.controller';
import { GuardProfileService } from './guard-profile.service';
import { UserModule } from '../user/user.module';

@Module({
  imports: [TypeOrmModule.forFeature([GuardProfile]), UserModule],
  controllers: [GuardProfileController],
  providers: [GuardProfileService],
  exports: [GuardProfileService, TypeOrmModule]
})
export class GuardProfileModule {}
```

## src/guard-profile/guard-profile.service.ts

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuardProfile } from './entities/guard-profile.entity';
import { CreateGuardProfileDto } from './dto/create-guard-profile.dto';
import { UserService } from '../user/user.service';

@Injectable()
export class GuardProfileService {
  constructor(
    @InjectRepository(GuardProfile) private readonly guardRepo: Repository<GuardProfile>,
    private readonly userService: UserService
  ) {}

  async create(dto: CreateGuardProfileDto): Promise<GuardProfile> {
    const user = await this.userService.findById(dto.userId);
    const guard = this.guardRepo.create({
      ...dto,
      user,
      locationSharingEnabled: dto.locationSharingEnabled ?? false,
      status: dto.status ?? 'pending'
    });
    return this.guardRepo.save(guard);
  }

  findAll(): Promise<GuardProfile[]> {
    return this.guardRepo.find();
  }

  async findOne(id: number): Promise<GuardProfile> {
    const guard = await this.guardRepo.findOne({ where: { id } });
    if (!guard) throw new NotFoundException('Guard profile not found');
    return guard;
  }
}
```

## src/job/dto/create-job.dto.ts

```ts
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateJobDto {
  @IsInt()
  companyId!: number;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  guardsRequired!: number;

  @IsNumber()
  @Min(0)
  hourlyRate!: number;

  @IsOptional()
  @IsString()
  status?: string;
}
```

## src/job/entities/job.entity.ts

```ts
import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Company, (company) => company.jobs, { eager: true })
  company!: Company;

  @Column()
  title!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'int' })
  guardsRequired!: number;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  hourlyRate!: number;

  @Column({ default: 'open' })
  status!: string;

  @OneToMany(() => JobApplication, (application) => application.job)
  applications?: JobApplication[];

  @OneToMany(() => Assignment, (assignment) => assignment.job)
  assignments?: Assignment[];
}
```

## src/job/job.controller.ts

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JobService } from './job.service';
import { CreateJobDto } from './dto/create-job.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobController {
  constructor(private readonly jobService: JobService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.jobService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.jobService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  create(@Body() dto: CreateJobDto) {
    return this.jobService.create(dto);
  }
}
```

## src/job/job.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from './entities/job.entity';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { CompanyModule } from '../company/company.module';

@Module({
  imports: [TypeOrmModule.forFeature([Job]), CompanyModule],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService, TypeOrmModule]
})
export class JobModule {}
```

## src/job/job.service.ts

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { CompanyService } from '../company/company.service';

@Injectable()
export class JobService {
  constructor(
    @InjectRepository(Job) private readonly jobRepo: Repository<Job>,
    private readonly companyService: CompanyService
  ) {}

  async create(dto: CreateJobDto): Promise<Job> {
    const company = await this.companyService.findOne(dto.companyId);
    const job = this.jobRepo.create({
      company,
      title: dto.title,
      description: dto.description,
      guardsRequired: dto.guardsRequired,
      hourlyRate: dto.hourlyRate,
      status: dto.status ?? 'open'
    });
    return this.jobRepo.save(job);
  }

  findAll(): Promise<Job[]> {
    return this.jobRepo.find();
  }

  async findOne(id: number): Promise<Job> {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
```

## src/job-application/dto/create-job-application.dto.ts

```ts
import { IsInt } from 'class-validator';

export class CreateJobApplicationDto {
  @IsInt()
  jobId!: number;

  @IsInt()
  guardId!: number;
}
```

## src/job-application/dto/hire-application.dto.ts

```ts
import { IsBoolean, IsDateString, IsOptional, IsString } from 'class-validator';

export class HireApplicationDto {
  @IsOptional()
  @IsBoolean()
  createShift?: boolean;

  @IsOptional()
  @IsString()
  siteName?: string;

  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;
}
```

## src/job-application/entities/job-application.entity.ts

```ts
import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Job } from '../../job/entities/job.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Assignment } from '../../assignment/entities/assignment.entity';

@Entity('job_applications')
export class JobApplication {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, (job) => job.applications, { eager: true })
  job!: Job;

  @ManyToOne(() => GuardProfile, (guard) => guard.applications, { eager: true })
  guard!: GuardProfile;

  @Column({ default: 'submitted' })
  status!: string;

  @CreateDateColumn()
  appliedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  hiredAt?: Date;

  @OneToMany(() => Assignment, (assignment) => assignment.application)
  assignments?: Assignment[];
}
```

## src/job-application/job-application.controller.ts

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JobApplicationService } from './job-application.service';
import { CreateJobApplicationDto } from './dto/create-job-application.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { HireApplicationDto } from './dto/hire-application.dto';

@Controller('job-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobApplicationController {
  constructor(private readonly jobApplicationService: JobApplicationService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.jobApplicationService.findAll();
  }

  @Post()
  @Roles(UserRole.GUARD, UserRole.ADMIN)
  create(@Body() dto: CreateJobApplicationDto) {
    return this.jobApplicationService.create(dto);
  }

  @Post(':id/hire')
  @Roles(UserRole.COMPANY, UserRole.ADMIN)
  hire(@Param('id', ParseIntPipe) id: number, @Body() dto: HireApplicationDto) {
    return this.jobApplicationService.hire(id, dto);
  }
}
```

## src/job-application/job-application.module.ts

```ts
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobApplication } from './entities/job-application.entity';
import { JobApplicationController } from './job-application.controller';
import { JobApplicationService } from './job-application.service';
import { JobModule } from '../job/job.module';
import { GuardProfileModule } from '../guard-profile/guard-profile.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { ShiftModule } from '../shift/shift.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([JobApplication]),
    JobModule,
    GuardProfileModule,
    forwardRef(() => AssignmentModule),
    forwardRef(() => ShiftModule)
  ],
  controllers: [JobApplicationController],
  providers: [JobApplicationService],
  exports: [JobApplicationService, TypeOrmModule]
})
export class JobApplicationModule {}
```

## src/job-application/job-application.service.ts

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobApplication } from './entities/job-application.entity';
import { CreateJobApplicationDto } from './dto/create-job-application.dto';
import { JobService } from '../job/job.service';
import { GuardProfileService } from '../guard-profile/guard-profile.service';
import { AssignmentService } from '../assignment/assignment.service';
import { HireApplicationDto } from './dto/hire-application.dto';
import { ShiftService } from '../shift/shift.service';

@Injectable()
export class JobApplicationService {
  constructor(
    @InjectRepository(JobApplication)
    private readonly appRepo: Repository<JobApplication>,
    private readonly jobsService: JobService,
    private readonly guardService: GuardProfileService,
    private readonly assignmentService: AssignmentService,
    private readonly shiftService: ShiftService
  ) {}

  findAll(): Promise<JobApplication[]> {
    return this.appRepo.find();
  }

  async findOne(id: number): Promise<JobApplication> {
    const app = await this.appRepo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('Job application not found');
    return app;
  }

  async create(dto: CreateJobApplicationDto): Promise<JobApplication> {
    const job = await this.jobsService.findOne(dto.jobId);
    const guard = await this.guardService.findOne(dto.guardId);

    const existing = await this.appRepo.findOne({
      where: {
        job: { id: job.id },
        guard: { id: guard.id }
      }
    });

    if (existing) throw new ConflictException('Application already exists for this guard/job');

    const application = this.appRepo.create({ job, guard, status: 'submitted' });
    return this.appRepo.save(application);
  }

  async hire(applicationId: number, dto: HireApplicationDto) {
    const application = await this.findOne(applicationId);
    if (application.status === 'hired') throw new ConflictException('Application already hired');

    const activeCount = await this.assignmentService.countActiveByJob(application.job.id);
    if (activeCount >= application.job.guardsRequired) {
      throw new ConflictException('Job guard capacity reached');
    }

    application.status = 'hired';
    application.hiredAt = new Date();
    await this.appRepo.save(application);

    const assignment = await this.assignmentService.createFromHire(application);

    let shiftResult: unknown = null;
    if (dto.createShift) {
      if (!dto.siteName || !dto.start || !dto.end) {
        throw new BadRequestException('siteName, start, end are required when createShift=true');
      }

      shiftResult = await this.shiftService.create({
        assignmentId: assignment.id,
        siteName: dto.siteName,
        start: dto.start,
        end: dto.end
      });
    }

    return {
      application,
      assignment,
      shiftBundle: shiftResult
    };
  }
}
```

## src/main.ts

```ts
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Security MVP backend running on http://localhost:${port}`);
}

bootstrap();
```

## src/shift/dto/create-shift.dto.ts

```ts
import { IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateShiftDto {
  @IsInt()
  assignmentId!: number;

  @IsString()
  siteName!: string;

  @IsDateString()
  start!: string;

  @IsDateString()
  end!: string;

  @IsOptional()
  @IsString()
  status?: string;
}
```

## src/shift/entities/shift.entity.ts

```ts
import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Assignment } from '../../assignment/entities/assignment.entity';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Timesheet } from '../../timesheet/entities/timesheet.entity';

@Entity('shifts')
export class Shift {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Assignment, (assignment) => assignment.shifts, { eager: true })
  assignment!: Assignment;

  @ManyToOne(() => Company, (company) => company.shifts, { eager: true })
  company!: Company;

  @ManyToOne(() => GuardProfile, (guard) => guard.shifts, { eager: true })
  guard!: GuardProfile;

  @Column()
  siteName!: string;

  @Column({ type: 'timestamp' })
  start!: Date;

  @Column({ type: 'timestamp' })
  end!: Date;

  @Column({ default: 'scheduled' })
  status!: string;

  @OneToMany(() => Timesheet, (timesheet) => timesheet.shift)
  timesheets?: Timesheet[];
}
```

## src/shift/shift.controller.ts

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ShiftService } from './shift.service';
import { CreateShiftDto } from './dto/create-shift.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';

@Controller('shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.shiftService.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  create(@Body() dto: CreateShiftDto) {
    return this.shiftService.create(dto);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.shiftService.findOne(id);
  }
}
```

## src/shift/shift.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Shift } from './entities/shift.entity';
import { ShiftController } from './shift.controller';
import { ShiftService } from './shift.service';
import { AssignmentModule } from '../assignment/assignment.module';
import { TimesheetModule } from '../timesheet/timesheet.module';

@Module({
  imports: [TypeOrmModule.forFeature([Shift]), AssignmentModule, TimesheetModule],
  controllers: [ShiftController],
  providers: [ShiftService],
  exports: [ShiftService, TypeOrmModule]
})
export class ShiftModule {}
```

## src/shift/shift.service.ts

```ts
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
```

## src/timesheet/dto/update-timesheet.dto.ts

```ts
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateTimesheetDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  hoursWorked?: number;

  @IsOptional()
  @IsString()
  approvalStatus?: string;
}
```

## src/timesheet/entities/timesheet.entity.ts

```ts
import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Shift } from '../../shift/entities/shift.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';
import { Company } from '../../company/entities/company.entity';

@Entity('timesheets')
export class Timesheet {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Shift, (shift) => shift.timesheets, { eager: true })
  shift!: Shift;

  @ManyToOne(() => GuardProfile, (guard) => guard.timesheets, { eager: true })
  guard!: GuardProfile;

  @ManyToOne(() => Company, (company) => company.timesheets, { eager: true })
  company!: Company;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  hoursWorked!: number;

  @Column({ default: 'pending' })
  approvalStatus!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
```

## src/timesheet/timesheet.controller.ts

```ts
import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { TimesheetService } from './timesheet.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../user/entities/user.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';

@Controller('timesheets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TimesheetController {
  constructor(private readonly timesheetService: TimesheetService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.COMPANY, UserRole.GUARD)
  findAll() {
    return this.timesheetService.findAll();
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.COMPANY)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTimesheetDto) {
    return this.timesheetService.update(id, dto);
  }
}
```

## src/timesheet/timesheet.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Timesheet } from './entities/timesheet.entity';
import { TimesheetController } from './timesheet.controller';
import { TimesheetService } from './timesheet.service';

@Module({
  imports: [TypeOrmModule.forFeature([Timesheet])],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService, TypeOrmModule]
})
export class TimesheetModule {}
```

## src/timesheet/timesheet.service.ts

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Timesheet } from './entities/timesheet.entity';
import { Shift } from '../shift/entities/shift.entity';
import { UpdateTimesheetDto } from './dto/update-timesheet.dto';

@Injectable()
export class TimesheetService {
  constructor(@InjectRepository(Timesheet) private readonly timesheetRepo: Repository<Timesheet>) {}

  findAll(): Promise<Timesheet[]> {
    return this.timesheetRepo.find();
  }

  async findOne(id: number): Promise<Timesheet> {
    const timesheet = await this.timesheetRepo.findOne({ where: { id } });
    if (!timesheet) throw new NotFoundException('Timesheet not found');
    return timesheet;
  }

  async createForShift(shift: Shift): Promise<Timesheet> {
    const timesheet = this.timesheetRepo.create({
      shift,
      company: shift.company,
      guard: shift.guard,
      hoursWorked: 0,
      approvalStatus: 'pending'
    });

    return this.timesheetRepo.save(timesheet);
  }

  async update(id: number, dto: UpdateTimesheetDto): Promise<Timesheet> {
    const timesheet = await this.findOne(id);
    if (dto.hoursWorked !== undefined) timesheet.hoursWorked = dto.hoursWorked;
    if (dto.approvalStatus !== undefined) timesheet.approvalStatus = dto.approvalStatus;
    return this.timesheetRepo.save(timesheet);
  }
}
```

## src/user/dto/create-user.dto.ts

```ts
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { UserRole } from '../entities/user.entity';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
```

## src/user/entities/user.entity.ts

```ts
import { Column, Entity, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Company } from '../../company/entities/company.entity';
import { GuardProfile } from '../../guard-profile/entities/guard-profile.entity';

export enum UserRole {
  ADMIN = 'admin',
  COMPANY = 'company',
  GUARD = 'guard'
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @OneToOne(() => Company, (company) => company.user)
  companyProfile?: Company;

  @OneToOne(() => GuardProfile, (guardProfile) => guardProfile.user)
  guardProfile?: GuardProfile;
}
```

## src/user/user.module.ts

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserService } from './user.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UserService],
  exports: [UserService, TypeOrmModule]
})
export class UserModule {}
```

## src/user/user.service.ts

```ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { CreateUserDto } from './dto/create-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UserService {
  constructor(@InjectRepository(User) private readonly usersRepo: Repository<User>) {}

  async create(dto: CreateUserDto): Promise<User> {
    const existing = await this.usersRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.usersRepo.create({ email: dto.email, passwordHash, role: dto.role });
    return this.usersRepo.save(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { email } });
  }

  async findById(id: number): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "es2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "strict": true,
    "moduleResolution": "node",
    "skipLibCheck": true
  }
}
```
