-- AlterTable
ALTER TABLE "ForumCategory" ADD COLUMN     "sectionId" INTEGER;

-- CreateTable
CREATE TABLE "ForumSection" (
    "id" SERIAL NOT NULL,
    "communityId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForumSection_communityId_position_idx" ON "ForumSection"("communityId", "position");

-- CreateIndex
CREATE INDEX "ForumCategory_sectionId_idx" ON "ForumCategory"("sectionId");

-- AddForeignKey
ALTER TABLE "ForumSection" ADD CONSTRAINT "ForumSection_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumCategory" ADD CONSTRAINT "ForumCategory_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ForumSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
