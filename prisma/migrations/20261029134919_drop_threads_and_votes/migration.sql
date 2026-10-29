DELETE FROM "Notification" WHERE "type" = 'thread_comment' OR "link" LIKE '%thread=%';
DELETE FROM "ContentReport" WHERE "targetType" = 'thread';
DELETE FROM "ContentReport" WHERE "targetType" = 'comment' AND "targetId" IN (SELECT "id" FROM "Comment" WHERE "commentableType" = 'thread');
DELETE FROM "DiscordMessage" WHERE "targetType" = 'thread';
DELETE FROM "Comment" WHERE "commentableType" = 'thread';

-- AlterEnum
BEGIN;
CREATE TYPE "CommentableType_new" AS ENUM ('post', 'activity');
ALTER TABLE "DiscordMessage" ALTER COLUMN "targetType" TYPE "CommentableType_new" USING ("targetType"::text::"CommentableType_new");
ALTER TABLE "Comment" ALTER COLUMN "commentableType" TYPE "CommentableType_new" USING ("commentableType"::text::"CommentableType_new");
ALTER TYPE "CommentableType" RENAME TO "CommentableType_old";
ALTER TYPE "CommentableType_new" RENAME TO "CommentableType";
DROP TYPE "public"."CommentableType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ContentReportTarget_new" AS ENUM ('post', 'comment', 'user', 'community');
ALTER TABLE "ContentReport" ALTER COLUMN "targetType" TYPE "ContentReportTarget_new" USING ("targetType"::text::"ContentReportTarget_new");
ALTER TYPE "ContentReportTarget" RENAME TO "ContentReportTarget_old";
ALTER TYPE "ContentReportTarget_new" RENAME TO "ContentReportTarget";
DROP TYPE "public"."ContentReportTarget_old";
COMMIT;

-- AlterEnum
ALTER TYPE "LikeableType" ADD VALUE 'comment';

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('post_comment', 'comment_reply', 'friend_request', 'friend_accepted', 'report_status', 'report_assigned', 'report_comment', 'wall_post', 'mention');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "public"."NotificationType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Thread" DROP CONSTRAINT "Thread_authorId_fkey";

-- DropForeignKey
ALTER TABLE "Thread" DROP CONSTRAINT "Thread_communityId_fkey";

-- DropForeignKey
ALTER TABLE "Vote" DROP CONSTRAINT "Vote_communityId_fkey";

-- DropForeignKey
ALTER TABLE "Vote" DROP CONSTRAINT "Vote_userId_fkey";

-- AlterTable
ALTER TABLE "Comment" DROP COLUMN "score",
ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DiscordChannel" DROP COLUMN "sendThreads";

-- DropTable
DROP TABLE "Thread";

-- DropTable
DROP TABLE "Vote";

-- DropEnum
DROP TYPE "VotableType";

