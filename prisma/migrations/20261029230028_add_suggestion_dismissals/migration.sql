-- CreateTable
CREATE TABLE "SuggestionDismissal" (
    "userId" INTEGER NOT NULL,
    "dismissedUserId" INTEGER NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuggestionDismissal_pkey" PRIMARY KEY ("userId","dismissedUserId")
);

-- CreateIndex
CREATE INDEX "SuggestionDismissal_dismissedUserId_idx" ON "SuggestionDismissal"("dismissedUserId");

-- AddForeignKey
ALTER TABLE "SuggestionDismissal" ADD CONSTRAINT "SuggestionDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionDismissal" ADD CONSTRAINT "SuggestionDismissal_dismissedUserId_fkey" FOREIGN KEY ("dismissedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
