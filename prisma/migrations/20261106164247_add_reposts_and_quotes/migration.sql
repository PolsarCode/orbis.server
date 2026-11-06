-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'repost';
ALTER TYPE "NotificationType" ADD VALUE 'quote';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "quoteActivityId" INTEGER,
ADD COLUMN     "quotePostId" INTEGER;

-- CreateTable
CREATE TABLE "Repost" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "postId" INTEGER,
    "activityId" INTEGER,
    "communityId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Repost_postId_createdAt_idx" ON "Repost"("postId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Repost_activityId_createdAt_idx" ON "Repost"("activityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Repost_communityId_createdAt_idx" ON "Repost"("communityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Repost_userId_createdAt_idx" ON "Repost"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Repost_userId_postId_key" ON "Repost"("userId", "postId");

-- CreateIndex
CREATE UNIQUE INDEX "Repost_userId_activityId_key" ON "Repost"("userId", "activityId");

-- CreateIndex
CREATE INDEX "Post_quotePostId_createdAt_idx" ON "Post"("quotePostId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Post_quoteActivityId_createdAt_idx" ON "Post"("quoteActivityId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_quotePostId_fkey" FOREIGN KEY ("quotePostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_quoteActivityId_fkey" FOREIGN KEY ("quoteActivityId") REFERENCES "LibraryActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "LibraryActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "Repost" ADD CONSTRAINT "Repost_one_original_check" CHECK (
  (("postId" IS NOT NULL)::int + ("activityId" IS NOT NULL)::int) = 1
);

-- AddCheckConstraint
ALTER TABLE "Post" ADD CONSTRAINT "Post_one_quote_check" CHECK (
  "quotePostId" IS NULL OR "quoteActivityId" IS NULL
);
