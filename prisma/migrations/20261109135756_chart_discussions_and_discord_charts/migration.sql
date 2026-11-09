-- AlterEnum
ALTER TYPE "CommentableType" ADD VALUE 'chart';

-- CreateTable
CREATE TABLE "DiscordChartChannel" (
    "communityId" INTEGER NOT NULL,
    "webhookId" TEXT NOT NULL,
    "webhookToken" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "guildName" TEXT,
    "channelId" TEXT NOT NULL,
    "isForum" BOOLEAN NOT NULL DEFAULT false,
    "sendAnime" BOOLEAN NOT NULL DEFAULT false,
    "sendManga" BOOLEAN NOT NULL DEFAULT false,
    "sendGames" BOOLEAN NOT NULL DEFAULT false,
    "message" VARCHAR(500),
    "lostAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordChartChannel_pkey" PRIMARY KEY ("communityId")
);

-- CreateTable
CREATE TABLE "DiscordChartPost" (
    "communityId" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "week" TEXT NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordChartPost_pkey" PRIMARY KEY ("communityId","mediaType","week")
);

-- CreateTable
CREATE TABLE "ChartDiscussion" (
    "id" SERIAL NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "week" TEXT NOT NULL,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChartDiscussion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChartDiscussion_mediaType_week_key" ON "ChartDiscussion"("mediaType", "week");

-- AddForeignKey
ALTER TABLE "DiscordChartChannel" ADD CONSTRAINT "DiscordChartChannel_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordChartPost" ADD CONSTRAINT "DiscordChartPost_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
