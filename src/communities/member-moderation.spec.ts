import { authorModeration, canActOn } from './member-moderation';
import { PrismaService } from '../prisma.service';
import { ADMINISTRATOR } from './permissions';

const OWNER = 1;
const ADMIN = 2;
const OTHER_ADMIN = 3;
const MEMBER = 4;
const LEFT = 5;
const BANNED = 6;

const adminRole = [{ role: { permissions: ADMINISTRATOR } }];

function membership(userId: number, roles: typeof adminRole = []) {
  return { userId, communityId: 9, community: { ownerId: OWNER }, roles };
}

function setup() {
  const prisma = {
    membership: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          membership(OWNER),
          membership(ADMIN, adminRole),
          membership(OTHER_ADMIN, adminRole),
          membership(MEMBER),
        ]),
    },
    communityBan: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ userId: BANNED, communityId: 9 }]),
    },
  };
  return prisma;
}

describe('Who can remove or ban whom', () => {
  it('lets owners act on anyone but the owner, and admins only on members', () => {
    expect(canActOn('owner', 'admin')).toBe(true);
    expect(canActOn('owner', 'member')).toBe(true);
    expect(canActOn('admin', 'member')).toBe(true);
    expect(canActOn('admin', null)).toBe(true);
    expect(canActOn('admin', 'admin')).toBe(false);
    expect(canActOn('admin', 'owner')).toBe(false);
    expect(canActOn('member', 'member')).toBe(false);
    expect(canActOn(null, 'member')).toBe(false);
  });

  it('works out the options for each author on a page', async () => {
    const prisma = setup();
    const authors = [MEMBER, OTHER_ADMIN, LEFT, BANNED, ADMIN, OWNER].map(
      (authorId) => ({ communityId: 9, authorId }),
    );

    const asAdmin = await authorModeration(
      prisma as unknown as PrismaService,
      ADMIN,
      authors,
    );
    const asOwner = await authorModeration(
      prisma as unknown as PrismaService,
      OWNER,
      authors,
    );

    expect(asAdmin(9, MEMBER)).toEqual({ remove: true, ban: true });
    expect(asAdmin(9, OTHER_ADMIN)).toBeNull();
    expect(asAdmin(9, LEFT)).toEqual({ remove: false, ban: true });
    expect(asAdmin(9, BANNED)).toBeNull();
    expect(asAdmin(9, ADMIN)).toBeNull();
    expect(asAdmin(9, OWNER)).toBeNull();
    expect(asOwner(9, OTHER_ADMIN)).toEqual({ remove: true, ban: true });
    expect(asOwner(9, OWNER)).toBeNull();
  });

  it('skips the lookup when there’s nobody to check', async () => {
    const prisma = setup();

    const moderationOf = await authorModeration(
      prisma as unknown as PrismaService,
      MEMBER,
      [{ communityId: 9, authorId: MEMBER }],
    );

    expect(moderationOf(9, MEMBER)).toBeNull();
    expect(prisma.membership.findMany).not.toHaveBeenCalled();
  });
});
