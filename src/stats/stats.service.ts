import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export type Stats = {
  members: number;
  communities: number;
  posts: number;
  comments: number;
};

@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async summary(): Promise<Stats> {
    const [members, communities, posts, comments] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.community.count(),
      this.prisma.post.count(),
      this.prisma.comment.count(),
    ]);

    return { members, communities, posts, comments };
  }
}
