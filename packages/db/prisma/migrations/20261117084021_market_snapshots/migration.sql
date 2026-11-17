-- CreateTable
CREATE TABLE "market_snapshots" (
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mark" DOUBLE PRECISION,
    "last" DOUBLE PRECISION,
    "openInterest" DOUBLE PRECISION,
    "fundingRate" DOUBLE PRECISION,
    "fundingInterval" DOUBLE PRECISION,
    "nextFundingTime" TIMESTAMPTZ(3),
    "turnover24h" DOUBLE PRECISION,

    CONSTRAINT "market_snapshots_pkey" PRIMARY KEY ("exchange","symbol","ts")
);

-- CreateIndex
CREATE INDEX "market_snapshots_ts_idx" ON "market_snapshots"("ts");
