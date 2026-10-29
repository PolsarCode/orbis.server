-- AlterTable
ALTER TABLE "User" ADD COLUMN     "suggestionSlots" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "suggestionSlotsAt" TIMESTAMP(3);
