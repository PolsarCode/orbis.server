-- CreateTable
CREATE TABLE "Hashtag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HashtagUsage" (
    "id" SERIAL NOT NULL,
    "hashtagId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "postId" INTEGER,
    "commentId" INTEGER,
    "forumPostId" INTEGER,
    "targetPostId" INTEGER,
    "targetActivityId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HashtagUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HashtagFollow" (
    "userId" INTEGER NOT NULL,
    "hashtagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HashtagFollow_pkey" PRIMARY KEY ("userId","hashtagId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Hashtag_name_key" ON "Hashtag"("name");

-- CreateIndex
CREATE INDEX "HashtagUsage_hashtagId_createdAt_id_idx" ON "HashtagUsage"("hashtagId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "HashtagUsage_createdAt_idx" ON "HashtagUsage"("createdAt");

-- CreateIndex
CREATE INDEX "HashtagUsage_authorId_idx" ON "HashtagUsage"("authorId");

-- CreateIndex
CREATE INDEX "HashtagUsage_targetPostId_idx" ON "HashtagUsage"("targetPostId");

-- CreateIndex
CREATE INDEX "HashtagUsage_targetActivityId_idx" ON "HashtagUsage"("targetActivityId");

-- CreateIndex
CREATE UNIQUE INDEX "HashtagUsage_postId_hashtagId_key" ON "HashtagUsage"("postId", "hashtagId");

-- CreateIndex
CREATE UNIQUE INDEX "HashtagUsage_commentId_hashtagId_key" ON "HashtagUsage"("commentId", "hashtagId");

-- CreateIndex
CREATE UNIQUE INDEX "HashtagUsage_forumPostId_hashtagId_key" ON "HashtagUsage"("forumPostId", "hashtagId");

-- CreateIndex
CREATE INDEX "HashtagFollow_userId_createdAt_idx" ON "HashtagFollow"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "HashtagFollow_hashtagId_idx" ON "HashtagFollow"("hashtagId");

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_hashtagId_fkey" FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_forumPostId_fkey" FOREIGN KEY ("forumPostId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_targetPostId_fkey" FOREIGN KEY ("targetPostId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_targetActivityId_fkey" FOREIGN KEY ("targetActivityId") REFERENCES "LibraryActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagFollow" ADD CONSTRAINT "HashtagFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HashtagFollow" ADD CONSTRAINT "HashtagFollow_hashtagId_fkey" FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "HashtagUsage" ADD CONSTRAINT "HashtagUsage_one_source_check" CHECK (
  (("postId" IS NOT NULL)::int + ("commentId" IS NOT NULL)::int + ("forumPostId" IS NOT NULL)::int) = 1
  AND ("commentId" IS NULL OR (("targetPostId" IS NOT NULL)::int + ("targetActivityId" IS NOT NULL)::int) = 1)
  AND ("commentId" IS NOT NULL OR ("targetPostId" IS NULL AND "targetActivityId" IS NULL))
);
