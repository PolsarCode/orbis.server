import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { UpdateRailLayoutDto } from './dto/update-rail-layout.dto';
import { SearchCommunitiesDto } from './dto/search-communities.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { ADMINISTRATOR, CommunityRole, isAdministrator } from './permissions';
import { MAX_INT } from './community-member.guard';
import { Community as CommunityModel } from '../../prisma/generated/client';
import { StorageService } from '../storage/storage.service';
import { PresenceGateway } from '../friends/presence.gateway';

export type CommunityMember = {
  userId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  online: boolean;
  nickname: string | null;
  joinedAt: Date;
  isOwner: boolean;
  isAdmin: boolean;
};

export type CommunityWithRole = CommunityModel & {
  role: CommunityRole | null;
  memberCount?: number;
};

const roleRank: Record<CommunityRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

const communityImages = {
  icon: { field: 'iconUrl', folder: 'communities', maxSize: 512 },
  cover: { field: 'coverUrl', folder: 'covers', maxSize: 1600 },
  background: { field: 'backgroundUrl', folder: 'backgrounds', maxSize: 1920 },
} as const;

export type CommunityImage = keyof typeof communityImages;

type Person = {
  id: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
};

export type CommunitySearchResult = {
  id: number;
  name: string;
  description: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
  memberCount: number;
  joined: boolean;
  members: Person[];
  mutuals: Person[];
  mutualCount: number;
};

export const MAX_OWNED_COMMUNITIES = 10;
export const MAX_JOINED_COMMUNITIES = 50;

const MEMBER_PREVIEW = 5;
const MUTUAL_PREVIEW = 3;
const person = {
  select: { id: true, username: true, name: true, avatarUrl: true },
} as const;

export type RailItem =
  | { type: 'community'; communityId: number }
  | {
      type: 'folder';
      id: number;
      name: string | null;
      color: string | null;
      communityIds: number[];
    };

