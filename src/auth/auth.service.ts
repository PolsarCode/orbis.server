import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { normalizeUsername } from '../users/username';
import { EmailConfirmationService } from './email-confirmation.service';
import { PrismaService } from '../prisma.service';
import { ensureNotSuspended } from '../users/suspension';
import {
  TICKET_LIFETIME,
  TWO_FACTOR_PURPOSE,
  ticketSecret,
} from './two-factor/ticket';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private emailConfirmation: EmailConfirmationService,
    private prisma: PrismaService,
  ) {}

  async signup(createUserDto: CreateUserDto) {
    if (await this.usersService.findByEmail(createUserDto.email)) {
      throw new ConflictException('Email is already registered');
    }
    if (
      await this.usersService.findByUsername(
        normalizeUsername(createUserDto.username),
      )
    ) {
      throw new ConflictException('Username is already taken');
    }

    const user = await this.usersService.create(createUserDto);
    this.emailConfirmation.sendInBackground(user);

    return this.generateToken(user.id, user.email);
  }

  async login(identifier: string, password: string) {
    const user = identifier.includes('@')
      ? await this.usersService.findByEmail(identifier)
      : await this.usersService.findByUsername(normalizeUsername(identifier));

    if (!user?.password) throw new UnauthorizedException();

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new UnauthorizedException();

    if (user.twoFactorEnabledAt) {
      await ensureNotSuspended(this.prisma, user.id);
      return {
        two_factor_ticket: this.jwtService.sign(
          { sub: user.id, purpose: TWO_FACTOR_PURPOSE },
          { secret: ticketSecret(), expiresIn: TICKET_LIFETIME },
        ),
      };
    }

    return this.generateToken(user.id, user.email);
  }

  async generateToken(userId: number, email: string) {
    await ensureNotSuspended(this.prisma, userId);
    const payload = { sub: userId, email };

    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
