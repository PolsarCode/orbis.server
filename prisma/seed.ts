import { randomInt } from 'node:crypto';
import {
  LibraryStatus,
  MediaType,
  NotificationType,
  PrismaClient,
  ReportCategory,
  ReportStatus,
} from './generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import { ADMINISTRATOR } from '../src/communities/permissions';
import { ticketNumber } from '../src/reports/ticket';
import { getReporterStatusLabel } from '../src/reports/status-labels';
import { pair } from '../src/messages/conversation';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const CHARACTER_PASSWORD = 'password';
const PAGE_TOURS = [
  'community',
  'profile',
  'library',
  'media',
  'explore',
  'reports',
];

const characters = {
  naruto: 'Naruto Uzumaki',
  sasuke: 'Sasuke Uchiha',
  sakura: 'Sakura Haruno',
  luffy: 'Monkey D. Luffy',
  zoro: 'Roronoa Zoro',
  nami: 'Nami',
  goku: 'Son Goku',
  vegeta: 'Vegeta',
  tanjiro: 'Tanjiro Kamado',
  nezuko: 'Nezuko Kamado',
  gojo: 'Satoru Gojo',
  itadori: 'Yuji Itadori',
  levi: 'Levi Ackerman',
  mikasa: 'Mikasa Ackerman',
  anya: 'Anya Forger',
  spike: 'Spike Spiegel',
};

type Character = keyof typeof characters;
type UserKey = Character | 'admin' | 'user';

type SeedCommunity = {
  name: string;
  description: string;
  owner: UserKey;
  isPublic: boolean;
  isVerified?: boolean;
  members: [UserKey, string?][];
  admins?: UserKey[];
  posts: [UserKey, number, string][];
};

type SeedComment = {
  author: UserKey;
  ago: number;
  content: string;
  linkUrl?: string;
  likes?: UserKey[];
  replies?: SeedComment[];
};

const hours = (count: number) => count * 60;
const days = (count: number) => count * 24 * 60;

const communities: SeedCommunity[] = [
  {
    name: 'Seasonal Anime Club',
    description:
      'Weekly discussions for everything airing this season. Hot takes, episode reactions, and what to drop.',
    owner: 'admin',
    isPublic: true,
    isVerified: true,
    members: [
      ['admin', 'Club President'],
      ['anya'],
      ['spike'],
      ['itadori'],
      ['nami'],
      ['tanjiro'],
      ['naruto'],
      ['user'],
    ],
    posts: [
      [
        'admin',
        days(3),
        `<p>Welcome to the <strong>Seasonal Anime Club</strong>! 🎉</p><p>Post what you're watching this season, drop recommendations, and keep spoilers out of titles. A few ground rules:</p><ul><li>Be kind</li><li>Tag spoilers clearly</li><li>Hot takes are welcome, flame wars are not</li></ul>`,
      ],
      [
        'anya',
        days(2) + hours(5),
        `<p>Anya watched a spy anime with Papa. Anya already knew the ending. Anya did not say anything. <em>Heh.</em></p><p><a href="/users/admin" class="mention">@admin</a>, can the club watch it next?</p>`,
      ],
      [
        'spike',
        days(1) + hours(9),
        `<p>Hot take: if the soundtrack isn't jazz, I'm not watching it.</p><blockquote>See you, space cowboy...</blockquote>`,
      ],
      [
        'itadori',
        hours(20),
        `<p>Just finished a movie marathon for "training". Ranking so far:</p><ol><li>Anything with a good fight scene</li><li>Anything that made me cry</li><li>Anything Gojo-sensei didn't pick</li></ol>`,
      ],
      [
        'nami',
        hours(6),
        `<p>Reminder that the club's watch-party snacks are <strong>not free</strong>. I keep a ledger. 💰</p>`,
      ],
      [
        'tanjiro',
        hours(2),
        `<p>What's everyone's comfort anime? Mine is anything about family. Recommendations very welcome!</p>`,
      ],
    ],
  },
  {
    name: 'Hidden Leaf Village',
    description:
      'Believe it! A home for Naruto fans, from the Academy days to the Hokage era.',
    owner: 'naruto',
    isPublic: true,
    admins: ['admin', 'sakura'],
    members: [
      ['naruto', 'Future Hokage'],
      ['sasuke'],
      ['sakura'],
      ['admin'],
      ['itadori'],
      ['user'],
    ],
    posts: [
      [
        'naruto',
        days(4),
        `<p>Believe it! The Hidden Leaf Village is officially on Orbis! Ramen at Ichiraku after training, <strong>my treat</strong>... probably.</p>`,
      ],
      [
        'sakura',
        days(3) + hours(2),
        `<p><a href="/users/naruto" class="mention">@naruto</a>, you said "your treat" last time and I paid. Again.</p>`,
      ],
      ['sasuke', days(2), `<p>Hn.</p>`],
      [
        'naruto',
        days(1) + hours(3),
        `<p>Training schedule for the week:</p><ul><li><strong>Mon</strong>: Shadow clone drills</li><li><strong>Wed</strong>: Rasengan practice</li><li><strong>Fri</strong>: Beat Sasuke</li></ul>`,
      ],
      [
        'itadori',
        hours(10),
        `<p>Visiting from Jujutsu High. Is it true you all run on walls? Asking for a friend (me).</p>`,
      ],
      [
        'sakura',
        hours(1),
        `<p>Medical ninja tip: <em>hydrate</em>. Especially you, Naruto.</p>`,
      ],
    ],
  },
  {
    name: 'Straw Hat Pirates',
    description:
      'Set sail with the crew. One Piece theories, chapter talk, and a lot of meat.',
    owner: 'luffy',
    isPublic: true,
    admins: ['zoro'],
    members: [
      ['luffy', 'Captain'],
      ['zoro', 'Pirate Hunter'],
      ['nami', 'Navigator'],
      ['admin'],
      ['goku'],
    ],
    posts: [
      [
        'luffy',
        days(5),
        `<p>I'm gonna be King of the Pirates!! Also, who ate the meat I was saving?</p>`,
      ],
      [
        'nami',
        days(4) + hours(6),
        `<p>New course is set for the next island. <strong>Zoro</strong>, the ship is the big wooden thing. Please stay on it.</p>`,
      ],
      ['zoro', days(3), `<p>I didn't get lost. The island moved.</p>`],
      [
        'goku',
        days(1) + hours(12),
        `<p>Hey Luffy! You eat as much as me? We should have a contest. Winner gets a spar!</p>`,
      ],
      ['luffy', days(1) + hours(11), `<p>YES!! Meat contest!! 🍖🍖🍖</p>`],
      [
        'nami',
        hours(4),
        `<p>The meat contest will be funded from the crew's treasury. With <strong>interest</strong>.</p>`,
      ],
    ],
  },
  {
    name: 'Saiyan Training Grounds',
    description:
      'Train hard, power up, and argue about who would win. All things Dragon Ball.',
    owner: 'goku',
    isPublic: true,
    members: [['goku'], ['vegeta', 'Prince of All Saiyans'], ['luffy']],
    posts: [
      [
        'goku',
        days(6),
        `<p>Hi, I'm Goku! This is a place to train, eat, and get stronger. Everyone's welcome!</p>`,
      ],
      [
        'vegeta',
        days(5) + hours(4),
        `<p>Hmph. <strong>Kakarot</strong>, a "community" will not close the gap between us. I'll surpass you by myself.</p>`,
      ],
      [
        'goku',
        days(2) + hours(7),
        `<p>Gravity room is open 24/7! Current setting: <code>300x</code>. Bring snacks.</p>`,
      ],
      [
        'vegeta',
        hours(15),
        `<p>I have increased the gravity room setting. You're welcome.</p>`,
      ],
      [
        'luffy',
        hours(3),
        `<p>Is the meat contest happening here or on the ship?</p>`,
      ],
    ],
  },
  {
    name: 'Demon Slayer Corps',
    description:
      'Breathing styles, Hashira rankings, and the best fight scenes in anime.',
    owner: 'tanjiro',
    isPublic: true,
    admins: ['admin'],
    members: [['tanjiro'], ['nezuko'], ['admin'], ['mikasa']],
    posts: [
      [
        'tanjiro',
        days(4) + hours(8),
        `<p>Breathing technique reminder: <em>Total Concentration</em>, all day, every day. Even while sleeping!</p>`,
      ],
      ['nezuko', days(3) + hours(1), `<p>Mmmph! 🎋</p>`],
      [
        'mikasa',
        days(2) + hours(5),
        `<p>Your swordsmanship is impressive. The Survey Corps could use you.</p>`,
      ],
      [
        'tanjiro',
        hours(18),
        `<p>Thank you, Mikasa! Let's train together sometime. Nezuko says hi too.</p>`,
      ],
      [
        'admin',
        hours(5),
        `<p>Just caught up on the latest arc. That animation budget is <strong>unreal</strong>.</p>`,
      ],
    ],
  },
  {
    name: 'Jujutsu High',
    description:
      'Cursed energy, domain expansions, and Gojo being Gojo. Jujutsu Kaisen talk.',
    owner: 'gojo',
    isPublic: true,
    members: [['gojo', 'The Strongest'], ['itadori']],
    posts: [
      [
        'gojo',
        days(5) + hours(2),
        `<p>Welcome to Jujutsu High, students! Don't worry. I'm the strongest, after all. 😎</p>`,
      ],
      [
        'itadori',
        days(3) + hours(9),
        `<p>Sensei, can we do a lesson on something other than "be strong"?</p>`,
      ],
      [
        'gojo',
        days(3) + hours(8),
        `<p>Lesson plan:</p><ol><li>Be strong</li><li>Be stronger</li><li>Get Kikufuku mochi for sensei</li></ol>`,
      ],
      ['itadori', hours(12), `<p>Bought the mochi. Where do I leave it?</p>`],
      [
        'gojo',
        45,
        `<p>Good student. ⭐ Extra credit for remembering the <em>Kikufuku</em>.</p>`,
      ],
    ],
  },
  {
    name: 'Survey Corps',
    description:
      'Private quarters for the Scouts. Expedition reports and Attack on Titan discussion.',
    owner: 'levi',
    isPublic: false,
    members: [['levi', 'Captain'], ['mikasa'], ['admin']],
    posts: [
      [
        'levi',
        days(6) + hours(3),
        `<p>Private channel for the squad. Keep your gear clean and your reports short.</p>`,
      ],
      [
        'mikasa',
        days(2) + hours(10),
        `<p>Expedition report filed. All maneuvering gear accounted for.</p>`,
      ],
      [
        'levi',
        hours(9),
        `<p>Cleaning duty rotation is posted. If I find dust on a single shelf, you're redoing the whole floor.</p>`,
      ],
    ],
  },
  {
    name: 'Bebop Lounge',
    description:
      'A quiet corner for space cowboys. Jazz, bounties, and Cowboy Bebop rewatches.',
    owner: 'spike',
    isPublic: false,
    members: [['spike'], ['admin']],
    posts: [
      [
        'spike',
        days(3) + hours(4),
        `<p>Whatever happens, happens. Bounties, jazz, and bell peppers with no beef.</p>`,
      ],
      [
        'admin',
        days(1) + hours(2),
        `<p>Added this to the club's all-time favorites list. Nothing beats that opening.</p>`,
      ],
    ],
  },
];

