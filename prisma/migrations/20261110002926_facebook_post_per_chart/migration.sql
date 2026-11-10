/*
  Warnings:

  - The primary key for the `FacebookChartPost` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `mediaType` to the `FacebookChartPost` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "FacebookChartPost" DROP CONSTRAINT "FacebookChartPost_pkey",
ADD COLUMN     "mediaType" "MediaType" NOT NULL,
ADD CONSTRAINT "FacebookChartPost_pkey" PRIMARY KEY ("mediaType", "week");
