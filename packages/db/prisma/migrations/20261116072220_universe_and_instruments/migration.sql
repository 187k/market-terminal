-- CreateTable
CREATE TABLE "universe_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "universe_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL,
    "contractSize" DOUBLE PRECISION NOT NULL,
    "tickSize" DOUBLE PRECISION,
    "maxLeverage" DOUBLE PRECISION,
    "indexKind" TEXT NOT NULL,
    "launchTime" TIMESTAMPTZ(3),
    "url" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("exchange","symbol")
);

-- CreateIndex
CREATE INDEX "universe_snapshots_builtAt_idx" ON "universe_snapshots"("builtAt" DESC);

-- CreateIndex
CREATE INDEX "instruments_assetId_idx" ON "instruments"("assetId");
