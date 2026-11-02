-- AlterTable
ALTER TABLE "ForumCategory" ADD COLUMN     "postToFeed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "forumThreadId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Post_forumThreadId_key" ON "Post"("forumThreadId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_forumThreadId_fkey" FOREIGN KEY ("forumThreadId") REFERENCES "ForumThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

