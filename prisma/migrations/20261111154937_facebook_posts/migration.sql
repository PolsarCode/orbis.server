-- CreateTable
CREATE TABLE "FacebookPost" (
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "subject" TEXT,
    "label" TEXT NOT NULL,
    "postId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookPost_pkey" PRIMARY KEY ("kind","period")
);

-- CreateIndex
CREATE INDEX "FacebookPost_kind_subject_idx" ON "FacebookPost"("kind", "subject");
