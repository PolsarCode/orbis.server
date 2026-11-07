-- CreateTable
CREATE TABLE "EditVersion" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER,
    "commentId" INTEGER,
    "forumPostId" INTEGER,
    "content" TEXT NOT NULL,
    "linkUrl" TEXT,
    "spoiler" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EditVersion_postId_createdAt_idx" ON "EditVersion"("postId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EditVersion_commentId_createdAt_idx" ON "EditVersion"("commentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EditVersion_forumPostId_createdAt_idx" ON "EditVersion"("forumPostId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "EditVersion" ADD CONSTRAINT "EditVersion_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditVersion" ADD CONSTRAINT "EditVersion_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditVersion" ADD CONSTRAINT "EditVersion_forumPostId_fkey" FOREIGN KEY ("forumPostId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
