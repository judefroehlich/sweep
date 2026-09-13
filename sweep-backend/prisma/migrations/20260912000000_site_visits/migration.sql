-- Aggregate visit counts for the public site.
--
-- One row per (day, path, referrer) rather than one per visit: the table grows
-- with days and pages, not with traffic, and it holds nothing that identifies
-- anybody. No IP, no cookie, no session.
CREATE TABLE "SiteVisit" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "path" TEXT NOT NULL,
    "referrer" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SiteVisit_pkey" PRIMARY KEY ("id")
);

-- The upsert target. Recording a visit is an increment on one of these rows.
CREATE UNIQUE INDEX "SiteVisit_day_path_referrer_key" ON "SiteVisit"("day", "path", "referrer");

CREATE INDEX "SiteVisit_day_idx" ON "SiteVisit"("day");