const postComments: Record<string, Record<number, SeedComment[]>> = {
  'Seasonal Anime Club': {
    0: [
      {
        author: 'anya',
        ago: days(3) - hours(2),
        content: `<p>Anya will follow the rules. Mostly.</p>`,
        likes: ['admin', 'spike'],
      },
      {
        author: 'tanjiro',
        ago: days(3) - hours(5),
        content: `<p>Thank you for making this club!</p>`,
        replies: [
          {
            author: 'admin',
            ago: days(3) - hours(6),
            content: `<p>Glad to have you, Tanjiro!</p>`,
            likes: ['tanjiro'],
          },
        ],
      },
    ],
  },
  'Hidden Leaf Village': {
    2: [
      {
        author: 'naruto',
        ago: days(2) - hours(1),
        content: `<p>Is that a yes or a no?!</p>`,
        replies: [
          {
            author: 'sakura',
            ago: days(2) - hours(2),
            content: `<p>It's a yes.</p>`,
            likes: ['naruto'],
            replies: [
              {
                author: 'sasuke',
                ago: days(2) - hours(3),
                content: `<p>Hn.</p>`,
                likes: ['sakura', 'naruto'],
              },
            ],
          },
        ],
      },
    ],
  },
  'Straw Hat Pirates': {
    0: [
      {
        author: 'zoro',
        ago: days(5) - hours(1),
        content: `<p>It was you, Luffy.</p>`,
        likes: ['nami', 'admin'],
        replies: [
          {
            author: 'luffy',
            ago: days(5) - hours(2),
            content: `<p>Oh yeah! Shishishi!</p>`,
          },
        ],
      },
      {
        author: 'nami',
        ago: days(4) + hours(20),
        content: `<p>Meat is now 3,000 berries per piece.</p>`,
        likes: ['zoro'],
      },
    ],
  },
};

const privateProfiles: Character[] = ['levi', 'mikasa'];

const verifiedProfiles: Character[] = ['luffy', 'gojo'];

const suggestionDismissals: [UserKey, UserKey, number][] = [
  ['admin', 'vegeta', 3],
];

const friendships: [UserKey, UserKey, 'accepted' | 'pending'][] = [
  ['admin', 'naruto', 'accepted'],
  ['admin', 'luffy', 'accepted'],
  ['goku', 'admin', 'accepted'],
  ['tanjiro', 'admin', 'accepted'],
  ['admin', 'gojo', 'accepted'],
  ['admin', 'levi', 'accepted'],
  ['anya', 'admin', 'pending'],
  ['itadori', 'admin', 'pending'],
  ['admin', 'spike', 'pending'],
  ['naruto', 'sasuke', 'accepted'],
  ['naruto', 'sakura', 'accepted'],
  ['luffy', 'zoro', 'accepted'],
  ['luffy', 'nami', 'accepted'],
  ['goku', 'vegeta', 'accepted'],
  ['goku', 'luffy', 'accepted'],
  ['tanjiro', 'nezuko', 'accepted'],
  ['gojo', 'itadori', 'accepted'],
  ['levi', 'mikasa', 'accepted'],
  ['naruto', 'user', 'pending'],
];

type SeedChat = {
  between: [UserKey, UserKey];
  request?: boolean;
  seen?: boolean;
  messages: [UserKey, string, number][];
};

