-- CreateTable
CREATE TABLE "FacebookChartPost" (
    "week" TEXT NOT NULL,
    "postId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookChartPost_pkey" PRIMARY KEY ("week")
);
