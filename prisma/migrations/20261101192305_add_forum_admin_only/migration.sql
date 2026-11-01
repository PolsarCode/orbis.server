-- AlterTable
ALTER TABLE "ForumCategory" ADD COLUMN     "adminOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ForumSection" ADD COLUMN     "adminOnly" BOOLEAN NOT NULL DEFAULT false;
