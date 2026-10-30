import { Controller, Get, Header } from '@nestjs/common';
import {
  PublicUserSummary,
  UsersService,
  rankPublicUsers,
} from './users.service';
import { PresenceGateway } from '../friends/presence.gateway';

@Controller('public/users')
export class PublicUsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly presence: PresenceGateway,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async findPublic(): Promise<PublicUserSummary[]> {
    const users = await this.usersService.activePublicUsers();
    return rankPublicUsers(users, (user) =>
      this.presence.statusOf(user.userId, user),
    );
  }
}
