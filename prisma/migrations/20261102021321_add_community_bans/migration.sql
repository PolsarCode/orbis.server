-- CreateTable
CREATE TABLE "CommunityBan" (
    "communityId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "bannedById" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityBan_pkey" PRIMARY KEY ("communityId","userId")
);

-- CreateIndex
CREATE INDEX "CommunityBan_userId_idx" ON "CommunityBan"("userId");

-- CreateIndex
CREATE INDEX "CommunityBan_bannedById_idx" ON "CommunityBan"("bannedById");

-- AddForeignKey
ALTER TABLE "CommunityBan" ADD CONSTRAINT "CommunityBan_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityBan" ADD CONSTRAINT "CommunityBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityBan" ADD CONSTRAINT "CommunityBan_bannedById_fkey" FOREIGN KEY ("bannedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
