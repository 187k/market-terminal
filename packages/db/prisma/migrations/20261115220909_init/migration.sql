-- CreateTable
CREATE TABLE "connection_events" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "exchange" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "connection_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_events_at_idx" ON "connection_events"("at" DESC);

-- CreateIndex
CREATE INDEX "connection_events_exchange_at_idx" ON "connection_events"("exchange", "at" DESC);
