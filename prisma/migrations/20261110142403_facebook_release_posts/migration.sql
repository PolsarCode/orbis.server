-- CreateTable
CREATE TABLE "FacebookReleasePost" (
    "date" TEXT NOT NULL,
    "version" TEXT,
    "postId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookReleasePost_pkey" PRIMARY KEY ("date")
);
