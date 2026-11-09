import { Logger } from '@nestjs/common';
import { renderReportCard } from './report-card';
import { ReportCategory, ReportStatus } from '../../prisma/generated/client';
import { ticketNumber } from './ticket';
import {
  DiscordError,
  postToWebhook,
  WebhookFile,
} from '../discord-channel/discord-webhook';

export const DISCORD_WEBHOOK =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[\w-]{60,100}$/;

const categoryStyle: Record<
  ReportCategory,
  { label: string; emoji: string; color: number }
> = {
  bug: { label: 'Bug', emoji: '🐞', color: 0xe5484d },
  idea: { label: 'Idea', emoji: '💡', color: 0xf0c46c },
  other: { label: 'Other', emoji: '💬', color: 0x99958e },
};

export type DiscordReport = {
  id: number;
  category: ReportCategory;
  message: string;
  status: ReportStatus;
  assignee: DiscordPerson | null;
  hiddenAt: Date | null;
  resolutionNote: string | null;
  pageUrl: string | null;
  createdAt: Date;
  author: DiscordPerson;
};

export type DiscordPerson = {
  username: string;
  name: string | null;
  avatarUrl: string | null;
};

export type DiscordTarget = { webhookUrl: string; siteUrl: string };

function embedAuthor(siteUrl: string, person: DiscordPerson) {
  const site = siteUrl.replace(/\/$/, '');
  const icon = person.avatarUrl?.startsWith('/')
    ? `${site}${person.avatarUrl}`
    : person.avatarUrl;
  return {
    name: person.name ?? `@${person.username}`,
    url: `${site}/users/${person.username}`,
    ...(icon && /^https?:\/\//.test(icon) && { icon_url: icon }),
  };
}

function sender(siteUrl: string) {
  return {
    username: 'Orbis',
    avatar_url: `${siteUrl.replace(/\/$/, '')}/apple-icon`,
    allowed_mentions: { parse: [] },
  };
}

function payload(report: DiscordReport, siteUrl: string, withButton: boolean) {
  const style = categoryStyle[report.category];
  const link = `${siteUrl.replace(/\/$/, '')}/reports?report=${report.id}`;
  const from = report.author.name
    ? `${report.author.name} (@${report.author.username})`
    : `@${report.author.username}`;

  return {
    ...sender(siteUrl),
    embeds: [
      {
        author: embedAuthor(siteUrl, report.author),
        title: `${style.emoji} ${style.label} report ${ticketNumber(report.id)}`,
        url: link,
        description: report.message.slice(0, 4000),
        color: style.color,
        fields: [
          { name: 'From', value: from, inline: true },
          ...(report.pageUrl
            ? [{ name: 'Page', value: report.pageUrl, inline: true }]
            : []),
        ],
        timestamp: report.createdAt.toISOString(),
      },
    ],
    ...(withButton
      ? {
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 5, label: 'View report', url: link },
              ],
            },
          ],
        }
      : {}),
  };
}

const logger = new Logger('DiscordTickets');

async function imageFor(
  report?: DiscordReport,
  activity?: { title: string; description?: string },
): Promise<WebhookFile | undefined> {
  if (!report) return undefined;
  try {
    return {
      filename: `ticket-${report.id}.png`,
      data: await renderReportCard(report, activity),
      description: 'Ticket summary and latest activity',
    };
  } catch (error) {
    logger.warn(
      `Could not render ticket ${report.id}: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
}

function send(url: string, payload: { embeds: object[] }, image?: WebhookFile) {
  return postToWebhook(
    url,
    image
      ? {
          ...payload,
          embeds: payload.embeds.map((embed, index) =>
            index === 0
              ? { ...embed, image: { url: `attachment://${image.filename}` } }
              : embed,
          ),
        }
      : payload,
    image,
  );
}

async function deliver(
  webhookUrl: string,
  withButton: { embeds: object[] },
  plain: { embeds: object[] },
  image?: WebhookFile,
) {
  try {
    await send(`${webhookUrl}?with_components=true`, withButton, image);
  } catch (error) {
    if (!(error instanceof DiscordError)) throw error;
    await send(webhookUrl, plain, image);
  }
}

export type DiscordActivity = {
  report?: DiscordReport;
  path: string;
  actor: DiscordPerson;
  title: string;
  description?: string;
  color: number;
};

export const ACTIVITY_COLOR = {
  comment: 0x6fa0f0,
  move: 0x83ac83,
  hide: 0x777970,
  assign: 0xb195f2,
  flag: 0xe5484d,
} as const;

export async function postActivityToDiscord(
  { webhookUrl, siteUrl }: DiscordTarget,
  { path, actor, title, description, color, report }: DiscordActivity,
) {
  const link = `${siteUrl.replace(/\/$/, '')}${path}`;
  const embed = {
    author: embedAuthor(siteUrl, actor),
    title,
    url: link,
    description: description?.slice(0, 4000),
    color,
    timestamp: new Date().toISOString(),
  };
  const button = {
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'View report', url: link }],
      },
    ],
  };
  const base = { ...sender(siteUrl), embeds: [embed] };
  const image = await imageFor(report, { title, description });

  await deliver(webhookUrl, { ...base, ...button }, base, image);
}

export async function postReportToDiscord(
  { webhookUrl, siteUrl }: DiscordTarget,
  report: DiscordReport,
) {
  await deliver(
    webhookUrl,
    payload(report, siteUrl, true),
    payload(report, siteUrl, false),
    await imageFor(report),
  );
}
