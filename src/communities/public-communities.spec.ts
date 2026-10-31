import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { CommunitiesService } from './communities.service';
import { PublicCommunitiesController } from './public-communities.controller';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

describe('Public landing communities', () => {
  const prisma = { community: { findMany: jest.fn() } };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PublicCommunitiesController],
      providers: [{ provide: CommunitiesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('serves only public community metadata to guests without caching', async () => {
    prisma.community.findMany.mockResolvedValue([
      {
        id: 9,
        name: 'Reading club',
        iconUrl: null,
        coverUrl: null,
        isVerified: true,
        _count: { memberships: 3 },
      },
    ]);
    const response = await request(app.getHttpServer())
      .get('/public/communities')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual([
      {
        id: 9,
        name: 'Reading club',
        iconUrl: null,
        coverUrl: null,
        isVerified: true,
        memberCount: 3,
      },
    ]);
    expect(prisma.community.findMany).toHaveBeenLastCalledWith({
      where: { isPublic: true },
      orderBy: [{ memberships: { _count: 'desc' } }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        iconUrl: true,
        coverUrl: true,
        isVerified: true,
        _count: { select: { memberships: true } },
      },
    });
  });

  it('puts communities with an icon and cover first, then the biggest, and keeps six', async () => {
    const community = (
      id: number,
      memberships: number,
      iconUrl: string | null = null,
      coverUrl: string | null = null,
    ) => ({
      id,
      name: `Community ${id}`,
      iconUrl,
      coverUrl,
      isVerified: false,
      _count: { memberships },
    });
    prisma.community.findMany.mockResolvedValue([
      community(1, 90),
      community(2, 80, 'icon.webp'),
      community(3, 70),
      community(4, 60, 'icon.webp', 'cover.webp'),
      community(5, 50),
      community(6, 40, null, 'cover.webp'),
      community(7, 30),
      community(8, 20, 'icon.webp', 'cover.webp'),
    ]);
    const response = await request(app.getHttpServer())
      .get('/public/communities')
      .expect(200);
    expect(response.body.map(({ id }: { id: number }) => id)).toEqual([
      4, 8, 2, 6, 1, 3,
    ]);
  });

  it('returns an empty list without sample communities', async () => {
    prisma.community.findMany.mockResolvedValue([]);
    const response = await request(app.getHttpServer())
      .get('/public/communities')
      .expect(200);
    expect(response.body).toEqual([]);
  });
});