const chats: SeedChat[] = [
  {
    between: ['admin', 'naruto'],
    messages: [
      ['naruto', 'Did you see the new chapter?? Believe it!', 95],
      ['admin', 'Not yet, no spoilers please 😅', 90],
      [
        'naruto',
        'Fine, no spoilers. Just watch the new opening 👀 https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        60,
      ],
      ['admin', 'Naruto. That is not the opening.', 55],
      ['naruto', 'Okay okay. Ramen later though?', 12],
      ['naruto', 'Ichiraku, my treat this time', 11],
    ],
  },
  {
    between: ['admin', 'luffy'],
    seen: true,
    messages: [
      ['luffy', 'Are you coming to the Grand Line Crew watch party?', 300],
      ['admin', 'Wouldn’t miss it. Bringing snacks!', 290],
      ['luffy', 'MEAT. Bring meat.', 288],
      [
        'admin',
        'Brushing up before Friday https://en.wikipedia.org/wiki/One_Piece',
        285,
      ],
      ['admin', 'Meat it is 🍖', 280],
    ],
  },
  {
    between: ['gojo', 'admin'],
    seen: true,
    messages: [
      ['admin', 'Thanks for helping moderate the Jujutsu community', 1500],
      ['gojo', 'Anytime. I’m the strongest moderator, after all.', 1490],
      [
        'gojo',
        'This is what we use for the mod queue alerts https://github.com/discordjs/discord.js',
        1480,
      ],
    ],
  },
  {
    between: ['zoro', 'admin'],
    request: true,
    messages: [
      ['zoro', 'Which way is the Swordsmanship Dojo community?', 40],
      ['zoro', 'I think I got lost again.', 38],
    ],
  },
];

type SeedGroup = {
  name: string;
  creator: UserKey;
  members: UserKey[];
  created: number;
  messages: [UserKey, string, number][];
  readAt: Partial<Record<UserKey, number>>;
};

const groups: SeedGroup[] = [
  {
    name: 'Straw Hat Watch Party',
    creator: 'luffy',
    members: ['admin', 'zoro', 'nami'],
    created: 180,
    messages: [
      ['luffy', 'Episode night this Friday! Who’s in?', 170],
      ['nami', 'I’m in, but someone else is buying snacks this time.', 165],
      ['zoro', 'I’ll be there. Probably.', 160],
      ['admin', 'Count me in, I’ll bring the projector 📽️', 150],
      [
        'nami',
        'Episode list so nobody argues about where we left off https://en.wikipedia.org/wiki/List_of_One_Piece_episodes',
        100,
      ],
      ['luffy', 'MEAT for snacks!!', 30],
      ['nami', 'Zoro, I pinned the address. Don’t get lost.', 25],
    ],
    readAt: { luffy: 30, zoro: 160, admin: 150, nami: 25 },
  },
];

function participants(comments: SeedComment[] = []): UserKey[] {
  return comments.flatMap((comment) => [
    comment.author,
    ...(comment.likes ?? []),
    ...participants(comment.replies),
  ]);
}

async function createComments(
  communityId: number | null,
  commentableType: 'post' | 'activity',
  commentableId: number,
  comments: SeedComment[] = [],
  parentId?: number,
): Promise<number> {
  let count = 0;

  for (const comment of comments) {
    const likes = comment.likes ?? [];
    const createdAt = minutesAgo(comment.ago);
    const created = await prisma.comment.create({
      data: {
        communityId,
        commentableType,
        commentableId,
        parentId,
        authorId: userIds[comment.author],
        content: comment.content,
        linkUrl: comment.linkUrl,
        likeCount: likes.length,
        createdAt,
      },
    });
    await prisma.like.createMany({
      data: likes.map((key, index) => ({
        userId: userIds[key],
        likeableType: 'comment' as const,
        likeableId: created.id,
        createdAt: new Date(
          Math.min(
            Date.now(),
            createdAt.getTime() + (index + 1) * 7 * 60 * 1000,
          ),
        ),
      })),
    });
    count +=
      1 +
      (await createComments(
        communityId,
        commentableType,
        commentableId,
        comment.replies,
        created.id,
      ));
  }

  return count;
}

const invites: {
  code: string;
  community: string;
  creator: UserKey;
  uses: number;
  maxUses?: number;
  expiresIn?: number;
  ago: number;
}[] = [
  {
    code: 'animeclub',
    community: 'Seasonal Anime Club',
    creator: 'admin',
    uses: 12,
    ago: days(10),
  },
  {
    code: 'bebop',
    community: 'Bebop Lounge',
    creator: 'spike',
    uses: 0,
    maxUses: 5,
    expiresIn: days(7),
    ago: hours(3),
  },
  {
    code: 'survey',
    community: 'Survey Corps',
    creator: 'levi',
    uses: 1,
    maxUses: 10,
    expiresIn: days(1),
    ago: hours(20),
  },
  {
    code: 'konoha',
    community: 'Hidden Leaf Village',
    creator: 'sakura',
    uses: 4,
    expiresIn: -days(1),
    ago: days(8),
  },
  {
    code: 'onepiece',
    community: 'Straw Hat Pirates',
    creator: 'zoro',
    uses: 5,
    maxUses: 5,
    ago: days(5),
  },
];

const userIds = {} as Record<UserKey, number>;

const titlePosts: {
  title: keyof typeof media;
  author: UserKey;
  ago: number;
  content: string;
  linkUrl?: string;
  comments?: SeedComment[];
}[] = [
  {
    title: 'frieren',
    author: 'admin',
    ago: hours(6),
    content:
      '<p>Rewatching for the third time and the flashbacks still get me. Himmel was right about everything.</p>',
    comments: [
      {
        author: 'anya',
        ago: hours(5),
        content: '<p>Anya cried at the flower field. Anya is not ashamed.</p>',
      },
      {
        author: 'gojo',
        ago: hours(4),
        content:
          '<p>Strong mage, terrible at small talk. I relate to exactly half of that.</p>',
        replies: [
          {
            author: 'admin',
            ago: hours(3),
            content: '<p>We all know which half, Gojo.</p>',
          },
        ],
      },
    ],
  },
  {
    title: 'onePiece',
    author: 'luffy',
    ago: hours(20),
    content:
      '<p>Best story ever written. Also the food. Mostly the food. 🍖</p>',
    comments: [
      {
        author: 'zoro',
        ago: hours(19),
        content: '<p>You only read the chapters with meat in them.</p>',
      },
      {
        author: 'nami',
        ago: hours(18),
        content: '<p>Spoilers in here and I’m charging interest.</p>',
      },
    ],
  },
  {
    title: 'onePiece',
    author: 'nami',
    ago: days(2),
    content:
      '<p>Rereading arc by arc and charting every island along the way. 🗺️</p>',
  },
  {
    title: 'eldenRing',
    author: 'goku',
    ago: days(1) + hours(2),
    content:
      '<p>Beat Malenia after 64 tries! Next I want to fight someone even stronger.</p>',
    comments: [
      {
        author: 'vegeta',
        ago: days(1),
        content: '<p>It took me 63. Write that down.</p>',
      },
    ],
  },
];

