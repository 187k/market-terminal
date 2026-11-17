-- CreateTable
CREATE TABLE "signals" (
    "id" BIGSERIAL NOT NULL,
    "scanner" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "exchange" TEXT,
    "symbol" TEXT,
    "asset" TEXT NOT NULL,
    "direction" TEXT,
    "title" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "peakValue" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "updates" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "telegramState" TEXT NOT NULL,
    "telegramMessageId" INTEGER,
    "telegramDetail" TEXT,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_settings" (
    "scanner" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "settings" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scanner_settings_pkey" PRIMARY KEY ("scanner")
);

-- CreateIndex
CREATE INDEX "signals_scanner_firstSeenAt_idx" ON "signals"("scanner", "firstSeenAt" DESC);

-- CreateIndex
CREATE INDEX "signals_status_scanner_idx" ON "signals"("status", "scanner");