@Injectable()
export class CommunitiesService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private presence: PresenceGateway,
  ) {}

  async requireRoomToJoin(userId: number) {
    const joined = await this.prisma.membership.count({ where: { userId } });
    if (joined >= MAX_JOINED_COMMUNITIES) {
      throw new ForbiddenException(
        `You can be in up to ${MAX_JOINED_COMMUNITIES} communities. Leave one to join another`,
      );
    }
  }

  async create(
    ownerId: number,
    createCommunityDto: CreateCommunityDto,
  ): Promise<CommunityModel> {
    const owned = await this.prisma.community.count({ where: { ownerId } });
    if (owned >= MAX_OWNED_COMMUNITIES) {
      throw new ForbiddenException(
        `You can own up to ${MAX_OWNED_COMMUNITIES} communities`,
      );
    }
    await this.requireRoomToJoin(ownerId);

    const position = await this.nextRailPosition(ownerId);

    return this.prisma.community.create({
      data: {
        name: createCommunityDto.name.trim(),
        isPublic: createCommunityDto.isPublic ?? false,
        ownerId,
        memberships: { create: { userId: ownerId, position } },
      },
    });
  }

  async findPublic(): Promise<
    Pick<
      CommunitySearchResult,
      'id' | 'name' | 'iconUrl' | 'coverUrl' | 'memberCount'
    >[]
  > {
    const communities = await this.prisma.community.findMany({
      where: { isPublic: true },
      orderBy: [{ memberships: { _count: 'desc' } }, { id: 'desc' }],
      take: 6,
      select: {
        id: true,
        name: true,
        iconUrl: true,
        coverUrl: true,
        _count: { select: { memberships: true } },
      },
    });
    return communities.map(({ _count, ...community }) => ({
      ...community,
      memberCount: _count.memberships,
    }));
  }

  async search(
    userId: number,
    { q }: SearchCommunitiesDto,
  ): Promise<CommunitySearchResult[]> {
    const query = q?.trim();
    const communities = await this.prisma.community.findMany({
      where: {
        isPublic: true,
        ...(query && { name: { contains: query, mode: 'insensitive' } }),
      },
      orderBy: [{ memberships: { _count: 'desc' } }, { createdAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        name: true,
        description: true,
        iconUrl: true,
        coverUrl: true,
        _count: { select: { memberships: true } },
        memberships: { where: { userId }, select: { userId: true } },
      },
    });
    const ids = communities.map(({ id }) => id);

    const [previews, friendships] = await Promise.all([
      Promise.all(
        ids.map((communityId) =>
          this.prisma.membership.findMany({
            where: { communityId },
            orderBy: { joinedAt: 'asc' },
            take: MEMBER_PREVIEW,
            select: { user: person },
          }),
        ),
      ),
      this.prisma.friendship.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: { requesterId: true, addresseeId: true },
      }),
    ]);
    const friendIds = friendships.map(({ requesterId, addresseeId }) =>
      requesterId === userId ? addresseeId : requesterId,
    );
    const friendMemberships =
      friendIds.length === 0
        ? []
        : await this.prisma.membership.findMany({
            where: { communityId: { in: ids }, userId: { in: friendIds } },
            orderBy: { joinedAt: 'asc' },
            select: { communityId: true, user: person },
          });

    return communities.map(
      (
        { id, name, description, iconUrl, coverUrl, _count, memberships },
        index,
      ) => {
        const mutuals = friendMemberships
          .filter(({ communityId }) => communityId === id)
          .map(({ user }) => user);
        return {
          id,
          name,
          description,
          iconUrl,
          coverUrl,
          memberCount: _count.memberships,
          joined: memberships.length > 0,
          members: previews[index].map(({ user }) => user),
          mutuals: mutuals.slice(0, MUTUAL_PREVIEW),
          mutualCount: mutuals.length,
        };
      },
    );
  }

  async join(userId: number, communityId: number): Promise<CommunityModel> {
    const community =
      communityId >= 1 && communityId <= MAX_INT
        ? await this.prisma.community.findUnique({ where: { id: communityId } })
        : null;

    if (!community?.isPublic) {
      throw new NotFoundException('Community not found');
    }

    if (!(await this.roleOf(userId, communityId))) {
      await this.requireRoomToJoin(userId);
    }
    const position = await this.nextRailPosition(userId);
    await this.prisma.membership.upsert({
      where: { userId_communityId: { userId, communityId } },
      create: { userId, communityId, position },
      update: {},
    });

    return community;
  }

  async findForMember(userId: number): Promise<CommunityModel[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { joinedAt: 'asc' }],
      include: { community: true },
    });

    return memberships.map(({ community }) => community);
  }

  async nextRailPosition(userId: number): Promise<number> {
    const [memberships, folders] = await Promise.all([
      this.prisma.membership.aggregate({
        where: { userId, folderId: null },
        _max: { position: true },
      }),
      this.prisma.railFolder.aggregate({
        where: { userId },
        _max: { position: true },
      }),
    ]);

    return (
      Math.max(memberships._max.position ?? -1, folders._max.position ?? -1) + 1
    );
  }

  async railLayout(userId: number): Promise<RailItem[]> {
    const [memberships, folders] = await Promise.all([
      this.prisma.membership.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { joinedAt: 'asc' }],
        select: { communityId: true, folderId: true, position: true },
      }),
      this.prisma.railFolder.findMany({
        where: { userId },
        orderBy: { position: 'asc' },
      }),
    ]);

    const entries = [
      ...memberships
        .filter(({ folderId }) => folderId === null)
        .map(({ communityId, position }) => ({
          position,
          item: { type: 'community', communityId } as RailItem,
        })),
      ...folders.flatMap((folder) => {
        const communityIds = memberships
          .filter(({ folderId }) => folderId === folder.id)
          .map(({ communityId }) => communityId);
        return communityIds.length === 0
          ? []
          : [
              {
                position: folder.position,
                item: {
                  type: 'folder',
                  id: folder.id,
                  name: folder.name,
                  color: folder.color,
                  communityIds,
                } as RailItem,
              },
            ];
      }),
    ];

    return entries
      .sort((a, b) => a.position - b.position)
      .map(({ item }) => item);
  }

  async updateRailLayout(
    userId: number,
    { items }: UpdateRailLayoutDto,
  ): Promise<RailItem[]> {
    const [memberships, folders] = await Promise.all([
      this.prisma.membership.findMany({
        where: { userId },
        select: { communityId: true },
      }),
      this.prisma.railFolder.findMany({
        where: { userId },
        select: { id: true },
      }),
    ]);
    const memberOf = new Set(memberships.map(({ communityId }) => communityId));
    const ownFolders = new Set(folders.map(({ id }) => id));
    const listed = items.flatMap((item) =>
      item.folder ? item.folder.communityIds : [item.communityId],
    );

    if (
      items.some(
        (item) =>
          (item.folder === undefined) === (item.communityId === undefined),
      )
    ) {
      throw new BadRequestException(
        'Each item must be either a community or a folder',
      );
    }
    if (
      listed.length !== memberOf.size ||
      new Set(listed).size !== listed.length ||
      listed.some((id) => id === undefined || !memberOf.has(id))
    ) {
      throw new BadRequestException(
        'The layout must list each of your communities exactly once',
      );
    }
    if (
      items.some(
        ({ folder }) => folder?.id !== undefined && !ownFolders.has(folder.id),
      )
    ) {
      throw new BadRequestException('Folder not found');
    }

    const kept = new Set(
      items.flatMap(({ folder }) =>
        folder?.id !== undefined && folder.communityIds.length > 0
          ? [folder.id]
          : [],
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.railFolder.deleteMany({
        where: { userId, id: { notIn: [...kept] } },
      });

      for (const [position, item] of items.entries()) {
        if (item.communityId !== undefined) {
          await tx.membership.update({
            where: {
              userId_communityId: { userId, communityId: item.communityId },
            },
            data: { position, folderId: null },
          });
          continue;
        }

        const { id, name, color, communityIds } = item.folder!;
        if (communityIds.length === 0) continue;

        const data = {
          name: name?.trim() || null,
          color: color?.toLowerCase() ?? null,
          position,
        };
        const folder =
          id === undefined
            ? await tx.railFolder.create({ data: { ...data, userId } })
            : await tx.railFolder.update({ where: { id }, data });

        for (const [index, communityId] of communityIds.entries()) {
          await tx.membership.update({
            where: { userId_communityId: { userId, communityId } },
            data: { position: index, folderId: folder.id },
          });
        }
      }
    });

    return this.railLayout(userId);
  }

  async findMembers(communityId: number): Promise<CommunityMember[]> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        ownerId: true,
        memberships: {
          orderBy: { joinedAt: 'asc' },
          select: {
            nickname: true,
            joinedAt: true,
            user: {
              select: {
                id: true,
                username: true,
                name: true,
                avatarUrl: true,
                coverUrl: true,
                appearOffline: true,
              },
            },
            roles: { select: { role: { select: { permissions: true } } } },
          },
        },
      },
    });

    if (!community) return [];

    return community.memberships
      .map(({ nickname, joinedAt, user, roles }) => {
        const isOwner = user.id === community.ownerId;
        return {
          userId: user.id,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatarUrl,
          coverUrl: user.coverUrl,
          online: !user.appearOffline && this.presence.isOnline(user.id),
          nickname,
          joinedAt,
          isOwner,
          isAdmin:
            !isOwner &&
            roles.some(({ role }) => isAdministrator(role.permissions)),
        };
      })
      .sort(
        (a, b) =>
          roleRank[a.isOwner ? 'owner' : a.isAdmin ? 'admin' : 'member'] -
          roleRank[b.isOwner ? 'owner' : b.isAdmin ? 'admin' : 'member'],
      );
  }

  async findOne(userId: number, id: number): Promise<CommunityWithRole | null> {
    const [community, role] = await Promise.all([
      this.prisma.community.findUnique({
        where: { id },
        include: { _count: { select: { memberships: true } } },
      }),
      this.roleOf(userId, id),
    ]);
    if (!community || (!role && !community.isPublic)) return null;

    const { _count, ...rest } = community;
    return { ...rest, role, memberCount: _count.memberships };
  }

  async roleOf(
    userId: number,
    communityId: number,
  ): Promise<CommunityRole | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_communityId: { userId, communityId } },
      select: {
        community: { select: { ownerId: true } },
        roles: { select: { role: { select: { permissions: true } } } },
      },
    });

    if (!membership) return null;
    if (membership.community.ownerId === userId) return 'owner';
    return membership.roles.some(({ role }) =>
      isAdministrator(role.permissions),
    )
      ? 'admin'
      : 'member';
  }

  private async requireRole(
    userId: number,
    communityId: number,
    required: 'owner' | 'admin',
  ) {
    const role = await this.roleOf(userId, communityId);
    if (!role || roleRank[role] > roleRank[required]) {
      throw new ForbiddenException(
        required === 'owner'
          ? 'Only the owner can do this'
          : 'Only admins can do this',
      );
    }
    return role;
  }

  async update(
    userId: number,
    communityId: number,
    { name, isPublic, description }: UpdateCommunityDto,
  ): Promise<CommunityWithRole> {
    const role = await this.requireRole(userId, communityId, 'admin');
    const community = await this.prisma.community.update({
      where: { id: communityId },
      data: {
        name: name?.trim(),
        isPublic,
        description:
          description === undefined ? undefined : description.trim() || null,
      },
    });

    return { ...community, role };
  }

  async updateImage(
    userId: number,
    communityId: number,
    image: CommunityImage,
    file: Buffer,
  ): Promise<CommunityWithRole> {
    await this.requireRole(userId, communityId, 'admin');
    const { folder, maxSize } = communityImages[image];
    const { url } = await this.storage.uploadImage(file, folder, maxSize);
    return this.replaceImage(userId, communityId, image, url);
  }

  async removeImage(
    userId: number,
    communityId: number,
    image: CommunityImage,
  ): Promise<CommunityWithRole> {
    await this.requireRole(userId, communityId, 'admin');
    return this.replaceImage(userId, communityId, image, null);
  }

  async remove(userId: number, communityId: number): Promise<void> {
    await this.requireRole(userId, communityId, 'owner');
    const community = await this.prisma.community.delete({
      where: { id: communityId },
    });
    await this.deleteStoredImage(community.iconUrl);
    await this.deleteStoredImage(community.coverUrl);
    await this.deleteStoredImage(community.backgroundUrl);
  }

  private async replaceImage(
    userId: number,
    communityId: number,
    image: CommunityImage,
    url: string | null,
  ): Promise<CommunityWithRole> {
    const { field } = communityImages[image];
    const previous = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { iconUrl: true, coverUrl: true, backgroundUrl: true },
    });
    await this.prisma.community.update({
      where: { id: communityId },
      data: { [field]: url },
    });
    await this.deleteStoredImage(previous?.[field] ?? null);

    return (await this.findOne(userId, communityId))!;
  }

  private async deleteStoredImage(url: string | null) {
    const key = url && this.storage.keyFor(url);
    if (key) await this.storage.delete(key).catch(() => {});
  }

  async setAdmin(
    userId: number,
    communityId: number,
    targetId: number,
    isAdmin: boolean,
  ): Promise<CommunityMember[]> {
    await this.requireRole(userId, communityId, 'owner');

    const targetRole =
      targetId >= 1 && targetId <= MAX_INT
        ? await this.roleOf(targetId, communityId)
        : null;
    if (!targetRole) throw new NotFoundException('Member not found');
    if (targetRole === 'owner') {
      throw new BadRequestException('The owner is always an admin');
    }

    const adminRoleIds = (
      await this.prisma.role.findMany({
        where: { communityId },
        select: { id: true, permissions: true },
      })
    )
      .filter(({ permissions }) => isAdministrator(permissions))
      .map(({ id }) => id);

    if (isAdmin) {
      const roleId =
        adminRoleIds[0] ??
        (
          await this.prisma.role.create({
            data: { communityId, name: 'Admin', permissions: ADMINISTRATOR },
          })
        ).id;
      await this.prisma.membershipRole.upsert({
        where: {
          userId_communityId_roleId: { userId: targetId, communityId, roleId },
        },
        create: { userId: targetId, communityId, roleId },
        update: {},
      });
    } else {
      await this.prisma.membershipRole.deleteMany({
        where: { userId: targetId, communityId, roleId: { in: adminRoleIds } },
      });
    }

    return this.findMembers(communityId);
  }
}
