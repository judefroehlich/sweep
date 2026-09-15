-- Paid scraping allowance, counted where the billed request is made.
CREATE TABLE "ProviderCredit" (
    "provider" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "allowance" INTEGER,
    "alertedLevel" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredit_pkey" PRIMARY KEY ("provider")
);

CREATE TABLE "ProviderCreditDay" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderCreditDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderCreditDay_provider_day_key" ON "ProviderCreditDay"("provider", "day");
