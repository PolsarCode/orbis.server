-- AlterTable
ALTER TABLE "User" ADD COLUMN     "twoFactorCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "twoFactorEnabledAt" TIMESTAMP(3),
ADD COLUMN     "twoFactorLastStep" INTEGER,
ADD COLUMN     "twoFactorSecret" TEXT;
