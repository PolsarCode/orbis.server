import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CommunitiesService } from './communities.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';
import { TwitchLiveService } from '../friends/twitch-live.service';

function setup() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        createdAt: new Date('2020-01-01T00:00:00Z'),
        isAdmin: false,
        email: 'owner@orbis.test',
      }),
    },
    community: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(({ data }) => Promise.resolve({ id: 1, ...data })),
    },
    membership: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
    },
    railFolder: {
      aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
    },
  };
  const service = new CommunitiesService(
    prisma as unknown as PrismaService,
    {} as StorageService,
    {} as PresenceGateway,
    {} as TwitchLiveService,
  );
  return { prisma, service };
}

describe('Creating a community', () => {
  it('saves the description and links given at creation', async () => {
    const { prisma, service } = setup();

    await service.create(4, {
      name: ' Reading club ',
      isPublic: true,
      description: '  We read things  ',
      links: { website: 'https://reading.example.com' },
    });

    expect(prisma.community.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Reading club',
        isPublic: true,
        description: 'We read things',
        links: { website: 'https://reading.example.com' },
      }),
    });
  });

  it('leaves the description empty and links blank when they’re left out', async () => {
    const { prisma, service } = setup();

    await service.create(4, { name: 'Club', description: '   ' });

    expect(prisma.community.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: null, links: {} }),
    });
  });

  it('checks links the same way settings does', async () => {
    const dto = plainToInstance(CreateCommunityDto, {
      name: 'Club',
      links: { x: 'https://example.com/club' },
    });

    const errors = await validate(dto);

    expect(errors[0]?.property).toBe('links');
  });
});