const wallPosts: {
  wall: UserKey;
  author: UserKey;
  ago: number;
  content: string;
  linkUrl?: string;
  comments?: SeedComment[];
}[] = [
  {
    wall: 'admin',
    author: 'gojo',
    ago: 20,
    content:
      '<p>Found the perfect theme song for the next club meetup. Trust me. 😎</p>',
    linkUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    comments: [
      { author: 'admin', ago: 15, content: '<p>I should have known.</p>' },
    ],
  },
  {
    wall: 'luffy',
    author: 'zoro',
    ago: hours(3),
    content: '<p>Someone wrote a whole encyclopedia page about us.</p>',
    linkUrl: 'https://en.wikipedia.org/wiki/One_Piece',
  },
  {
    wall: 'admin',
    author: 'admin',
    ago: 50,
    content:
      '<p>Profiles now have walls! Drop a hello here, friends only. 👋</p>',
    comments: [
      { author: 'gojo', ago: 42, content: '<p>First. Obviously.</p>' },
    ],
  },
  {
    wall: 'admin',
    author: 'naruto',
    ago: 35,
    content:
      '<p>Hey Admin! Thanks for setting all this up. Ramen on me next time! 🍜</p>',
    comments: [
      {
        author: 'admin',
        ago: 30,
        content: '<p>Holding you to that. Extra pork.</p>',
      },
    ],
  },
  {
    wall: 'admin',
    author: 'luffy',
    ago: 400,
    content: '<p>Admin!! Join my crew!! We have meat!!</p>',
  },
  {
    wall: 'naruto',
    author: 'sakura',
    ago: 180,
    content:
      '<p>Don’t forget training tomorrow at 6. <strong>Six.</strong> Not noon.</p>',
    comments: [
      { author: 'sasuke', ago: 170, content: '<p>He’ll be late.</p>' },
      {
        author: 'naruto',
        ago: 160,
        content: '<p>I’ll be early, believe it!</p>',
      },
    ],
  },
  {
    wall: 'luffy',
    author: 'nami',
    ago: 300,
    content:
      '<p>You owe me 200,000 berries. I’m writing it here so everyone sees.</p>',
    comments: [{ author: 'zoro', ago: 280, content: '<p>Ha.</p>' }],
  },
  {
    wall: 'goku',
    author: 'vegeta',
    ago: 720,
    content: '<p>Tomorrow. Gravity room. Don’t you dare bring snacks.</p>',
  },
  {
    wall: 'tanjiro',
    author: 'tanjiro',
    ago: 1200,
    content:
      '<p>Nezuko slept in the sunshine-safe corner all afternoon. Peaceful day. 🌸</p>',
    comments: [{ author: 'nezuko', ago: 1180, content: '<p>Mmm! 🌸</p>' }],
  },
  {
    wall: 'mikasa',
    author: 'levi',
    ago: 2000,
    content: '<p>Your blades were dull at inspection. Fix it.</p>',
  },
];

function communityImage(folder: string, name: string) {
  return `/images/${folder}/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.webp`;
}

const reports: [
  UserKey,
  ReportCategory,
  ReportStatus,
  number,
  string,
  string,
  {
    note?: string;
    hidden?: boolean;
    assignee?: UserKey;
    comments?: [UserKey, number, string][];
  }?,
][] = [
  [
    'naruto',
    'bug',
    'todo',
    25,
    'The post button stayed greyed out after I pasted a long message. Had to type a letter to wake it up.',
    '/explore',
  ],
  [
    'anya',
    'idea',
    'todo',
    90,
    'Anya wants stickers in comments. Peanut sticker. Please.',
    '/',
  ],
  [
    'levi',
    'bug',
    'in_progress',
    240,
    'Feed jumped back to the top after I liked a post. Clean that up.',
    '/',
    {
      assignee: 'admin',
      comments: [
        [
          'admin',
          200,
          'Reproduced on Chrome. Liking refetches the whole feed, which resets the scroll.',
        ],
        [
          'admin',
          150,
          'Switching to an optimistic update so the feed stays put. Testing on mobile next.',
        ],
      ],
    },
  ],
  [
    'nami',
    'idea',
    'todo',
    600,
    'Let community owners pin a post so the rules stay at the top of the feed.',
    '/explore',
    {
      comments: [
        [
          'admin',
          500,
          'Good one. Adding it to the roadmap after folders ship.',
        ],
      ],
    },
  ],
  [
    'spike',
    'other',
    'done',
    1440,
    'Dark mode is easy on the eyes at 3am. That is all.',
    '/profile',
    { note: 'Thanks, Spike! Night owls are our favorite users.' },
  ],
  [
    'luffy',
    'bug',
    'done',
    4320,
    'My name got cut off on the member list. It says "Monkey D. Lu". I am not Lu.',
    '/explore',
    {
      note: 'Fixed! Long names now wrap instead of getting cut off. Sorry, Captain.',
    },
  ],
  [
    'goku',
    'other',
    'todo',
    30,
    'test test is this thing on',
    '/',
    { hidden: true },
  ],
  [
    'gojo',
    'bug',
    'in_progress',
    2880,
    'Uploaded a new cover and the old one showed for a second before switching.',
    '/explore',
    {
      assignee: 'admin',
      comments: [
        [
          'admin',
          2000,
          'Probably the browser cache. The new image needs a fresh URL.',
        ],
      ],
    },
  ],
];

