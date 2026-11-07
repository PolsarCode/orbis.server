-- DropForeignKey
ALTER TABLE "CommunityBan" DROP CONSTRAINT "CommunityBan_bannedById_fkey";

-- AlterTable
ALTER TABLE "CommunityBan" ALTER COLUMN "bannedById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "CommunityBan" ADD CONSTRAINT "CommunityBan_bannedById_fkey" FOREIGN KEY ("bannedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
