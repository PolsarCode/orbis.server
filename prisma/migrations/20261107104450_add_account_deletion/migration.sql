-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_authorId_fkey";

-- AlterTable
ALTER TABLE "Comment" ALTER COLUMN "authorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ConversationMember" ADD COLUMN     "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deleteAt" TIMESTAMP(3),
ADD COLUMN     "deletionCode" TEXT,
ADD COLUMN     "deletionCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "sessionsRevokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_deleteAt_idx" ON "User"("deleteAt");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