async function createContentReports() {
  const [sasukePost, luffyComment] = await Promise.all([
    prisma.post.findFirst({
      where: { authorId: userIds.sasuke },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    prisma.comment.findFirst({
      where: { authorId: userIds.luffy },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
  ]);

  const reports = [
    sasukePost && {
      reporterId: userIds.naruto,
      targetType: 'post' as const,
      targetId: sasukePost.id,
      reason: 'harassment' as const,
      details: 'He keeps calling me a loser in every post.',
      createdAt: minutesAgo(hours(2)),
    },
    luffyComment && {
      reporterId: userIds.nami,
      targetType: 'comment' as const,
      targetId: luffyComment.id,
      reason: 'spam' as const,
      details: 'The same meat emoji forty times.',
      createdAt: minutesAgo(hours(5)),
    },
    {
      reporterId: userIds.vegeta,
      targetType: 'user' as const,
      targetId: userIds.goku,
      reason: 'other' as const,
      details: 'Challenges me to a fight in every community.',
      createdAt: minutesAgo(days(1)),
    },
  ].filter((report) => report !== null);

  if (sasukePost) {
    reports.push(
      ...(['sakura', 'itadori'] as const).map((reporter, index) => ({
        reporterId: userIds[reporter],
        targetType: 'post' as const,
        targetId: sasukePost.id,
        reason: 'harassment' as const,
        details: null,
        createdAt: minutesAgo(hours(1) - index * 10),
      })),
    );
    await prisma.post.update({
      where: { id: sasukePost.id },
      data: { hiddenAt: minutesAgo(hours(1) - 10) },
    });
  }

  await prisma.contentReport.createMany({ data: reports });
  return reports.length;
}

async function createChats() {
  for (const { between, request, seen, messages } of chats) {
    const [starter, other] = between.map((key) => userIds[key]);
    const [lastAuthor, lastText, lastMinutes] = messages.at(-1)!;
    const lastSenderId = userIds[lastAuthor];
    const lastMessageAt = minutesAgo(lastMinutes);
    let trailing = 0;
    for (const [author] of [...messages].reverse()) {
      if (userIds[author] !== lastSenderId) break;
      trailing += 1;
    }

    await prisma.conversation.create({
      data: {
        ...pair(starter, other),
        lastText,
        lastSenderId,
        lastMessageAt,
        createdAt: minutesAgo(messages[0][2]),
        messages: {
          create: messages.map(([author, text, minutes]) => ({
            senderId: userIds[author],
            text,
            createdAt: minutesAgo(minutes),
          })),
        },
        members: {
          create: [starter, other].map((userId) => {
            const receiving = userId !== lastSenderId;
            return {
              userId,
              status: request && userId === other ? 'request' : 'accepted',
              unread: receiving && !seen ? trailing : 0,
              readAt:
                !receiving || seen
                  ? new Date(lastMessageAt.getTime() + 60_000)
                  : null,
            } as const;
          }),
        },
      },
    });
  }

  for (const group of groups) {
    const lines: [UserKey, string, number, boolean][] = [
      [group.creator, 'created the group', group.created, true],
      ...group.messages.map(
        ([author, text, minutes]) =>
          [author, text, minutes, false] as [UserKey, string, number, boolean],
      ),
    ];
    const [lastAuthor, lastText, lastMinutes, lastSystem] = lines.at(-1)!;

    await prisma.conversation.create({
      data: {
        isGroup: true,
        name: group.name,
        creatorId: userIds[group.creator],
        lastText,
        lastSenderId: userIds[lastAuthor],
        lastSystem,
        lastMessageAt: minutesAgo(lastMinutes),
        createdAt: minutesAgo(group.created),
        messages: {
          create: lines.map(([author, text, minutes, system]) => ({
            senderId: userIds[author],
            text,
            system,
            createdAt: minutesAgo(minutes),
          })),
        },
        members: {
          create: [group.creator, ...group.members].map((key) => {
            const readMinutes = group.readAt[key] ?? group.created;
            return {
              userId: userIds[key],
              readAt: minutesAgo(readMinutes),
              unread: lines.filter(
                ([author, , minutes, system]) =>
                  !system && author !== key && minutes < readMinutes,
              ).length,
            };
          }),
        },
      },
    });
  }

  const reactionEmojis = ['❤️', '😂', '👍', '😮'];
  const seeded = await prisma.conversation.findMany({
    select: {
      members: { select: { userId: true } },
      messages: {
        where: { system: false },
        orderBy: { id: 'asc' },
        select: { id: true, senderId: true },
      },
    },
  });
  for (const { members, messages } of seeded) {
    for (const [index, message] of messages.entries()) {
      const reactor = members.find(({ userId }) => userId !== message.senderId);
      if (index % 3 !== 1 || !reactor) continue;
      await prisma.messageReaction.create({
        data: {
          messageId: message.id,
          userId: reactor.userId,
          emoji: reactionEmojis[index % reactionEmojis.length],
        },
      });
    }
    if (messages.length > 2) {
      await prisma.message.update({
        where: { id: messages[0].id },
        data: { editedAt: new Date() },
      });
    }
    const last = messages.at(-1);
    const quoted =
      last &&
      [...messages]
        .reverse()
        .find(({ senderId }) => senderId !== last.senderId);
    if (last && quoted) {
      await prisma.message.update({
        where: { id: last.id },
        data: { replyToId: quoted.id },
      });
    }
  }

  return chats.length + groups.length;
}

async function createNotifications() {
  const day = 24 * 60 * 60 * 1000;
  const readAt = (createdAt: Date) =>
    Date.now() - createdAt.getTime() > day ? createdAt : null;
  const notifications: {
    userId: number;
    actorId: number;
    type: NotificationType;
    message: string;
    link: string;
    createdAt: Date;
    readAt: Date | null;
  }[] = [];

  const [posts, comments, activities] = await Promise.all([
    prisma.post.findMany({
      select: {
        id: true,
        authorId: true,
        communityId: true,
        wallUserId: true,
        mediaType: true,
        mediaSourceId: true,
        content: true,
        createdAt: true,
        wallUser: { select: { username: true } },
      },
    }),
    prisma.comment.findMany({
      select: {
        authorId: true,
        communityId: true,
        commentableType: true,
        commentableId: true,
        createdAt: true,
        parent: { select: { authorId: true } },
      },
    }),
    prisma.libraryActivity.findMany({
      select: {
        id: true,
        entry: { select: { user: { select: { id: true, username: true } } } },
      },
    }),
  ]);
  const activityOwners = new Map(
    activities.map((activity) => [activity.id, activity.entry.user]),
  );
  const postAuthors = new Map(posts.map((post) => [post.id, post.authorId]));
  const postTitles = new Map(
    posts.flatMap((post) =>
      post.mediaType
        ? [
            [
              post.id,
              `/library/${post.mediaType}/${post.mediaSourceId}`,
            ] as const,
          ]
        : [],
    ),
  );
  const postWalls = new Map(
    posts.flatMap((post) =>
      post.wallUser ? [[post.id, post.wallUser.username] as const] : [],
    ),
  );

  for (const post of posts) {
    const mentions = post.content.matchAll(
      /<a href="\/users\/(\w+)" class="mention">/g,
    );
    for (const [, username] of mentions) {
      const userId = userIds[username as UserKey];
      if (!userId || userId === post.authorId) continue;
      notifications.push({
        userId,
        actorId: post.authorId,
        type: 'mention',
        message: 'mentioned you in a post',
        link: post.wallUser
          ? `/users/${post.wallUser.username}`
          : post.mediaType
            ? `/library/${post.mediaType}/${post.mediaSourceId}`
            : `/communities/${post.communityId}`,
        createdAt: post.createdAt,
        readAt: readAt(post.createdAt),
      });
    }
    if (post.wallUser && post.wallUserId !== post.authorId) {
      notifications.push({
        userId: post.wallUserId!,
        actorId: post.authorId,
        type: 'wall_post',
        message: 'posted on your wall',
        link: `/users/${post.wallUser.username}`,
        createdAt: post.createdAt,
        readAt: readAt(post.createdAt),
      });
    }
  }

  for (const comment of comments) {
    const isActivity = comment.commentableType === 'activity';
    const activityOwner = isActivity
      ? activityOwners.get(comment.commentableId)
      : undefined;
    const ownerId = isActivity
      ? activityOwner?.id
      : postAuthors.get(comment.commentableId);
    const wall = isActivity
      ? activityOwner?.username
      : postWalls.get(comment.commentableId);
    const titleLink =
      comment.commentableType === 'post'
        ? postTitles.get(comment.commentableId)
        : undefined;
    const base = {
      actorId: comment.authorId,
      link:
        titleLink ??
        (wall ? `/users/${wall}` : `/communities/${comment.communityId}`),
      createdAt: comment.createdAt,
      readAt: readAt(comment.createdAt),
    };

    if (comment.parent && comment.parent.authorId !== comment.authorId) {
      notifications.push({
        ...base,
        userId: comment.parent.authorId,
        type: 'comment_reply',
        message: 'replied to your comment',
      });
    }
    if (
      ownerId !== undefined &&
      ownerId !== comment.authorId &&
      ownerId !== comment.parent?.authorId
    ) {
      notifications.push({
        ...base,
        userId: ownerId,
        type: 'post_comment',
        message: isActivity
          ? 'commented on your library update'
          : 'commented on your post',
      });
    }
  }

  const friendships = await prisma.friendship.findMany();
  for (const friendship of friendships) {
    const pending = friendship.status === 'pending';
    notifications.push({
      userId: pending ? friendship.addresseeId : friendship.requesterId,
      actorId: pending ? friendship.requesterId : friendship.addresseeId,
      type: pending ? 'friend_request' : 'friend_accepted',
      message: pending
        ? 'sent you a friend request'
        : 'accepted your friend request',
      link: '/',
      createdAt: friendship.createdAt,
      readAt: pending ? null : friendship.createdAt,
    });
  }

  const movedReports = await prisma.report.findMany({
    where: { status: { not: 'todo' } },
    select: {
      id: true,
      authorId: true,
      status: true,
      category: true,
      resolutionNote: true,
      createdAt: true,
    },
  });
  for (const report of movedReports) {
    notifications.push({
      userId: report.authorId,
      actorId: userIds.admin,
      type: 'report_status',
      message: `updated your report ${ticketNumber(report.id)}: ${getReporterStatusLabel(report.status, report.category)}${report.resolutionNote ? ` — “${report.resolutionNote}”` : ''}`,
      link: '/reports',
      createdAt: new Date(
        Math.min(Date.now(), report.createdAt.getTime() + 20 * 60 * 1000),
      ),
      readAt: null,
    });
  }

  await prisma.notification.createMany({ data: notifications });
  return notifications.length;
}

const media = {
  frieren: [
    'anime',
    '154587',
    'Sousou no Frieren',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg',
    2023,
    28,
  ],
  bebop: [
    'anime',
    '1',
    'Cowboy Bebop',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-GCsPm7waJ4kS.png',
    1998,
    26,
  ],
  demonSlayer: [
    'anime',
    '101922',
    'Kimetsu no Yaiba',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg',
    2019,
    26,
  ],
  jujutsu: [
    'anime',
    '113415',
    'Jujutsu Kaisen',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg',
    2020,
    24,
  ],
  spyFamily: [
    'anime',
    '140960',
    'SPY×FAMILY',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx140960-Kb6R5nYQfjmP.jpg',
    2022,
    12,
  ],
  titan: [
    'anime',
    '16498',
    'Shingeki no Kyojin',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg',
    2013,
    25,
  ],
  dbz: [
    'anime',
    '813',
    'Dragon Ball Z',
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx813-ZhnFNOeCU5dQ.png',
    1989,
    291,
  ],
  onePiece: [
    'manga',
    '30013',
    'ONE PIECE',
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx30013-BeslEMqiPhlk.jpg',
    1997,
    null,
  ],
  naruto: [
    'manga',
    '30011',
    'NARUTO',
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/nx30011-9yUF1dXWgDOx.jpg',
    1999,
    700,
  ],
  chainsaw: [
    'manga',
    '105778',
    'Chainsaw Man',
    'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx105778-euxXZEIfDY2u.png',
    2018,
    null,
  ],
  persona: [
    'game',
    '117731',
    'Persona 5 Strikers',
    'https://images.igdb.com/igdb/image/upload/t_cover_big/co2zoq.jpg',
    2020,
    null,
  ],
  hollowKnight: [
    'game',
    '365702',
    'Hollow Knight',
    'https://images.igdb.com/igdb/image/upload/t_cover_big/cocpbl.jpg',
    2023,
    null,
  ],
  stardew: [
    'game',
    '17000',
    'Stardew Valley',
    'https://images.igdb.com/igdb/image/upload/t_cover_big/coa93h.jpg',
    2016,
    null,
  ],
  eldenRing: [
    'game',
    '325591',
    'Elden Ring Nightreign',
    'https://images.igdb.com/igdb/image/upload/t_cover_big/co95gk.jpg',
    2025,
    null,
  ],
} as const satisfies Record<
  string,
  [MediaType, string, string, string, number, number | null]
>;

const library: [UserKey, keyof typeof media, LibraryStatus, boolean, number][] =
  [
    ['admin', 'frieren', 'completed', true, hours(3)],
    ['admin', 'hollowKnight', 'current', false, days(2)],
    ['admin', 'stardew', 'on_hold', true, days(5)],
    ['naruto', 'naruto', 'completed', true, hours(5)],
    ['naruto', 'demonSlayer', 'current', true, days(3)],
    ['luffy', 'onePiece', 'current', true, hours(8)],
    ['spike', 'bebop', 'completed', true, hours(14)],
    ['tanjiro', 'demonSlayer', 'completed', true, days(1)],
    ['gojo', 'jujutsu', 'current', true, hours(20)],
    ['itadori', 'jujutsu', 'planned', true, days(2)],
    ['itadori', 'chainsaw', 'dropped', false, days(4)],
    ['anya', 'spyFamily', 'current', true, hours(2)],
    ['levi', 'titan', 'completed', true, days(6)],
    ['mikasa', 'titan', 'planned', true, days(3)],
    ['goku', 'dbz', 'current', true, hours(30)],
    ['nami', 'stardew', 'planned', true, days(1)],
    ['vegeta', 'eldenRing', 'dropped', true, hours(12)],
    ['zoro', 'persona', 'current', false, days(2)],
  ];

const activityComments: {
  owner: UserKey;
  media: keyof typeof media;
  comments: SeedComment[];
}[] = [
  {
    owner: 'anya',
    media: 'spyFamily',
    comments: [
      {
        author: 'naruto',
        ago: 60,
        content: '<p>Spies, peanuts, and a dog. Classic Anya.</p>',
      },
      {
        author: 'nami',
        ago: 50,
        content: '<p>Bond is the real MVP of that show.</p>',
        replies: [
          {
            author: 'anya',
            ago: 40,
            content: '<p>Anya agrees. Bond is best boy. Waku waku!</p>',
          },
        ],
      },
    ],
  },
  {
    owner: 'admin',
    media: 'frieren',
    comments: [
      {
        author: 'gojo',
        ago: 150,
        content: '<p>Took you long enough. Fern supremacy.</p>',
      },
      {
        author: 'naruto',
        ago: 120,
        content: '<p>Is it sad? Sakura said it’s sad.</p>',
        replies: [
          {
            author: 'admin',
            ago: 110,
            content: '<p>Quietly devastating. In a good way.</p>',
          },
        ],
      },
    ],
  },
  {
    owner: 'luffy',
    media: 'onePiece',
    comments: [
      {
        author: 'zoro',
        ago: hours(7),
        content: '<p>You’re reading about yourself?</p>',
      },
      {
        author: 'nami',
        ago: hours(6),
        content: '<p>Skip to the parts where I’m right. So, all of them.</p>',
      },
    ],
  },
  {
    owner: 'gojo',
    media: 'jujutsu',
    comments: [
      {
        author: 'itadori',
        ago: hours(18),
        content: '<p>Sensei, you’re literally in this.</p>',
        replies: [
          {
            author: 'gojo',
            ago: hours(17),
            content: '<p>And I’m the best part. Obviously.</p>',
          },
        ],
      },
    ],
  },
  {
    owner: 'spike',
    media: 'bebop',
    comments: [
      {
        author: 'goku',
        ago: hours(12),
        content: '<p>Is there a lot of fighting? I’m in.</p>',
      },
    ],
  },
];

async function createActivityComments() {
  for (const { owner, media: key, comments } of activityComments) {
    const [mediaType, sourceId] = media[key];
    const activity = await prisma.libraryActivity.findFirst({
      where: { entry: { userId: userIds[owner], mediaType, sourceId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!activity) throw new Error(`No library activity for ${owner}/${key}`);

    const commentCount = await createComments(
      null,
      'activity',
      activity.id,
      comments,
    );
    await prisma.libraryActivity.update({
      where: { id: activity.id },
      data: { commentCount },
    });
  }
}

function seededPick(itemId: number, userId: number, percent: number) {
  return (itemId * 31 + userId * 17) % 100 < percent;
}

async function createLikes(): Promise<number> {
  const [posts, activities, memberships, friendships] = await Promise.all([
    prisma.post.findMany({
      select: {
        id: true,
        authorId: true,
        communityId: true,
        wallUserId: true,
        createdAt: true,
      },
    }),
    prisma.libraryActivity.findMany({
      where: { entry: { isPublic: true } },
      select: {
        id: true,
        createdAt: true,
        entry: { select: { userId: true } },
      },
    }),
    prisma.membership.findMany({
      select: { userId: true, communityId: true },
    }),
    prisma.friendship.findMany({
      where: { status: 'accepted' },
      select: { requesterId: true, addresseeId: true },
    }),
  ]);

  const membersOf = new Map<number, number[]>();
  for (const { userId, communityId } of memberships) {
    membersOf.set(communityId, [...(membersOf.get(communityId) ?? []), userId]);
  }
  const friendsOf = (userId: number) =>
    friendships.flatMap(({ requesterId, addresseeId }) =>
      requesterId === userId
        ? [addresseeId]
        : addresseeId === userId
          ? [requesterId]
          : [],
    );
  const neighborsOf = (userId: number) => [
    ...new Set(
      memberships
        .filter((membership) => membership.userId === userId)
        .flatMap(({ communityId }) => membersOf.get(communityId) ?? []),
    ),
  ];
  const likedAt = (createdAt: Date, offset: number) =>
    new Date(
      Math.min(Date.now(), createdAt.getTime() + (offset + 1) * 7 * 60 * 1000),
    );

  const likes: {
    userId: number;
    likeableType: 'post' | 'activity';
    likeableId: number;
    createdAt: Date;
  }[] = [];

  for (const post of posts) {
    const candidates = post.communityId
      ? (membersOf.get(post.communityId) ?? [])
      : post.wallUserId
        ? [post.wallUserId, ...friendsOf(post.wallUserId)]
        : Object.values(userIds);
    const likers = [...new Set(candidates)].filter(
      (userId) => userId !== post.authorId && seededPick(post.id, userId, 45),
    );
    likers.forEach((userId, index) =>
      likes.push({
        userId,
        likeableType: 'post',
        likeableId: post.id,
        createdAt: likedAt(post.createdAt, index),
      }),
    );
    await prisma.post.update({
      where: { id: post.id },
      data: { likeCount: likers.length },
    });
  }

  for (const activity of activities) {
    const likers = neighborsOf(activity.entry.userId).filter(
      (userId) =>
        userId !== activity.entry.userId && seededPick(activity.id, userId, 30),
    );
    likers.forEach((userId, index) =>
      likes.push({
        userId,
        likeableType: 'activity',
        likeableId: activity.id,
        createdAt: likedAt(activity.createdAt, index),
      }),
    );
    await prisma.libraryActivity.update({
      where: { id: activity.id },
      data: { likeCount: likers.length },
    });
  }

  await prisma.like.createMany({ data: likes });
  return likes.length;
}

const earlierStatuses: Record<LibraryStatus, LibraryStatus[]> = {
  planned: [],
  current: ['planned'],
  completed: ['planned', 'current'],
  on_hold: ['current'],
  dropped: ['current'],
};

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function main() {
  console.log('🌱 Seeding database...');

  await prisma.comment.deleteMany();
  await prisma.post.deleteMany();
  await prisma.community.deleteMany();
  await prisma.user.deleteMany();

  const characterPassword = await bcrypt.hash(CHARACTER_PASSWORD, 10);

  const admin = await prisma.user.create({
    data: {
      email: 'admin@user.com',
      username: 'admin',
      name: 'Admin',
      avatarUrl: '/images/avatars/admin.webp',
      coverUrl: '/images/user-covers/admin.webp',
      backgroundUrl: '/images/user-backgrounds/admin.webp',
      isAdmin: true,
      tourCompletedAt: minutesAgo(days(30)),
      checklistDismissedAt: minutesAgo(days(29)),
      completedTours: PAGE_TOURS,
      password: await bcrypt.hash('123456', 10),
      emailVerifiedAt: minutesAgo(days(30)),
      createdAt: minutesAgo(days(30)),
    },
  });
  userIds.admin = admin.id;
  await prisma.oAuthAccount.create({
    data: {
      userId: admin.id,
      provider: 'discord',
      providerAccountId: '100000000000000001',
      username: 'orbis_admin',
    },
  });
  await prisma.oAuthAccount.create({
    data: {
      userId: admin.id,
      provider: 'twitch',
      providerAccountId: '200000001',
      username: 'orbis_admin',
    },
  });

  const user = await prisma.user.create({
    data: {
      email: 'user@user.com',
      username: 'user',
      name: 'User',
      avatarUrl: '/images/avatars/user.webp',
      coverUrl: '/images/user-covers/user.webp',
      backgroundUrl: '/images/user-backgrounds/user.webp',
      password: await bcrypt.hash('123456', 10),
      emailVerifiedAt: minutesAgo(days(2)),
      createdAt: minutesAgo(days(2)),
    },
  });
  userIds.user = user.id;

  for (const [key, name] of Object.entries(characters)) {
    const user = await prisma.user.create({
      data: {
        email: `${key}@anime.test`,
        username: key,
        name,
        avatarUrl: `/images/avatars/${key}.webp`,
        coverUrl: `/images/user-covers/${key}.webp`,
        backgroundUrl: `/images/user-backgrounds/${key}.webp`,
        isPublic: !privateProfiles.includes(key as Character),
        isVerified: verifiedProfiles.includes(key as Character),
        status: key === 'gojo' ? 'busy' : key === 'nami' ? 'idle' : 'online',
        tourCompletedAt: minutesAgo(days(30)),
        checklistDismissedAt: minutesAgo(days(29)),
        completedTours: PAGE_TOURS,
        password: characterPassword,
        emailVerifiedAt: minutesAgo(days(30)),
        createdAt: minutesAgo(days(30)),
        ...(key === 'sasuke' && {
          suspendedAt: minutesAgo(days(1)),
          suspendedUntil: minutesAgo(-days(6)),
          suspensionReason: 'Left the village without telling anyone, again',
        }),
      },
    });
    userIds[key as Character] = user.id;
  }

  console.log('👤 Users created:', Object.keys(userIds).length);

  const positions = {} as Record<UserKey, number>;

  for (const community of communities) {
    const memberKeys = new Set(community.members.map(([key]) => key));
    const commentsByPost = postComments[community.name] ?? {};
    const outsider = [
      community.owner,
      ...(community.admins ?? []),
      ...community.posts.map(([key]) => key),
      ...Object.values(commentsByPost).flatMap((comments) =>
        participants(comments),
      ),
    ].find((key) => !memberKeys.has(key));
    if (outsider) {
      throw new Error(`"${community.name}": ${outsider} isn't a member`);
    }

    const created = await prisma.community.create({
      data: {
        name: community.name,
        description: community.description,
        iconUrl: communityImage('communities', community.name),
        coverUrl: communityImage('covers', community.name),
        backgroundUrl: communityImage('backgrounds', community.name),
        ownerId: userIds[community.owner],
        isPublic: community.isPublic,
        isVerified: community.isVerified ?? false,
        createdAt: minutesAgo(days(14)),
        memberships: {
          create: community.members.map(([key, nickname], index) => {
            const position = positions[key] ?? 0;
            positions[key] = position + 1;
            return {
              userId: userIds[key],
              nickname,
              position,
              joinedAt: minutesAgo(days(14) - index * 60),
            };
          }),
        },
      },
    });

    if (community.name === 'Seasonal Anime Club') {
      await prisma.community.update({
        where: { id: created.id },
        data: {
          twitchUserId: '300000001',
          twitchLogin: 'seasonalanimeclub',
          discordGuildId: '300000000000000001',
          discordGuildName: 'Seasonal Anime Club',
          links: {
            x: 'https://x.com/seasonalanimeclub',
            youtube: 'https://www.youtube.com/@seasonalanimeclub',
            kick: 'https://kick.com/seasonalanimeclub',
            reddit: 'https://www.reddit.com/r/seasonalanimeclub',
          },
        },
      });
      const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      await prisma.invite.create({
        data: {
          code: Array.from({ length: 100 }, () => alphabet[randomInt(62)]).join(
            '',
          ),
          communityId: created.id,
          creatorId: userIds[community.owner],
          permanent: true,
          uses: 3,
        },
      });
    }

    for (const [index, [key, ago, content]] of community.posts.entries()) {
      const post = await prisma.post.create({
        data: {
          communityId: created.id,
          authorId: userIds[key],
          content,
          createdAt: minutesAgo(ago),
        },
      });
      const commentCount = await createComments(
        created.id,
        'post',
        post.id,
        commentsByPost[index],
      );
      await prisma.post.update({
        where: { id: post.id },
        data: { commentCount },
      });
    }

    if (community.admins?.length) {
      const role = await prisma.role.create({
        data: {
          communityId: created.id,
          name: 'Admin',
          permissions: ADMINISTRATOR,
        },
      });
      await prisma.membershipRole.createMany({
        data: community.admins.map((key) => ({
          userId: userIds[key],
          communityId: created.id,
          roleId: role.id,
        })),
      });
    }
  }

  const adminFolder = [
    'Hidden Leaf Village',
    'Straw Hat Pirates',
    'Demon Slayer Corps',
  ];
  const adminMemberships = await prisma.membership.findMany({
    where: { userId: userIds.admin },
    orderBy: { position: 'asc' },
    include: { community: { select: { name: true } } },
  });
  const folderAt = adminMemberships.findIndex(({ community }) =>
    adminFolder.includes(community.name),
  );
  const folder = await prisma.railFolder.create({
    data: {
      userId: userIds.admin,
      name: 'Shōnen',
      color: '#f08a4b',
      position: folderAt,
    },
  });
  let topLevel = 0;
  for (const membership of adminMemberships) {
    const inFolder = adminFolder.indexOf(membership.community.name);
    if (topLevel === folderAt) topLevel++;
    await prisma.membership.update({
      where: {
        userId_communityId: {
          userId: membership.userId,
          communityId: membership.communityId,
        },
      },
      data:
        inFolder === -1
          ? { position: topLevel++ }
          : { position: inFolder, folderId: folder.id },
    });
  }

  for (const invite of invites) {
    const { id: communityId } = await prisma.community.findFirstOrThrow({
      where: { name: invite.community },
      select: { id: true },
    });
    await prisma.invite.create({
      data: {
        code: invite.code,
        communityId,
        creatorId: userIds[invite.creator],
        uses: invite.uses,
        maxUses: invite.maxUses,
        expiresAt:
          invite.expiresIn === undefined ? null : minutesAgo(-invite.expiresIn),
        createdAt: minutesAgo(invite.ago),
      },
    });
  }
  console.log(
    '✉️ Invites created:',
    invites.map(({ code }) => code),
  );

  console.log(
    '🏘️ Communities created:',
    communities.map(({ name }) => name),
  );

  await prisma.friendship.createMany({
    data: friendships.map(([requester, addressee, status]) => ({
      requesterId: userIds[requester],
      addresseeId: userIds[addressee],
      status,
    })),
  });

  console.log('🤝 Friendships created:', friendships.length);

  await prisma.suggestionDismissal.createMany({
    data: suggestionDismissals.map(([user, dismissed, daysAgo]) => ({
      userId: userIds[user],
      dismissedUserId: userIds[dismissed],
      dismissedAt: minutesAgo(days(daysAgo)),
    })),
  });

  for (const wallPost of wallPosts) {
    const post = await prisma.post.create({
      data: {
        wallUserId: userIds[wallPost.wall],
        authorId: userIds[wallPost.author],
        content: wallPost.content,
        linkUrl: wallPost.linkUrl,
        createdAt: minutesAgo(wallPost.ago),
      },
    });
    const commentCount = await createComments(
      null,
      'post',
      post.id,
      wallPost.comments,
    );
    await prisma.post.update({
      where: { id: post.id },
      data: { commentCount },
    });
  }

  console.log('🧱 Wall posts created:', wallPosts.length);

  for (const titlePost of titlePosts) {
    const [mediaType, mediaSourceId] = media[titlePost.title];
    const post = await prisma.post.create({
      data: {
        mediaType,
        mediaSourceId,
        authorId: userIds[titlePost.author],
        content: titlePost.content,
        linkUrl: titlePost.linkUrl,
        createdAt: minutesAgo(titlePost.ago),
      },
    });
    const commentCount = await createComments(
      null,
      'post',
      post.id,
      titlePost.comments,
    );
    await prisma.post.update({
      where: { id: post.id },
      data: { commentCount },
    });
  }

  console.log('🎬 Title wall posts created:', titlePosts.length);

  for (const [
    author,
    category,
    status,
    ago,
    message,
    pageUrl,
    extra,
  ] of reports) {
    await prisma.report.create({
      data: {
        authorId: userIds[author],
        category,
        status,
        message,
        pageUrl,
        resolutionNote: extra?.note,
        hiddenAt: extra?.hidden ? minutesAgo(ago - 10) : null,
        assigneeId: extra?.assignee && userIds[extra.assignee],
        createdAt: minutesAgo(ago),
        comments: {
          create: (extra?.comments ?? []).map(
            ([commenter, commentAgo, content]) => ({
              authorId: userIds[commenter],
              content,
              createdAt: minutesAgo(commentAgo),
            }),
          ),
        },
      },
    });
  }

  console.log('📣 Reports created:', reports.length);

  for (const [user, key, status, isPublic, ago] of library) {
    const [mediaType, sourceId, title, coverImage, year, total] = media[key];
    const share = {
      completed: 1,
      current: 0.45,
      on_hold: 0.3,
      dropped: 0.15,
      planned: 0,
    }[status];
    const progress =
      mediaType === 'game'
        ? 0
        : total
          ? Math.round(total * share)
          : status === 'planned'
            ? 0
            : { current: 1100, dropped: 40, completed: 1, on_hold: 20 }[status];
    const history = [...earlierStatuses[status], status];
    const at = (step: number) =>
      minutesAgo(ago + (history.length - 1 - step) * days(3));

    await prisma.libraryEntry.create({
      data: {
        userId: userIds[user],
        mediaId: `${mediaType.toUpperCase()}_${sourceId}`,
        mediaType,
        sourceId,
        title,
        coverImage,
        year,
        status,
        progress,
        total,
        isPublic,
        createdAt: at(0),
        updatedAt: at(history.length - 1),
        activities: {
          create: [
            ...history.map((step, index) => ({
              status: step,
              createdAt: at(index),
            })),
            ...(status === 'current' && total && progress > 1
              ? [
                  {
                    status,
                    progressFrom: Math.max(1, progress - 2),
                    progressTo: progress,
                    createdAt: minutesAgo(Math.max(0, ago - 45)),
                  },
                ]
              : []),
          ],
        },
      },
    });
  }

  console.log('📚 Library entries created:', library.length);

  await createActivityComments();
  console.log('💬 Library update comments created:', activityComments.length);

  console.log('❤️ Likes created:', await createLikes());

  console.log('🚩 Content reports created:', await createContentReports());
  console.log('🔔 Notifications created:', await createNotifications());
  console.log('💬 Chats created:', await createChats());

  console.log('✅ Seeding complete!');
  console.log('🔑 admin (or admin@user.com) / 123456');
  console.log('🔑 user (or user@user.com) / 123456');
  console.log(
    `🔑 <character> (or <character>@anime.test) / ${CHARACTER_PASSWORD} (e.g. naruto)`,
  );
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
