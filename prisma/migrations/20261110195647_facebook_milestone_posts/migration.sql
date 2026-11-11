-- CreateTable
CREATE TABLE "FacebookMilestonePost" (
    "scope" TEXT NOT NULL,
    "members" INTEGER NOT NULL,
    "communityId" INTEGER,
    "postId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookMilestonePost_pkey" PRIMARY KEY ("scope","members")
);

-- CreateIndex
CREATE INDEX "FacebookMilestonePost_communityId_idx" ON "FacebookMilestonePost"("communityId");

-- AddForeignKey
ALTER TABLE "FacebookMilestonePost" ADD CONSTRAINT "FacebookMilestonePost_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
