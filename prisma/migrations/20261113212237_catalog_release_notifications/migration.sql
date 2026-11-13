-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'episode_aired';
ALTER TYPE "NotificationType" ADD VALUE 'game_released';
ALTER TYPE "NotificationType" ADD VALUE 'game_date';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mutedNotifications" "NotificationType"[] DEFAULT ARRAY[]::"NotificationType"[];

-- CreateTable
CREATE TABLE "LibraryNotice" (
    "id" SERIAL NOT NULL,
    "entryId" INTEGER NOT NULL,
    "kind" "NotificationType" NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LibraryNotice_entryId_kind_key_key" ON "LibraryNotice"("entryId", "kind", "key");

-- AddForeignKey
ALTER TABLE "LibraryNotice" ADD CONSTRAINT "LibraryNotice_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LibraryEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
